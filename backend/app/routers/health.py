"""Endpoint de salud (health check).

Lo usa el healthcheck de Docker Compose para saber si el servicio está vivo.
"""

from fastapi import APIRouter

router = APIRouter(tags=["sistema"])


@router.get("/health")
def health() -> dict[str, str]:
    """Devuelve el estado del servicio."""
    return {"status": "ok"}
