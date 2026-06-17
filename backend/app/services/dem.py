"""Proveedor de relieve (DEM) con caché por tiles, patrón online/offline.

Esquema de caché:
- Tiles de 1°×1° en `data/dem/`, nombrados por su esquina SW (convención tipo
  Copernicus): p. ej. `S35W065.tif` cubre lat [-35, -34] × lon [-65, -64].
- Cada tile se guarda como COG (Cloud-Optimized GeoTIFF), validado con rio-cogeo.
- Un manifest JSON (`data/dem/manifest.json`) lista los tiles cacheados.

Patrón "datos híbridos":
- Si hay internet, los tiles faltantes se bajan de OpenTopography (Copernicus GLO-30).
- Si NO hay internet, se levanta un error claro: la zona no está preparada para offline.

El CÓMPUTO (hillshade, y a futuro la propagación RF) corre SIEMPRE local sobre
los tiles ya cacheados.
"""

from __future__ import annotations

import json
import math
import socket
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import httpx
import numpy as np
import rasterio
import rasterio.shutil
from rasterio.io import MemoryFile
from rasterio.merge import merge
from rasterio.transform import array_bounds
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles

from app.config import settings

# Tipo de bbox usado en todo el módulo: (oeste, sur, este, norte) en EPSG:4326.
Bbox = tuple[float, float, float, float]


# --------------------------------------------------------------------------- #
# Errores de dominio (base del manejo claro para el fallback offline)
# --------------------------------------------------------------------------- #
class DEMError(Exception):
    """Error genérico del proveedor de relieve."""


class DEMConfigError(DEMError):
    """Falta configuración necesaria (p. ej. la API key)."""


class DEMOfflineError(DEMError):
    """Faltan tiles y no hay conectividad: zona no preparada para offline."""


class DEMDownloadError(DEMError):
    """Fallo al descargar un tile de OpenTopography (timeout, HTTP, etc.)."""


# --------------------------------------------------------------------------- #
# Esquema de tiles (1°×1°, nombrados por esquina SW)
# --------------------------------------------------------------------------- #
def tile_id(lat_sw: int, lon_sw: int) -> str:
    """Devuelve el id de un tile a partir de su esquina SW (enteros en grados).

    Ejemplo: tile_id(-35, -65) -> "S35W065".
    """
    ns = "S" if lat_sw < 0 else "N"
    ew = "W" if lon_sw < 0 else "E"
    return f"{ns}{abs(lat_sw):02d}{ew}{abs(lon_sw):03d}"


def parse_tile_id(tid: str) -> tuple[int, int]:
    """Inverso de tile_id: devuelve (lat_sw, lon_sw) en grados enteros."""
    lat = int(tid[1:3]) * (-1 if tid[0] == "S" else 1)
    lon = int(tid[4:7]) * (-1 if tid[3] == "W" else 1)
    return lat, lon


def tile_bounds(tid: str) -> Bbox:
    """Bounds (oeste, sur, este, norte) del tile de 1°×1°."""
    lat_sw, lon_sw = parse_tile_id(tid)
    return (float(lon_sw), float(lat_sw), float(lon_sw + 1), float(lat_sw + 1))


def tiles_for_bbox(bbox: Bbox) -> list[str]:
    """Lista de ids de tiles de 1°×1° que cubren (parcial o totalmente) el bbox."""
    west, south, east, north = bbox
    # Esquinas SW enteras que tocan el bbox. El norte/este se tratan como
    # exclusivos para no incluir un tile extra cuando el borde cae justo en el entero.
    lat_min = math.floor(south)
    lat_max = math.ceil(north) - 1
    lon_min = math.floor(west)
    lon_max = math.ceil(east) - 1

    tiles: list[str] = []
    for lat in range(lat_min, lat_max + 1):
        for lon in range(lon_min, lon_max + 1):
            tiles.append(tile_id(lat, lon))
    return tiles


# --------------------------------------------------------------------------- #
# Rutas y manifest
# --------------------------------------------------------------------------- #
def dem_dir() -> Path:
    """Carpeta de caché de tiles, creada si no existe."""
    d = Path(settings.dem_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def tile_path(tid: str) -> Path:
    """Ruta del archivo COG de un tile."""
    return dem_dir() / f"{tid}.tif"


def _manifest_path() -> Path:
    return dem_dir() / "manifest.json"


def load_manifest() -> dict:
    """Carga el manifest de tiles cacheados (o uno vacío si no existe)."""
    p = _manifest_path()
    if not p.exists():
        return {"demtype": settings.dem_demtype, "tiles": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # Manifest corrupto: lo reconstruimos vacío (los .tif siguen en disco).
        return {"demtype": settings.dem_demtype, "tiles": {}}


def save_manifest(manifest: dict) -> None:
    """Guarda el manifest en disco (JSON legible)."""
    _manifest_path().write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _register_tile(tid: str, resolution_m: float, valid_cog: bool) -> None:
    """Agrega/actualiza un tile en el manifest."""
    manifest = load_manifest()
    manifest["tiles"][tid] = {
        "bounds": tile_bounds(tid),
        "demtype": settings.dem_demtype,
        "resolution_m": resolution_m,
        "valid_cog": valid_cog,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
    }
    save_manifest(manifest)


def is_cached(tid: str) -> bool:
    """True si el tile existe en disco."""
    return tile_path(tid).exists()


# --------------------------------------------------------------------------- #
# Conectividad
# --------------------------------------------------------------------------- #
def is_online(timeout: float = 3.0) -> bool:
    """Chequeo rápido de conectividad contra el host de OpenTopography.

    Intencionalmente no usamos un tercero (p. ej. Google): si el host de la
    fuente de datos no responde, a efectos prácticos estamos "offline".
    """
    host = httpx.URL(settings.opentopography_url).host
    try:
        with socket.create_connection((host, 443), timeout=timeout):
            return True
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# Descarga y conversión a COG
# --------------------------------------------------------------------------- #
def _save_as_cog(src_bytes: bytes, dest: Path) -> tuple[bool, float]:
    """Convierte un GeoTIFF en memoria a COG validado en `dest`.

    Devuelve (es_cog_valido, resolucion_m_aprox).
    """
    with MemoryFile(src_bytes) as memfile:
        with memfile.open() as src:
            # Resolución aproximada en metros: el DEM viene en grados (EPSG:4326);
            # 1° de latitud ≈ 111.320 m. Sirve como metadato informativo.
            res_deg = abs(src.transform.a)
            resolution_m = round(res_deg * 111_320.0, 2)

            dst_profile = cog_profiles.get("deflate")
            tmp = dest.with_suffix(".tmp.tif")
            cog_translate(
                src,
                str(tmp),
                dst_profile,
                in_memory=True,
                quiet=True,
            )

    tmp.replace(dest)
    is_valid, _, _ = cog_validate(str(dest))
    return is_valid, resolution_m


def download_tile(tid: str) -> None:
    """Baja un tile de OpenTopography y lo guarda como COG.

    Lanza DEMConfigError si falta la API key, o DEMDownloadError ante fallos de red.
    """
    if not settings.opentopography_api_key:
        raise DEMConfigError(
            "Falta OPENTOPOGRAPHY_API_KEY. Obtené una clave gratuita en "
            "https://portal.opentopography.org y guardala en .env."
        )

    west, south, east, north = tile_bounds(tid)
    params = {
        "demtype": settings.dem_demtype,
        "south": south,
        "north": north,
        "west": west,
        "east": east,
        "outputFormat": "GTiff",
        "API_Key": settings.opentopography_api_key,
    }

    try:
        resp = httpx.get(settings.opentopography_url, params=params, timeout=60.0)
        resp.raise_for_status()
    except httpx.TimeoutException as e:
        raise DEMDownloadError(
            f"Timeout al descargar el tile {tid} de OpenTopography."
        ) from e
    except httpx.HTTPStatusError as e:
        raise DEMDownloadError(
            f"OpenTopography respondió {e.response.status_code} para el tile {tid}: "
            f"{e.response.text[:200]}"
        ) from e
    except httpx.HTTPError as e:
        raise DEMDownloadError(
            f"Error de red al descargar el tile {tid}: {e}"
        ) from e

    # Sanidad: OpenTopography puede devolver un error en texto con HTTP 200.
    content_type = resp.headers.get("content-type", "")
    if "tiff" not in content_type and "octet-stream" not in content_type:
        raise DEMDownloadError(
            f"OpenTopography no devolvió un GeoTIFF para {tid} "
            f"(content-type={content_type!r}): {resp.text[:200]}"
        )

    is_valid, resolution_m = _save_as_cog(resp.content, tile_path(tid))
    _register_tile(tid, resolution_m, is_valid)


# --------------------------------------------------------------------------- #
# Asegurar disponibilidad / cobertura
# --------------------------------------------------------------------------- #
def coverage_for_bbox(bbox: Bbox) -> dict:
    """Estado de cobertura del bbox: tiles presentes, faltantes, % y resolución."""
    tiles = tiles_for_bbox(bbox)
    cached = [t for t in tiles if is_cached(t)]
    missing = [t for t in tiles if not is_cached(t)]

    manifest = load_manifest()
    resolutions = [
        manifest["tiles"][t]["resolution_m"]
        for t in cached
        if t in manifest.get("tiles", {})
    ]
    resolution_m = resolutions[0] if resolutions else None

    coverage_pct = round(100.0 * len(cached) / len(tiles), 1) if tiles else 0.0
    return {
        "bbox": list(bbox),
        "tiles": tiles,
        "cached": cached,
        "missing": missing,
        "coverage_pct": coverage_pct,
        "resolution_m": resolution_m,
    }


def ensure_dem(bbox: Bbox) -> dict:
    """Garantiza que los tiles del bbox estén en caché.

    - Tiles faltantes con internet -> se bajan y cachean como COG.
    - Tiles faltantes sin internet -> DEMOfflineError.

    Devuelve el estado de cobertura resultante con la lista de tiles bajados.
    """
    cov = coverage_for_bbox(bbox)
    missing = cov["missing"]
    if not missing:
        return {**cov, "downloaded": []}

    if not is_online():
        raise DEMOfflineError(
            "Zona no preparada para offline: faltan los tiles "
            f"{missing}. Conectate a internet y usá 'Preparar zona'."
        )

    downloaded: list[str] = []
    for tid in missing:
        download_tile(tid)
        downloaded.append(tid)

    return {**coverage_for_bbox(bbox), "downloaded": downloaded}


# --------------------------------------------------------------------------- #
# Lectura / mosaico
# --------------------------------------------------------------------------- #
def read_mosaic(bbox: Bbox):
    """Lee y mosaiquea el área pedida sobre los tiles cacheados.

    Devuelve (array 2D float32, transform Affine, crs). Recorta al bbox.
    Lanza DEMOfflineError si faltan tiles (no intenta bajarlos: eso es ensure_dem).
    """
    cov = coverage_for_bbox(bbox)
    if cov["missing"]:
        raise DEMOfflineError(
            f"Faltan tiles para el área pedida: {cov['missing']}. "
            "Usá 'Preparar zona' primero."
        )

    datasets = [rasterio.open(tile_path(t)) for t in cov["cached"]]
    try:
        west, south, east, north = bbox
        mosaic, transform = merge(datasets, bounds=(west, south, east, north))
    finally:
        for ds in datasets:
            ds.close()

    # merge devuelve (bands, h, w); usamos la primera banda como elevación.
    elevation = mosaic[0].astype("float32")
    crs = datasets[0].crs if datasets else rasterio.crs.CRS.from_epsg(4326)
    return elevation, transform, crs


# --------------------------------------------------------------------------- #
# Puente de terreno → ASCII grid (camino -lid de Signal-Server, Fase 2)
# --------------------------------------------------------------------------- #
def bbox_from_center(lat: float, lon: float, radius_km: float) -> Bbox:
    """bbox cuadrado (en grados) alrededor de un centro, dado un radio en km.

    Aproximación: 1° de latitud ≈ 111.32 km; la longitud se corrige por cos(lat).
    """
    dlat = radius_km / 111.32
    dlon = radius_km / (111.32 * math.cos(math.radians(lat)))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def export_ascii_grid(bbox: Bbox, dest: Path) -> dict:
    """Exporta la ventana del DEM a un ASCII grid (AAIGrid) WGS84 para Signal-Server.

    El motor (modo -lid) lee el `.asc` como ENTEROS (atoi) y normaliza a 0 todo
    valor <= 0, así que NODATA y agua (Copernicus rellena con 0) quedan a nivel
    del mar. Escribimos elevación en metros como int16, con cellsize en grados.

    AAIGrid es un driver "CreateCopy-only" de GDAL: por eso construimos primero un
    dataset en memoria (GTiff) y luego copiamos al .asc con rasterio.shutil.copy.
    """
    elevation, transform, crs = read_mosaic(bbox)

    # A entero (metros). El motor ignora <=0; los huecos de borde quedan en 0.
    elev_int = np.rint(np.nan_to_num(elevation, nan=0.0)).astype("int16")
    height, width = elev_int.shape

    mem_profile = {
        "driver": "GTiff",
        "dtype": "int16",
        "count": 1,
        "height": height,
        "width": width,
        "crs": crs,
        "transform": transform,
        "nodata": -9999,
    }
    with MemoryFile() as memfile:
        with memfile.open(**mem_profile) as src:
            src.write(elev_int, 1)
            # CreateCopy a AAIGrid. FORCE_CELLSIZE asegura celda cuadrada única;
            # DECIMAL_PRECISION conserva los grados (celda ~0.000277°).
            rasterio.shutil.copy(
                src,
                str(dest),
                driver="AAIGrid",
                FORCE_CELLSIZE="YES",
                DECIMAL_PRECISION=9,
            )

    west, south, east, north = array_bounds(height, width, transform)
    return {
        "path": str(dest),
        "width": width,
        "height": height,
        "cellsize_deg": abs(transform.a),
        "bounds": [west, south, east, north],
    }


# --------------------------------------------------------------------------- #
# Hillshade (sombreado del relieve) para verificación visual
# --------------------------------------------------------------------------- #
def _hillshade(elevation: np.ndarray, res_m: float, azimuth: float, altitude: float) -> np.ndarray:
    """Calcula hillshade (0-255) a partir de la elevación.

    Algoritmo estándar (Horn) con azimut/altitud del sol en grados.
    """
    az = math.radians(360.0 - azimuth + 90.0)
    alt = math.radians(altitude)

    # Gradiente; el espaciado de celda en metros evita exagerar la pendiente.
    dy, dx = np.gradient(elevation, res_m)
    slope = np.pi / 2.0 - np.arctan(np.sqrt(dx * dx + dy * dy))
    aspect = np.arctan2(-dx, dy)

    shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(
        az - aspect
    )
    shaded = np.clip(shaded, 0.0, 1.0)
    return (shaded * 255.0).astype("uint8")


def hillshade_png(bbox: Bbox, azimuth: float = 315.0, altitude: float = 45.0) -> tuple[bytes, Bbox]:
    """Genera un PNG (escala de grises) del hillshade del área + sus bounds.

    Los bounds devueltos son el bbox pedido (lo que el frontend usa para ubicar
    el overlay en el mapa).
    """
    elevation, transform, _ = read_mosaic(bbox)

    # Resolución de celda en metros (aprox.) para escalar la pendiente.
    res_m = abs(transform.a) * 111_320.0
    shaded = _hillshade(elevation, res_m, azimuth, altitude)

    # Escribimos un PNG georreferenciado mínimo en memoria.
    height, width = shaded.shape
    profile = {
        "driver": "PNG",
        "dtype": "uint8",
        "count": 1,
        "height": height,
        "width": width,
    }
    with MemoryFile() as memfile:
        with memfile.open(**profile) as dst:
            dst.write(shaded, 1)
        png_bytes = memfile.read()

    return png_bytes, bbox
