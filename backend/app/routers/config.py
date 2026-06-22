"""Endpoint de estado de configuración (UX de la API key).

Le dice al frontend si la fuente de DEM activa NECESITA una API key y si el
servidor ya tiene una configurada. NUNCA devuelve la key en sí.

- Con `dem_source="s3"` (default): la fuente es el bucket público de Copernicus,
  SIN key → `requires_api_key=false` → el frontend nunca muestra el cartel.
- Con `dem_source="opentopography"` (fallback): se necesita key →
  `requires_api_key=true` → el frontend pide una si no hay ninguna usable.
"""

from fastapi import APIRouter

from app.config import settings

router = APIRouter(prefix="/api/config", tags=["configuración"])


@router.get("/status")
def config_status() -> dict:
    """Estado de la fuente de relieve para la UX de la API key.

    Devuelve `{requires_api_key: bool, has_api_key: bool}`:
    - `requires_api_key`: la fuente activa necesita key (solo OpenTopography).
    - `has_api_key`: el servidor ya tiene una key en `.env` (la key nunca se expone).
    """
    requires_api_key = settings.dem_source == "opentopography"
    return {
        "requires_api_key": requires_api_key,
        "has_api_key": bool(settings.opentopography_api_key),
    }
