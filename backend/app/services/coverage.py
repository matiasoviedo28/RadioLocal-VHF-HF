"""Motor de cobertura RF: orquesta Signal-Server sobre nuestro DEM (Fase 2).

Flujo (camino -lid, sin SDF):
  1. bbox = centro ± radio.
  2. ensure_dem(bbox)  -> garantiza el relieve (respeta el fallback offline).
  3. export_ascii_grid -> ventana del DEM como ASCII grid WGS84 (.asc).
  4. signalserverLIDAR -> corre ITM/Longley-Rice (-pm 1), genera un PPM.
  5. _ppm_to_png       -> PNG RGBA con transparencia donde no hay cobertura.

Este módulo NO depende de FastAPI: es una función pura `run_coverage(params)`
pensada para extraerse a un worker más adelante sin tocarla. El cómputo corre
SIEMPRE local (patrón del proyecto).
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.io import MemoryFile

from app.config import settings
from app.services import dem


# --------------------------------------------------------------------------- #
# Límites reales del motor en modo -lid (ver CLAUDE.md / fuente W3AXL 7f6242a):
# - La "super tile" se aloja como IPPD×IPPD (IPPD = lado mayor en px) en 3 arrays
#   (data short + mask + signal) -> memoria ≈ IPPD² × 6 bytes.
# - Guards duros del binario: ancho > 28.800 px o alto > 39.000 px -> exit(1).
# - El .asc es nativo (~1 arcseg = 1/3600° = 3600 px/grado); -res no lo achica.
# --------------------------------------------------------------------------- #
ANCHO_MAX_PX = 28800        # guard de ancho del binario (3600*8)
ALTO_MAX_PX = 39000         # guard de alto del binario
MARGEN_RAM = 0.8            # usamos hasta 80% de la RAM disponible
CELLSIZE_DEG = 1.0 / 3600.0  # resolución nativa del DEM (COP30 ~1 arcseg)
BYTES_POR_CELDA = 6          # data(2) + mask(1) + signal(1) + holgura (new_tile)


class CoverageError(Exception):
    """Fallo del motor RF (binario con error, sin salida, timeout)."""


class CoverageNotPossible(Exception):
    """No es posible calcular: excede el radio máximo, la capacidad del motor o
    la memoria disponible. Mensaje claro para el usuario (se mapea a 422)."""


class CoverageDEMMissing(Exception):
    """Faltan tiles del DEM para la huella de la cobertura (Tx ± radio).

    Lleva el bbox de la huella y la lista de tiles faltantes para que el frontend
    pueda preparar exactamente esa área (no el viewport).
    """

    def __init__(self, bbox: "dem.Bbox", missing: list[str]):
        self.bbox = bbox
        self.missing = missing
        super().__init__(
            f"Faltan {len(missing)} tile(s) para esta cobertura: {missing}. "
            "Prepará el área de la cobertura primero."
        )


@dataclass
class CoverageParams:
    """Parámetros de una corrida de cobertura VHF (con defaults razonables)."""

    lat: float
    lon: float
    txh: float = 10.0       # altura de antena Tx sobre el suelo (m)
    erp: float = 50.0       # potencia radiada efectiva (W)
    f: float = 150.0        # frecuencia (MHz) — banda VHF típica de bomberos AR
    radius_km: float = 40.0  # radio de análisis (km)
    rxh: float = 2.0        # altura de antena Rx (m)
    rt: float = -100.0      # umbral de recepción (dBm)
    res: int = 1200         # resolución de salida (px por tile)


@dataclass
class CoverageResult:
    """Resultado: PNG del overlay + bounds (centro ± radio, deterministas)."""

    png: bytes
    bbox: dem.Bbox


def _build_command(asc: Path, out_base: Path, p: CoverageParams) -> list[str]:
    """Arma el comando de signalserver (modo -lid, ITM/Longley-Rice).

    Pasamos la longitud WGS84 REAL con signo (p. ej. -71.3): el motor la convierte
    internamente a "oeste positivo", de forma consistente con el frame del .asc.
    """
    return [
        settings.signalserver_bin,
        "-lid", str(asc),
        "-lat", f"{p.lat}",
        "-lon", f"{p.lon}",
        "-txh", f"{p.txh}",
        "-f", f"{p.f}",
        "-erp", f"{p.erp}",
        "-rxh", f"{p.rxh}",
        "-rt", f"{p.rt}",
        "-dbm",          # plotear potencia recibida (dBm)
        "-m",            # unidades métricas
        "-R", f"{p.radius_km}",
        "-res", f"{p.res}",
        "-pm", "1",      # modelo de propagación 1 = ITM (Longley-Rice)
        "-o", str(out_base),
        # FUTURO (clutter): -udt <puntos> / -clt <grid MODIS>. No se usa aún.
    ]


def _ppm_to_png(ppm_path: Path) -> bytes:
    """Convierte el PPM de Signal-Server a PNG RGBA.

    El motor pinta el fondo "sin cobertura" en blanco (255,255,255); lo hacemos
    transparente (alpha=0) para superponer el overlay sobre el mapa.
    """
    with rasterio.open(ppm_path) as src:
        rgb = src.read()  # (3, alto, ancho)

    r, g, b = rgb[0], rgb[1], rgb[2]
    sin_cobertura = (r == 255) & (g == 255) & (b == 255)
    alpha = np.where(sin_cobertura, 0, 255).astype("uint8")

    height, width = r.shape
    profile = {
        "driver": "PNG",
        "dtype": "uint8",
        "count": 4,
        "height": height,
        "width": width,
    }
    with MemoryFile() as memfile:
        with memfile.open(**profile) as dst:
            dst.write(r, 1)
            dst.write(g, 2)
            dst.write(b, 3)
            dst.write(alpha, 4)
        return memfile.read()


def _mem_available_bytes() -> int | None:
    """Lee MemAvailable de /proc/meminfo (bytes). None si no se puede leer."""
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for linea in f:
                if linea.startswith("MemAvailable:"):
                    return int(linea.split()[1]) * 1024  # viene en kB
    except (OSError, ValueError):
        pass
    return None


def _precheck(p: CoverageParams, bbox: dem.Bbox) -> None:
    """Red de seguridad previa: rechaza limpio (CoverageNotPossible) si la corrida
    excede el radio máximo, los guards del binario o la memoria disponible.

    Estima el tamaño SIN leer el DEM, usando el cellsize nativo (~1 arcseg).
    """
    # 1) Tope del modelo síncrono (defensa; el frontend ya advierte/topea). El
    # mensaje es honesto: no es "imposible", es que aún no hay worker asíncrono.
    if p.radius_km > settings.coverage_max_radius_km:
        raise CoverageNotPossible(
            f"Radio {p.radius_km:g} km: por ahora el máximo es "
            f"{settings.coverage_max_radius_km:g} km. Los radios mayores llegan con "
            "el procesamiento en segundo plano (próxima versión)."
        )

    west, south, east, north = bbox
    ancho_px = round((east - west) / CELLSIZE_DEG)
    alto_px = round((north - south) / CELLSIZE_DEG)

    # 2) Guards del binario.
    if ancho_px > ANCHO_MAX_PX or alto_px > ALTO_MAX_PX:
        raise CoverageNotPossible(
            f"No es posible: excede la capacidad de cálculo del motor "
            f"({ancho_px}×{alto_px} px; máx {ANCHO_MAX_PX}×{ALTO_MAX_PX})."
        )

    # 3) Memoria estimada (IPPD = lado mayor; ≈ IPPD² × 6 bytes).
    ippd = max(ancho_px, alto_px)
    mem_est = ippd * ippd * BYTES_POR_CELDA
    disponible = _mem_available_bytes()
    if disponible is not None and mem_est > disponible * MARGEN_RAM:
        gb = 1024 ** 3
        raise CoverageNotPossible(
            f"No es posible: excede la memoria disponible "
            f"(estimado {mem_est / gb:.1f} GB, libre {disponible / gb:.1f} GB)."
        )


def run_coverage(p: CoverageParams) -> CoverageResult:
    """Ejecuta una corrida de cobertura completa y devuelve el overlay + bounds.

    El cómputo es SIEMPRE local y NO descarga relieve: asume que la zona ya fue
    preparada (Plan A, vía /api/terrain/prepare). Si faltan tiles, `export_ascii_grid`
    -> `read_mosaic` levanta DEMOfflineError y el endpoint responde 409 ("prepará la
    zona primero"). Así evitamos descargas largas dentro del request (no más 504).
    """
    bbox = dem.bbox_from_center(p.lat, p.lon, p.radius_km)

    # Red de seguridad: rechaza limpio si excede radio / capacidad / memoria.
    _precheck(p, bbox)

    # Chequeo explícito de la HUELLA (Tx ± radio): si faltan tiles, devolvemos el
    # bbox y la lista para que el frontend prepare exactamente esta área. Así
    # "preparar" y "calcular" quedan alineados (el viewport puede no cubrir la huella).
    cov = dem.coverage_for_bbox(bbox)
    if cov["missing"]:
        raise CoverageDEMMissing(bbox, cov["missing"])

    workdir = Path(tempfile.mkdtemp(prefix="cobertura_"))
    try:
        asc = workdir / "ventana.asc"
        dem.export_ascii_grid(bbox, asc)

        out_base = workdir / "cobertura"
        cmd = _build_command(asc, out_base, p)
        try:
            proc = subprocess.run(
                cmd,
                cwd=workdir,
                capture_output=True,
                text=True,
                timeout=settings.coverage_timeout_s,
            )
        except subprocess.TimeoutExpired as e:
            # No es un error del servidor: el cómputo es viable pero tardó demasiado
            # para el modelo síncrono. 422 con mensaje limpio (no 500).
            raise CoverageNotPossible(
                "El cálculo tardó demasiado; probá con un radio menor."
            ) from e

        ppm = out_base.with_suffix(".ppm")
        if proc.returncode != 0 or not ppm.exists():
            # returncode negativo (señal, p.ej. -9 SIGKILL del OOM killer) o 137:
            # casi siempre es falta de memoria pese al pre-chequeo. Mensaje limpio.
            if proc.returncode < 0 or proc.returncode == 137:
                raise CoverageNotPossible(
                    "No es posible: el cálculo agotó la memoria disponible. "
                    "Probá con un radio menor."
                )
            raise CoverageError(
                f"signalserver falló (código {proc.returncode}). "
                f"stderr: {proc.stderr[-500:]}"
            )

        png = _ppm_to_png(ppm)
        # Bounds deterministas: el mismo bbox centro ± radio del .asc.
        result = CoverageResult(png=png, bbox=bbox)
        _guardar_en_cache(p, result)
        return result
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# Cache LRU en memoria de resultados recientes
# Permite que "Guardar cobertura" reuse lo recién calculado en vez de recomputar.
# Se pierde al reiniciar el proceso (las coberturas guardadas viven en disco).
# --------------------------------------------------------------------------- #
_CACHE: "OrderedDict[str, CoverageResult]" = OrderedDict()
_CACHE_MAX = 8


def _firma(p: CoverageParams) -> str:
    """Firma estable de los params (redondea floats para evitar ruido)."""
    return (
        f"{p.lat:.5f},{p.lon:.5f},{p.txh:g},{p.erp:g},{p.f:g},"
        f"{p.radius_km:g},{p.rxh:g},{p.rt:g},{int(p.res)}"
    )


def _guardar_en_cache(p: CoverageParams, result: CoverageResult) -> None:
    _CACHE[_firma(p)] = result
    _CACHE.move_to_end(_firma(p))
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


def get_or_run(p: CoverageParams) -> CoverageResult:
    """Devuelve el resultado del cache si los params coinciden, o computa local."""
    cached = _CACHE.get(_firma(p))
    if cached is not None:
        _CACHE.move_to_end(_firma(p))
        return cached
    return run_coverage(p)


def get_cached(p: CoverageParams) -> CoverageResult | None:
    """Devuelve el resultado cacheado para esos params, o None. NUNCA recalcula.

    Lo usa la exportación a KMZ de la cobertura ACTUAL: reusa el PNG/bbox recién
    calculado (el cómputo siempre cachea su resultado en `_guardar_en_cache`). Si
    el usuario exporta justo después de calcular, está garantizado el hit; si fue
    desalojado del LRU (raro), el endpoint pide volver a calcular.
    """
    cached = _CACHE.get(_firma(p))
    if cached is not None:
        _CACHE.move_to_end(_firma(p))
    return cached
