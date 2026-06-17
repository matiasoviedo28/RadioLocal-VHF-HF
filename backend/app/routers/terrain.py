"""Endpoints de relieve / terreno (Fase 1).

Exponen el estado de cobertura, la preparación (descarga + caché) de zonas y un
hillshade para verificación visual en el mapa.
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import settings
from app.services import dem

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


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.get("/status")
def status(bbox: str = Query(..., description="oeste,sur,este,norte")) -> dict:
    """Estado de cobertura del bbox: tiles cacheados, faltantes, % y resolución."""
    b = _parse_bbox(bbox)
    return dem.coverage_for_bbox(b)


@router.post("/prepare")
def prepare(req: PrepareRequest) -> dict:
    """Baja y cachea los tiles faltantes del bbox (semilla de 'preparar zona offline')."""
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

    try:
        return dem.ensure_dem(b)
    except dem.DEMConfigError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except dem.DEMOfflineError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except dem.DEMDownloadError as e:
        raise HTTPException(status_code=502, detail=str(e))


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
