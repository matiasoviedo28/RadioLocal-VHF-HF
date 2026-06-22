"""Endpoints de relieve / terreno (Fase 1).

Exponen el estado de cobertura, la preparación (descarga + caché) de zonas y un
hillshade para verificación visual en el mapa.
"""

from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import settings
from app.services import dem, pack

router = APIRouter(prefix="/api/terrain", tags=["terreno"])


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def _parse_bbox(bbox: str) -> dem.Bbox:
    """Parsea 'oeste,sur,este,norte' a una tupla de floats, con validación."""
    partes = bbox.split(",")
    if len(partes) != 4:
        raise HTTPException(
            status_code=400,
            detail="bbox debe tener el formato 'oeste,sur,este,norte'.",
        )
    try:
        west, south, east, north = (float(p) for p in partes)
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox: valores no numéricos.")

    if west >= east or south >= north:
        raise HTTPException(
            status_code=400,
            detail="bbox inválido: se requiere oeste<este y sur<norte.",
        )
    return (west, south, east, north)


# --------------------------------------------------------------------------- #
# Modelos
# --------------------------------------------------------------------------- #
class PrepareRequest(BaseModel):
    """Cuerpo de POST /prepare: bbox como [oeste, sur, este, norte]."""

    bbox: list[float] = Field(..., min_length=4, max_length=4)


class DownloadRequest(BaseModel):
    """Cuerpo de POST /download: una provincia O un bbox [sur, oeste, norte, este].

    OJO con el orden del bbox: la API usa [sur, oeste, norte, este] (igual que el
    desplegable de /api/regions y el --bbox del CLI). Internamente se convierte a
    (oeste, sur, este, norte) en pack.resolver_bbox.
    """

    provincia: str | None = None
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.get("/status")
def status(bbox: str = Query(..., description="oeste,sur,este,norte")) -> dict:
    """Estado de cobertura del bbox: tiles cacheados, faltantes, % y resolución."""
    b = _parse_bbox(bbox)
    return dem.coverage_for_bbox(b)


@router.post("/prepare")
def prepare(
    req: PrepareRequest,
    x_opentopography_key: str | None = Header(default=None),
) -> dict:
    """Baja y cachea los tiles faltantes del bbox (semilla de 'preparar zona offline').

    Con la fuente por defecto (`dem_source="s3"`) NO se necesita ni se lee API key:
    el relieve viene del bucket público de Copernicus. El header
    `X-OpenTopography-Key` solo se usa en el fallback OpenTopography (precedencia
    header > `.env`). Los errores se devuelven ESTRUCTURADOS con un `code`; los de
    key (`no_api_key`/`invalid_api_key`) solo pueden aparecer en modo OpenTopography.
    """
    b = tuple(req.bbox)  # type: ignore[assignment]

    # Tope de seguridad para no abusar de la API gratuita.
    n_tiles = len(dem.tiles_for_bbox(b))
    if n_tiles > settings.dem_max_tiles_per_request:
        raise HTTPException(
            status_code=413,
            detail=(
                f"El área pedida requiere {n_tiles} tiles, máximo "
                f"{settings.dem_max_tiles_per_request}. Achicá la zona."
            ),
        )

    # La key solo aplica al fallback OpenTopography; en modo s3 se ignora el header.
    api_key = x_opentopography_key if settings.dem_source == "opentopography" else None

    try:
        return dem.ensure_dem(b, api_key=api_key)
    except dem.DEMConfigError as e:
        # No hay key ni por header ni en .env: el frontend ofrece cargar una.
        raise HTTPException(
            status_code=503, detail={"code": "no_api_key", "message": str(e)}
        )
    except dem.DEMInvalidKeyError as e:
        # OpenTopography rechazó la key: el frontend pide revisarla.
        raise HTTPException(
            status_code=401, detail={"code": "invalid_api_key", "message": str(e)}
        )
    except dem.DEMOfflineError as e:
        raise HTTPException(
            status_code=409, detail={"code": "offline", "message": str(e)}
        )
    except dem.DEMDownloadError as e:
        raise HTTPException(
            status_code=502, detail={"code": "download_error", "message": str(e)}
        )


@router.get("/hillshade")
def hillshade(bbox: str = Query(..., description="oeste,sur,este,norte")) -> Response:
    """Devuelve un PNG de hillshade del área (para overlay de verificación visual)."""
    b = _parse_bbox(bbox)
    try:
        png, bounds = dem.hillshade_png(b)
    except dem.DEMOfflineError as e:
        # 409: zona no preparada. El frontend ofrece 'Preparar zona'.
        raise HTTPException(status_code=409, detail=str(e))
    except dem.DEMError as e:
        raise HTTPException(status_code=500, detail=str(e))

    west, south, east, north = bounds
    return Response(
        content=png,
        media_type="image/png",
        headers={
            # Bounds del overlay para que el frontend lo ubique en el mapa.
            "X-Bbox": f"{west},{south},{east},{north}",
        },
    )


# --------------------------------------------------------------------------- #
# Descarga masiva por región (segundo plano + poll de estado)
# --------------------------------------------------------------------------- #
@router.post("/download")
def download(req: DownloadRequest) -> dict:
    """Dispara la descarga de una región EN SEGUNDO PLANO y responde al toque.

    Acepta `{provincia}` o `{bbox:[sur, oeste, norte, este]}`. Una sola descarga a
    la vez: si ya hay una corriendo devuelve 409. La descarga es reanudable (saltea
    lo ya cacheado), así que reintentar es barato.
    """
    try:
        b = pack.resolver_bbox(provincia=req.provincia, bbox=req.bbox)
    except pack.PackError as e:
        raise HTTPException(status_code=400, detail={"code": "bad_region", "message": str(e)})

    try:
        estado = pack.iniciar_descarga_async(b)
    except pack.PackBusy as e:
        raise HTTPException(status_code=409, detail={"code": "busy", "message": str(e)})

    return {"started": True, "total": estado["total"], "bbox": list(b)}


@router.get("/download/status")
def download_status() -> dict:
    """Estado de la descarga en curso (lo poolea el frontend para la barra)."""
    return pack.read_status()


@router.get("/cache")
def cache() -> dict:
    """Tiles cacheados (para el overlay 'zonas disponibles offline') + resumen.

    Cada tile trae su bbox en orden [oeste, sur, este, norte] (W, S, E, N), que es
    lo que el frontend usa para dibujar el cuadrado en el mapa.
    """
    manifest = dem.load_manifest()
    tiles = []
    for tid, meta in manifest.get("tiles", {}).items():
        # Recalculamos los bounds desde el id (robusto si el manifest fuera viejo).
        west, south, east, north = dem.tile_bounds(tid)
        tiles.append(
            {
                "tile_id": tid,
                "bbox": [west, south, east, north],
                "ocean": bool(meta.get("ocean", False)),
            }
        )

    # Tamaño en disco: suma de los .tif de la caché.
    tam_bytes = 0
    for f in Path(dem.dem_dir()).glob("*.tif"):
        try:
            tam_bytes += f.stat().st_size
        except OSError:
            pass

    return {
        "tiles": tiles,
        "resumen": {
            "tiles": len(tiles),
            "tamano_total_mb": round(tam_bytes / (1024 * 1024), 1),
        },
    }
