"""Motor de búsqueda del mejor punto para una repetidora VHF ("Mejor ubicación").

Problema inverso al de `coverage.py`: en vez de "dado este Tx, qué cobertura da",
acá el usuario dibuja un perímetro (la zona que quiere cubrir) y el sistema busca
qué coordenadas la cubren mejor. Fundamental en terreno montañoso: el mejor punto
casi siempre es un cerro con buena visual, no el centroide geométrico del área.

Dos etapas (mismo espíritu que HF con SSN: barato primero, preciso después):

  1. Barrido rápido — grilla de candidatos dentro del polígono MÁS un anillo de
     buffer alrededor (en terreno montañoso el mejor sitio suele ser un cerro
     fuera del valle que se quiere cubrir, no adentro). Cada candidato se puntúa
     por line-of-sight geométrico (con curvatura terrestre, k=4/3) contra una
     muestra de puntos dentro del polígono. Es una heurística: rápida, no modela
     difracción ni Fresnel.
  2. Refinamiento — a los mejores candidatos de la etapa 1 se les corre el motor
     real (Signal-Server/ITM vía `coverage.run_coverage`) y se elige el que cubre
     más % del polígono según el resultado real (no la heurística).

No agrega ninguna fuente de datos ni motor nuevo: reusa `dem.read_mosaic`
(elevación ya cacheada) y `coverage.run_coverage` (motor RF real). Sin
dependencias de FastAPI (función pura), mismo patrón que `coverage.py`/`dem.py`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from rasterio.io import MemoryFile
from shapely.geometry import Point, Polygon

from app.config import settings
from app.services import coverage, dem

# --------------------------------------------------------------------------- #
# Constantes del algoritmo
# --------------------------------------------------------------------------- #
KM_POR_GRADO_LAT = 111.32
# Radio terrestre "efectivo" con k=4/3 (refracción estándar): el criterio usual
# para line-of-sight de radio, no el radio geométrico real.
R_EFECTIVO_KM = 6371.0 * (4.0 / 3.0)

DIAGONAL_MIN_KM = 0.5    # por debajo: el perímetro es un punto, no un área
DIAGONAL_MAX_KM = 60.0   # por arriba: no entra holgado en el radio máx. del motor ITM

CANDIDATOS_POR_LADO = 20   # grilla de candidatos (bruta, se filtra por polígono+buffer)
CANDIDATOS_MAX = 500       # tope real evaluado (rapidez del barrido)
OBJETIVOS_POR_LADO = 8     # grilla de puntos-muestra DENTRO del polígono
OBJETIVOS_MAX = 60
MUESTRAS_LOS = 40          # muestras por línea candidato→objetivo (heurística, no ITM)
TOP_K_REFINAR = 3          # candidatos que pasan a la corrida real (ITM)

RADIO_REFINAR_MIN_KM = 3.0
RES_REFINAR = 600  # resolución más baja que el default VHF: 3 corridas, no 1


class BestSiteError(Exception):
    """Error de dominio genérico de la búsqueda de mejor ubicación."""


class BestSitePolygonInvalido(BestSiteError):
    """Polígono degenerado (pocos puntos, área nula) o fuera del rango soportado."""


class BestSiteDEMMissing(BestSiteError):
    """Faltan tiles del DEM para el área de búsqueda (polígono + buffer).

    Mismo contrato que `coverage.CoverageDEMMissing`: lleva el bbox exacto para
    que el frontend pueda preparar esa zona (no el viewport).
    """

    def __init__(self, bbox: "dem.Bbox", missing: list[str]):
        self.bbox = bbox
        self.missing = missing
        super().__init__(
            f"Faltan {len(missing)} tile(s) para esta zona: {missing}. "
            "Prepará el área primero."
        )


@dataclass
class BestSiteParams:
    """Parámetros del transmisor a ubicar (mismos campos que la cobertura VHF)."""

    txh: float = 10.0
    erp: float = 50.0
    f: float = 150.0
    rxh: float = 2.0
    rt: float = -100.0


@dataclass
class Candidato:
    lat: float
    lon: float
    score_los: float                  # etapa 1: fracción de objetivos con LOS despejado
    score_real: float | None = None  # etapa 2: % real de objetivos cubiertos (ITM)


@dataclass
class BestSiteResult:
    lat: float
    lon: float
    score_pct: float             # % real (ITM) de puntos del polígono cubiertos
    png: bytes                    # overlay de cobertura del punto elegido
    bbox: "dem.Bbox"
    candidatos_evaluados: int


# --------------------------------------------------------------------------- #
# Geometría auxiliar (misma aproximación que dem.bbox_from_center: 1° lat ≈
# 111.32 km, 1° lon se corrige por cos(lat))
# --------------------------------------------------------------------------- #
def _km_por_grado_lon(lat: float) -> float:
    return KM_POR_GRADO_LAT * math.cos(math.radians(lat))


def _diagonal_km(bbox: "dem.Bbox") -> float:
    west, south, east, north = bbox
    lat_medio = (south + north) / 2.0
    dx_km = (east - west) * _km_por_grado_lon(lat_medio)
    dy_km = (north - south) * KM_POR_GRADO_LAT
    return math.hypot(dx_km, dy_km)


def _expandir_bbox(bbox: "dem.Bbox", buffer_km: float) -> "dem.Bbox":
    west, south, east, north = bbox
    lat_medio = (south + north) / 2.0
    dlat = buffer_km / KM_POR_GRADO_LAT
    dlon = buffer_km / _km_por_grado_lon(lat_medio)
    return (west - dlon, south - dlat, east + dlon, north + dlat)


def _grilla(bbox: "dem.Bbox", por_lado: int) -> tuple[np.ndarray, np.ndarray]:
    """Grilla regular de (lat, lon) sobre un bbox. Devuelve arrays 1D paralelos."""
    west, south, east, north = bbox
    lons = np.linspace(west, east, por_lado)
    lats = np.linspace(south, north, por_lado)
    glon, glat = np.meshgrid(lons, lats)
    return glat.ravel(), glon.ravel()


def _submuestrear(puntos: list[tuple[float, float]], tope: int) -> list[tuple[float, float]]:
    if len(puntos) <= tope:
        return puntos
    idx = np.linspace(0, len(puntos) - 1, tope).astype(int)
    return [puntos[i] for i in idx]


def _puntos_objetivo(poly: Polygon) -> list[tuple[float, float]]:
    """Grilla de puntos DENTRO del polígono: muestra representativa del área a cubrir."""
    lats, lons = _grilla(poly.bounds, OBJETIVOS_POR_LADO)
    puntos = [(float(lat), float(lon)) for lat, lon in zip(lats, lons) if poly.contains(Point(lon, lat))]
    if not puntos:
        # Polígono muy angosto: la grilla no cayó adentro. El centroide sirve de objetivo único.
        c = poly.centroid
        puntos = [(c.y, c.x)]
    return _submuestrear(puntos, OBJETIVOS_MAX)


def _puntos_candidatos(
    bbox_busqueda: "dem.Bbox", poly: Polygon, buffer_km: float
) -> list[tuple[float, float]]:
    """Grilla de candidatos dentro del polígono + un anillo de buffer alrededor.

    No restringimos al polígono estricto: en terreno montañoso el mejor sitio
    para una repetidora suele ser un cerro fuera del área a cubrir.
    """
    poly_con_buffer = poly.buffer(buffer_km / KM_POR_GRADO_LAT)
    lats, lons = _grilla(bbox_busqueda, CANDIDATOS_POR_LADO)
    puntos = [
        (float(lat), float(lon))
        for lat, lon in zip(lats, lons)
        if poly_con_buffer.contains(Point(lon, lat))
    ]
    if not puntos:
        c = poly.centroid
        puntos = [(c.y, c.x)]
    return _submuestrear(puntos, CANDIDATOS_MAX)


# --------------------------------------------------------------------------- #
# Lectura de elevación (vectorizada, sobre el mosaic ya cargado en memoria)
# --------------------------------------------------------------------------- #
def _elevacion_en(elev: np.ndarray, transform, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Elevación (m) en los puntos dados, por vecino más cercano.

    Asume grilla NO rotada (b=d=0 en el Affine), cierto para los tiles Copernicus
    (ver dem.py: la misma asunción la hace `_hillshade` con `transform.a`).
    """
    col = (lon - transform.c) / transform.a
    row = (lat - transform.f) / transform.e
    row = np.clip(np.rint(row).astype(int), 0, elev.shape[0] - 1)
    col = np.clip(np.rint(col).astype(int), 0, elev.shape[1] - 1)
    return elev[row, col]


def _score_los(
    elev: np.ndarray,
    transform,
    cand_lat: float,
    cand_lon: float,
    txh: float,
    objetivos: list[tuple[float, float]],
    rxh: float,
) -> float:
    """Fracción de `objetivos` con line-of-sight geométrico despejado desde el candidato.

    Por cada objetivo, muestrea la línea candidato→objetivo y compara la altura
    del terreno contra la línea recta candidato-objetivo MENOS la caída por
    curvatura terrestre (k=4/3). Es una heurística de ranking: no modela
    difracción (eso lo hace la etapa 2, con el motor ITM real).
    """
    if not objetivos:
        return 0.0

    t_lats = np.array([o[0] for o in objetivos])
    t_lons = np.array([o[1] for o in objetivos])

    c_elev = float(_elevacion_en(elev, transform, np.array([cand_lat]), np.array([cand_lon]))[0])
    t_elev = _elevacion_en(elev, transform, t_lats, t_lons)

    c_h = c_elev + txh
    t_h = t_elev + rxh

    lat_medio = (cand_lat + t_lats) / 2.0
    dx_km = (t_lons - cand_lon) * KM_POR_GRADO_LAT * np.cos(np.radians(lat_medio))
    dy_km = (t_lats - cand_lat) * KM_POR_GRADO_LAT
    dist_km = np.hypot(dx_km, dy_km)

    fracciones = np.linspace(0.0, 1.0, MUESTRAS_LOS)[1:-1]  # sin extremos (candidato/objetivo)
    if fracciones.size == 0:
        return 1.0

    frac_grid = fracciones[np.newaxis, :]                       # (1, n_muestras)
    lat_s = cand_lat + (t_lats[:, np.newaxis] - cand_lat) * frac_grid  # (n_obj, n_muestras)
    lon_s = cand_lon + (t_lons[:, np.newaxis] - cand_lon) * frac_grid
    ground_s = _elevacion_en(elev, transform, lat_s.ravel(), lon_s.ravel()).reshape(lat_s.shape)

    d1 = dist_km[:, np.newaxis] * frac_grid
    d2 = dist_km[:, np.newaxis] * (1.0 - frac_grid)
    caida_curvatura_m = (d1 * d2) / (2.0 * R_EFECTIVO_KM) * 1000.0

    linea_h = c_h + (t_h[:, np.newaxis] - c_h) * frac_grid
    los_h = linea_h - caida_curvatura_m

    # Margen cerca de los extremos: a menos de ~1.5 píxeles del candidato o del
    # objetivo, la muestra cae dentro de la propia huella del punto (su terraza
    # local), no de un obstáculo real entre medio. Sin este margen, un candidato
    # parado en una meseta chata puede "auto-taparse" por discretización (el
    # primer paso de la línea lee su propio nivel de terreno como bloqueo).
    margen_km = abs(transform.a) * KM_POR_GRADO_LAT * 1.5
    cerca_de_un_extremo = (d1 < margen_km) | (d2 < margen_km)

    bloqueado = np.any((ground_s > los_h) & ~cerca_de_un_extremo, axis=1)
    return float(np.mean(~bloqueado))


# --------------------------------------------------------------------------- #
# Refinamiento con el motor real (ITM) + medición de cobertura real
# --------------------------------------------------------------------------- #
def _radio_para_cubrir(cand_lat: float, cand_lon: float, objetivos: list[tuple[float, float]]) -> float:
    """Radio (km) mínimo para que el bbox CUADRADO centrado en el candidato
    (mismo criterio que `dem.bbox_from_center`) contenga a todos los objetivos.

    Distancia Chebyshev (no Euclídea): el bbox es un cuadrado, no un círculo.
    """
    max_lado = 0.0
    for lat, lon in objetivos:
        dx_km = abs(lon - cand_lon) * _km_por_grado_lon(cand_lat)
        dy_km = abs(lat - cand_lat) * KM_POR_GRADO_LAT
        max_lado = max(max_lado, dx_km, dy_km)
    radio = max_lado * 1.15 + 2.0  # margen para el borde del bbox + holgura
    return min(max(radio, RADIO_REFINAR_MIN_KM), settings.coverage_max_radius_km)


def _pct_cubierto(png: bytes, bbox: "dem.Bbox", objetivos: list[tuple[float, float]]) -> float:
    """% de `objetivos` que caen en zona con señal del overlay (alpha > 0).

    Mismo criterio que pinta el overlay en el frontend: `coverage._ppm_to_png`
    deja alpha=0 donde no hay cobertura.
    """
    if not objetivos:
        return 0.0
    with MemoryFile(png) as memfile:
        with memfile.open() as src:
            alpha = src.read(4)
    height, width = alpha.shape
    west, south, east, north = bbox
    ancho_grados = east - west
    alto_grados = north - south

    cubiertos = 0
    for lat, lon in objetivos:
        col = int((lon - west) / ancho_grados * width) if ancho_grados else 0
        row = int((north - lat) / alto_grados * height) if alto_grados else 0
        col = min(max(col, 0), width - 1)
        row = min(max(row, 0), height - 1)
        if alpha[row, col] > 0:
            cubiertos += 1
    return round(100.0 * cubiertos / len(objetivos), 1)


# --------------------------------------------------------------------------- #
# Punto de entrada
# --------------------------------------------------------------------------- #
def find_best_site(poligono: list[tuple[float, float]], p: BestSiteParams) -> BestSiteResult:
    """Busca el mejor punto para una repetidora que cubra `poligono` ((lat, lon) c/u)."""
    if len(poligono) < 3:
        raise BestSitePolygonInvalido("El perímetro necesita al menos 3 puntos.")

    poly = Polygon([(lon, lat) for lat, lon in poligono])
    if not poly.is_valid or poly.area == 0:
        poly = poly.buffer(0)  # intenta arreglar auto-intersecciones simples
    if poly.is_empty or not poly.is_valid or poly.area == 0:
        raise BestSitePolygonInvalido(
            "El perímetro no forma un área válida (¿puntos alineados o duplicados?)."
        )

    bbox_poly = poly.bounds  # (west, south, east, north)
    diagonal_km = _diagonal_km(bbox_poly)
    if diagonal_km < DIAGONAL_MIN_KM:
        raise BestSitePolygonInvalido(
            f"El área es muy chica ({diagonal_km:.2f} km de diagonal). Dibujá un perímetro más grande."
        )
    if diagonal_km > DIAGONAL_MAX_KM:
        raise BestSitePolygonInvalido(
            f"El área es muy grande ({diagonal_km:.0f} km de diagonal; máx {DIAGONAL_MAX_KM:.0f} km). "
            "Dibujá un perímetro más chico."
        )

    buffer_km = min(max(diagonal_km * 0.3, 1.0), 15.0)
    bbox_busqueda = _expandir_bbox(bbox_poly, buffer_km)

    cov = dem.coverage_for_bbox(bbox_busqueda)
    if cov["missing"]:
        raise BestSiteDEMMissing(bbox_busqueda, cov["missing"])

    elev, transform, _crs = dem.read_mosaic(bbox_busqueda)

    objetivos = _puntos_objetivo(poly)
    candidatos_xy = _puntos_candidatos(bbox_busqueda, poly, buffer_km)

    evaluados = [
        Candidato(lat=lat, lon=lon, score_los=_score_los(elev, transform, lat, lon, p.txh, objetivos, p.rxh))
        for lat, lon in candidatos_xy
    ]
    evaluados.sort(key=lambda c: c.score_los, reverse=True)
    top = evaluados[:TOP_K_REFINAR]

    mejor: BestSiteResult | None = None
    for cand in top:
        radio_km = _radio_para_cubrir(cand.lat, cand.lon, objetivos)
        cparams = coverage.CoverageParams(
            lat=cand.lat, lon=cand.lon, txh=p.txh, erp=p.erp, f=p.f,
            radius_km=radio_km, rxh=p.rxh, rt=p.rt, res=RES_REFINAR,
        )
        try:
            resultado = coverage.run_coverage(cparams)
        except (coverage.CoverageDEMMissing, coverage.CoverageNotPossible, coverage.CoverageError):
            # El buffer de refinamiento de ESTE candidato puede exceder lo preparado,
            # o no ser viable por otro motivo puntual: se descarta y se sigue con
            # el próximo candidato del ranking (no interrumpe toda la búsqueda).
            continue

        cand.score_real = _pct_cubierto(resultado.png, resultado.bbox, objetivos)
        if mejor is None or cand.score_real > mejor.score_pct:
            mejor = BestSiteResult(
                lat=cand.lat, lon=cand.lon, score_pct=cand.score_real,
                png=resultado.png, bbox=resultado.bbox,
                candidatos_evaluados=len(evaluados),
            )

    if mejor is None:
        raise BestSiteError(
            "No se pudo calcular la cobertura real para ningún candidato del ranking. "
            "Probá con un perímetro distinto, o preparando terreno alrededor de la zona."
        )
    return mejor
