"""Endpoint de versión.

Expone nombre, versión y entorno de la aplicación, tomados de la configuración.
"""

from fastapi import APIRouter

from app.config import settings

router = APIRouter(prefix="/api", tags=["sistema"])


@router.get("/version")
def version() -> dict[str, str]:
    """Devuelve la identidad y versión de la API."""
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "env": settings.env,
    }
