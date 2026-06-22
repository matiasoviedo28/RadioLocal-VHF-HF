"""Endpoint de regiones disponibles para descarga (provincias argentinas).

Es la única fuente de verdad del desplegable del frontend: lee el diccionario de
`app.services.pack`, así no se duplican nombres ni bboxes.
"""

from fastapi import APIRouter

from app.services import pack

router = APIRouter(prefix="/api", tags=["regiones"])


@router.get("/regions")
def regions() -> list[dict]:
    """Provincias disponibles: `[{clave, nombre, bbox:[sur, oeste, norte, este]}]`."""
    return pack.listar_regiones()
