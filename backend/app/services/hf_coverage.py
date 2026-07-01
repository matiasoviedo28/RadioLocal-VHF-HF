"""Motor de cobertura HF: orquesta ITURHFProp (ITU-R P.533) en modo Área.

Flujo (paralelo a services/coverage.py del VHF, pero para HF):
  1. Derivar la grilla (incrementos lat/lon) a partir del área pedida, acotando el
     total de puntos para que la corrida síncrona sea rápida.
  2. Armar el archivo de entrada .in a partir de una PLANTILLA validada en el spike
     HF-0 (hf-spike/inputs/area_merlo.in), variando solo los parámetros del usuario.
  3. Correr el binario: ITURHFProp <in> <out>.
  4. Parsear el .out (contrato del spike): mapear columnas dinámicamente desde la
     sección "Data Format" y leer las filas de datos (RxLat, RxLon, BCR 0-100 %).
  5. Reconstruir la grilla 2D de BCR y rasterizarla a un PNG RGBA (interpolado),
     con un bbox = extensión de los nodos, coherente con el overlay del VHF.

Este módulo NO depende de FastAPI: función pura `run_hf_coverage(params)` pensada
para testear aislada y, si hiciera falta, moverse a un worker sin tocarla. El
cómputo corre SIEMPRE local, en el contenedor del backend (mismo patrón que el VHF).
"""

from __future__ import annotations

import math
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds

from app.config import settings

# Tipo bbox del proyecto: (oeste, sur, este, norte). Igual que dem.Bbox del VHF.
Bbox = tuple[float, float, float, float]


# --------------------------------------------------------------------------- #
# Plantilla del archivo de entrada (.in)
# --------------------------------------------------------------------------- #
# Copia textual de hf-spike/inputs/area_merlo.in (que YA corre limpio). Solo se
# parametrizan los campos variables; el resto queda con los MISMOS defaults del
# spike (campos obligatorios que el parser exige aunque no apliquen a un área con
# antenas isotrópicas). Ver hf-spike/NOTES.md §2 para el detalle.
_PLANTILLA_IN = """\
// Cobertura HF de ÁREA (ITU-R P.533) - generado por el backend (HF-1).
PathName "RadioLocal HF - Area"
PathTXName "TX"
Path.L_tx.lat {tx_lat:.6f}
Path.L_tx.lng {tx_lon:.6f}
TXAntFilePath "ISOTROPIC"
TXGOS 0.0
TXBearing 0.0
PathRXName "AREA-CENTER"
Path.L_rx.lat {rx_lat:.6f}
Path.L_rx.lng {rx_lon:.6f}
RXAntFilePath "ISOTROPIC"
RXGOS 0.0
RXBearing 0.0
AntennaOrientation "TX2RX"
Path.year {year}
Path.month {month}
Path.hour {hour}
Path.SSN {ssn}
Path.frequency {freq:g}
Path.txpower 0.0
Path.BW 1000.0
Path.SNRr 10.0
Path.SNRXXp 90
Path.ManMadeNoise "{noise}"
Path.Modulation "ANALOG"
Path.SIRr 0.0
Path.A 0.0
Path.TW 0.0
Path.FW 0.0
Path.T0 0.0
Path.F0 0.0
Path.SorL "SHORTPATH"
RptFilePath "{rpt_dir}"
RptFileFormat "RPT_BCR | RPT_RXLOCATION"
SE.lat {south:.6f}
SE.lng {east:.6f}
NW.lat {north:.6f}
NW.lng {west:.6f}
latinc {latinc:g}
lnginc {lnginc:g}
DataFilePath "{data_path}"
"""

# Ruido man-made válido (categorías del motor). Se valida antes de correr.
_NOISE_VALIDO = {
    "CITY", "RESIDENTIAL", "RURAL", "QUIETRURAL", "QUIET", "NOISY",
}

# Guard de área mínima (defensa en profundidad): un bbox menor a ~1° por lado
# degenera la grilla (1 solo punto -> extensión 0 -> división por cero en el ráster,
# bug del fix anterior). El tamaño MÁXIMO no se capea acá: lo acota `range_km` (input
# validado) y el número de puntos lo acota `hf_max_points`.
_MIN_SPAN_DEG = 1.0
# Incremento mínimo de grilla (deg). ~0.1° ≈ 11 km: resolución fina razonable.
_INC_MIN = 0.1


class HFCoverageError(Exception):
    """Fallo del motor HF (binario con error, sin salida, salida no parseable)."""


class HFCoverageNotPossible(Exception):
    """No es posible calcular: área inválida/enorme o grilla que excede el tope
    síncrono. Mensaje claro para el usuario (se mapea a 422)."""


@dataclass
class HFCoverageParams:
    """Parámetros de una corrida de cobertura HF de área."""

    tx_lat: float
    tx_lon: float
    freq_mhz: float
    month: int
    hour_utc: int
    # Alcance (radio) del área a cubrir, en km, CENTRADA en el Tx. El área NO depende
    # del zoom del frontend: el backend deriva el bbox (Tx ± alcance) con _bbox_centrado.
    range_km: float = 4000.0
    ssn: int = 100
    # Año de la predicción (Path.year del .in). El router lo setea al año UTC actual
    # para que sea consistente con la búsqueda del SSN en el pronóstico de NOAA.
    year: int = 2026
    noise: str = "RURAL"
    # Incremento de grilla (deg). Si es None, se deriva del área (guard de puntos).
    increment: float | None = None


@dataclass
class HFCoverageResult:
    """Resultado: PNG del overlay (RGBA) + bounds de los nodos de la grilla, más
    metadatos de la corrida (para reporte/telemetría)."""

    png: bytes
    bbox: Bbox
    n_lat: int
    n_lon: int
    latinc: float
    lnginc: float


# --------------------------------------------------------------------------- #
# Área centrada en el Tx (independiente del zoom del frontend)
# --------------------------------------------------------------------------- #
# 1° de latitud ≈ 111 km (constante). En longitud, 1° ≈ 111·cos(lat) km: la celda
# en lon se agranda con la latitud (los meridianos convergen hacia los polos).
_KM_POR_GRADO_LAT = 111.0
# Latitud máxima válida para el bbox (evita los polos y proyecciones raras).
_LAT_CLAMP = 85.0


def _bbox_centrado(tx_lat: float, tx_lon: float, range_km: float) -> Bbox:
    """Bbox (oeste, sur, este, norte) del área CENTRADA en el Tx, con radio `range_km`.

    Conversión km->grados:
      lat: Δ° = km / 111
      lon: Δ° = km / (111 · cos(lat_tx))   (la celda en lon crece con la latitud)
    Robustez: la latitud se clampea a [-85, 85]; la longitud se clipea a [-180, 180]
    en vez de wrappear (para Argentina y estos alcances no hay cruce de antimeridiano).
    """
    dlat = range_km / _KM_POR_GRADO_LAT
    # cos(lat) acotado para no dividir por ~0 cerca de los polos.
    coslat = max(math.cos(math.radians(tx_lat)), 0.01)
    dlon = range_km / (_KM_POR_GRADO_LAT * coslat)

    south = max(tx_lat - dlat, -_LAT_CLAMP)
    north = min(tx_lat + dlat, _LAT_CLAMP)
    west = max(tx_lon - dlon, -180.0)
    east = min(tx_lon + dlon, 180.0)
    return (west, south, east, north)


# --------------------------------------------------------------------------- #
# (f) Guard de tamaño: derivar el incremento de grilla
# --------------------------------------------------------------------------- #
def _derivar_incremento(bbox: Bbox, increment: float | None) -> float:
    """Elige un incremento común (deg) tal que n_lat*n_lon <= hf_max_points.

    Si `increment` viene fijado, lo respeta (validando el tope). El área siempre
    queda acotada en cómputo porque a mayor área, mayor incremento -> menos puntos.
    """
    west, south, east, north = bbox
    span_lat = north - south
    span_lon = east - west
    if span_lat <= 0 or span_lon <= 0:
        raise HFCoverageNotPossible(
            "Área inválida: revisá las esquinas (oeste<este, sur<norte)."
        )
    # Guard anti-degenerado (defensa en profundidad): un bbox con alto/ancho ~0 o
    # menor al mínimo daría una grilla de 1 punto (rompía el ráster: bug del fix
    # anterior). Con el área centrada en el Tx y range_km >= 100 km ya no debería
    # activarse desde la API, pero se mantiene por robustez.
    # NOTA: NO hay cap de span máximo: el tamaño del área lo acota `range_km`
    # (validado en _validar contra [hf_range_min_km, hf_range_max_km]) y el número de
    # puntos lo acota `hf_max_points` (grilla más gruesa a mayor alcance).
    if span_lat < _MIN_SPAN_DEG or span_lon < _MIN_SPAN_DEG:
        raise HFCoverageNotPossible(
            "La cobertura HF es de larga distancia: elegí un alcance mayor."
        )

    def puntos(inc: float) -> int:
        return (int(span_lat / inc) + 1) * (int(span_lon / inc) + 1)

    if increment is not None:
        inc = max(increment, _INC_MIN)
        if puntos(inc) > settings.hf_max_points:
            raise HFCoverageNotPossible(
                f"La grilla pedida excede el máximo de {settings.hf_max_points} "
                "puntos para el cálculo síncrono. Usá un incremento mayor o un "
                "área menor."
            )
        return inc

    # Buscar el incremento más fino (múltiplo de _INC_MIN) que entre en el tope.
    inc = _INC_MIN
    while puntos(inc) > settings.hf_max_points:
        inc += _INC_MIN
    return inc


# --------------------------------------------------------------------------- #
# (a) Armar el archivo .in
# --------------------------------------------------------------------------- #
def _construir_in(p: HFCoverageParams, bbox: Bbox, inc: float, rpt_dir: Path) -> str:
    """Rellena la plantilla con los parámetros del usuario. El Rx placeholder es el
    centro del área (el Rx real se barre sobre la grilla)."""
    west, south, east, north = bbox
    return _PLANTILLA_IN.format(
        tx_lat=p.tx_lat,
        tx_lon=p.tx_lon,
        rx_lat=(south + north) / 2.0,
        rx_lon=(west + east) / 2.0,
        year=p.year,
        month=p.month,
        # Mapeo de hora: la UI usa 0-23 (natural); el motor usa 1-24 y segfaultea
        # con 0. UI 0 (medianoche) -> motor 24; UI 1..23 -> motor 1..23.
        hour=24 if p.hour_utc == 0 else p.hour_utc,
        ssn=p.ssn,
        freq=p.freq_mhz,
        noise=p.noise,
        west=west,
        south=south,
        east=east,
        north=north,
        latinc=inc,
        lnginc=inc,
        rpt_dir=f"{rpt_dir}/",
        data_path=settings.hf_data_path,
    )


# --------------------------------------------------------------------------- #
# (c) Parsear el .out
# --------------------------------------------------------------------------- #
_RE_COLUMN = re.compile(r"Column\s+(\d+):\s*(.+)")


def _parse_out(texto: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Extrae (rx_lat, rx_lon, bcr) del reporte .out.

    NO hardcodea posiciones: mapea índice->campo desde las líneas "Column NN: ..."
    (dependen de los RPT_* pedidos) y localiza lat/lon/BCR por nombre. Las filas de
    datos son las líneas totalmente numéricas separadas por coma.
    """
    col_map: dict[int, str] = {}
    for linea in texto.splitlines():
        m = _RE_COLUMN.search(linea)
        if m:
            col_map[int(m.group(1)) - 1] = m.group(2).strip()

    if not col_map:
        raise HFCoverageError(
            "El .out no trae sección 'Data Format' (no se pudo mapear columnas)."
        )

    def buscar(substr: str) -> int:
        for idx, nombre in col_map.items():
            if substr.lower() in nombre.lower():
                return idx
        raise HFCoverageError(f"El .out no expone la columna '{substr}'.")

    i_lat = buscar("Receiver latitude")
    i_lon = buscar("Receiver longitude")
    i_bcr = buscar("BCR")
    n_cols = len(col_map)

    lats: list[float] = []
    lons: list[float] = []
    bcrs: list[float] = []
    for linea in texto.splitlines():
        if "," not in linea:
            continue
        partes = [t.strip() for t in linea.split(",")]
        if len(partes) < n_cols:
            continue
        try:
            vals = [float(t) for t in partes]
        except ValueError:
            continue  # no es una fila de datos (encabezados, etc.)
        lats.append(vals[i_lat])
        lons.append(vals[i_lon])
        bcrs.append(vals[i_bcr])

    if not bcrs:
        raise HFCoverageError("El .out no trae filas de datos (grilla vacía).")

    return np.array(lats), np.array(lons), np.array(bcrs)


# --------------------------------------------------------------------------- #
# (d) Reconstruir la grilla 2D (norte arriba)
# --------------------------------------------------------------------------- #
def _reconstruir_grilla(
    lats: np.ndarray, lons: np.ndarray, bcrs: np.ndarray
) -> tuple[np.ndarray, Bbox]:
    """Arma la matriz 2D de BCR con filas de lat DESC (norte arriba) y cols de lon
    ASC (oeste->este). Devuelve (grid, bbox_nodos)."""
    lats_unq = np.unique(lats)          # ascendente
    lons_unq = np.unique(lons)          # ascendente
    lat_desc = lats_unq[::-1]           # norte arriba

    i_de_lat = {v: i for i, v in enumerate(lat_desc)}
    j_de_lon = {v: j for j, v in enumerate(lons_unq)}

    grid = np.full((lat_desc.size, lons_unq.size), np.nan, dtype="float32")
    for la, lo, bc in zip(lats, lons, bcrs):
        grid[i_de_lat[la], j_de_lon[lo]] = bc

    # Si algún nodo faltara (no debería), lo rellenamos con el promedio para no
    # romper la interpolación.
    if np.isnan(grid).any():
        grid[np.isnan(grid)] = np.nanmean(grid)

    bbox: Bbox = (
        float(lons_unq[0]),   # oeste
        float(lats_unq[0]),   # sur
        float(lons_unq[-1]),  # este
        float(lats_unq[-1]),  # norte
    )
    return grid, bbox


# --------------------------------------------------------------------------- #
# (e) Rasterizar a PNG RGBA
# --------------------------------------------------------------------------- #
def _tamano_raster(bbox: Bbox) -> tuple[int, int]:
    """Alto/ancho (px) del raster liso, respetando el aspect ratio y topeando el
    lado mayor a hf_raster_max_px.

    Defensivo: si alguna extensión es ~0 (bbox degenerado), NO divide por cero —
    cae a un raster cuadrado. Los guards de área ya impiden llegar acá con áreas
    degeneradas, pero esto blinda la función ante cualquier entrada.
    """
    west, south, east, north = bbox
    span_lon = east - west
    span_lat = north - south
    lado = settings.hf_raster_max_px
    if span_lon <= 0 or span_lat <= 0:
        return lado, lado
    if span_lon >= span_lat:
        w = lado
        h = max(1, round(lado * span_lat / span_lon))
    else:
        h = lado
        w = max(1, round(lado * span_lon / span_lat))
    return h, w


# Escala de color de fiabilidad de circuito (BCR, 0-100 %) en BANDAS discretas.
# La leyenda del frontend refleja EXACTAMENTE estos cortes (backend y UI consistentes).
# Cada banda: (umbral_inferior_inclusive, (R, G, B, A)).
# Alpha decreciente con la fiabilidad: la baja fiabilidad se ve semitransparente
# ("se desvanece" sobre el mapa), la alta queda sólida.
_BANDAS_BCR = [
    (90.0, (0x1A, 0x98, 0x50, 230)),  # >= 90  Fuerte   -> verde fuerte
    (75.0, (0xA6, 0xD9, 0x6A, 205)),  # 75-90  Buena    -> verde-amarillo
    (50.0, (0xFD, 0xAE, 0x61, 175)),  # 50-75  Marginal -> naranja
    (0.0,  (0xD7, 0x30, 0x27, 110)),  # < 50   Baja     -> rojo (semitransparente)
]


def _colormap_bcr(bcr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Mapea BCR (0-100 %) a RGBA por bandas discretas (ver _BANDAS_BCR).

    Se aplica sobre el raster YA interpolado (bilineal), así los bordes entre
    bandas quedan suaves (curvas de nivel) aunque el color sea discreto.
    """
    h, w = bcr.shape
    r = np.zeros((h, w), dtype="uint8")
    g = np.zeros((h, w), dtype="uint8")
    b = np.zeros((h, w), dtype="uint8")
    a = np.zeros((h, w), dtype="uint8")

    # Asignar de menor a mayor umbral: cada máscara pisa a las bandas más bajas.
    for umbral, (cr, cg, cb, ca) in sorted(_BANDAS_BCR, key=lambda x: x[0]):
        mask = bcr >= umbral
        r[mask], g[mask], b[mask], a[mask] = cr, cg, cb, ca

    return r, g, b, a


def _rasterizar(grid: np.ndarray, bbox: Bbox) -> bytes:
    """Interpola la grilla gruesa a un raster liso (bilineal, vía rasterio) y la
    convierte a PNG RGBA.

    Nota de alineación pixel<->nodo: tratamos el bbox de los NODOS como la extensión
    del raster (corners->coords, igual que el frontend consume el X-Bbox del VHF).
    Hay medio píxel de holgura entre "nodo" y "borde de píxel"; al interpolar a
    ~1024 px es sub-nodo y visualmente despreciable para este overlay provisional.
    """
    n_lat, n_lon = grid.shape
    west, south, east, north = bbox
    h, w = _tamano_raster(bbox)

    transform = from_bounds(west, south, east, north, n_lon, n_lat)
    with MemoryFile() as mf_in:
        with mf_in.open(
            driver="GTiff",
            height=n_lat,
            width=n_lon,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=transform,
        ) as ds:
            ds.write(grid, 1)
        with mf_in.open() as ds:
            fino = ds.read(1, out_shape=(h, w), resampling=Resampling.bilinear)

    r, g, b, alpha = _colormap_bcr(fino)

    profile = {
        "driver": "PNG",
        "dtype": "uint8",
        "count": 4,
        "height": h,
        "width": w,
    }
    with MemoryFile() as mf_out:
        with mf_out.open(**profile) as dst:
            dst.write(r, 1)
            dst.write(g, 2)
            dst.write(b, 3)
            dst.write(alpha, 4)
        return mf_out.read()


# --------------------------------------------------------------------------- #
# Orquestación
# --------------------------------------------------------------------------- #
def _validar(p: HFCoverageParams) -> None:
    """Validaciones de dominio previas a correr el motor."""
    if not (1 <= p.month <= 12):
        raise HFCoverageNotPossible("Mes inválido (1-12).")
    # La UI usa 0-23 (natural); _construir_in traduce a 1-24 para el motor.
    if not (0 <= p.hour_utc <= 23):
        raise HFCoverageNotPossible("Hora UTC inválida (0-23).")
    if p.freq_mhz <= 0:
        raise HFCoverageNotPossible("Frecuencia inválida (> 0 MHz).")
    if not (settings.hf_range_min_km <= p.range_km <= settings.hf_range_max_km):
        raise HFCoverageNotPossible(
            f"Alcance inválido ({p.range_km:g} km): permitido "
            f"{settings.hf_range_min_km:g}–{settings.hf_range_max_km:g} km."
        )
    if p.noise.upper() not in _NOISE_VALIDO:
        raise HFCoverageNotPossible(
            f"Ruido '{p.noise}' inválido. Opciones: {sorted(_NOISE_VALIDO)}."
        )


def run_hf_coverage(p: HFCoverageParams) -> HFCoverageResult:
    """Ejecuta una corrida de cobertura HF de área y devuelve overlay + bounds.

    El área se deriva del alcance (Tx ± range_km) e es INDEPENDIENTE del zoom del
    frontend. El guard anti-degenerado de _derivar_incremento se mantiene (defensa
    en profundidad), aunque con alcance mínimo de 100 km ya no debería activarse.
    """
    _validar(p)
    # Área centrada en el Tx (una sola fuente de verdad para la conversión km->grados).
    bbox = _bbox_centrado(p.tx_lat, p.tx_lon, p.range_km)
    inc = _derivar_incremento(bbox, p.increment)

    workdir = Path(tempfile.mkdtemp(prefix="hf_cov_"))
    try:
        in_file = workdir / "area.in"
        out_file = workdir / "area.out"
        in_file.write_text(_construir_in(p, bbox, inc, workdir), encoding="utf-8")

        cmd = [settings.hf_bin, str(in_file), str(out_file)]
        try:
            proc = subprocess.run(
                cmd,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=settings.hf_timeout_s,
            )
        except subprocess.TimeoutExpired as e:
            raise HFCoverageNotPossible(
                "El cálculo HF tardó demasiado; probá con un área o grilla menor."
            ) from e

        if proc.returncode != 0 or not out_file.exists():
            raise HFCoverageError(
                f"ITURHFProp falló (código {proc.returncode}). "
                f"stderr: {proc.stderr[-500:]}"
            )

        lats, lons, bcrs = _parse_out(out_file.read_text(encoding="utf-8"))
        grid, bbox = _reconstruir_grilla(lats, lons, bcrs)
        png = _rasterizar(grid, bbox)

        return HFCoverageResult(
            png=png,
            bbox=bbox,
            n_lat=grid.shape[0],
            n_lon=grid.shape[1],
            latinc=inc,
            lnginc=inc,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
