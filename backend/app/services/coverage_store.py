"""Persistencia de coberturas guardadas (respaldo en disco, sin PostGIS).

Estructura en disco:
    data/coverages/
    ├── index.json          # lista de metadatos (para listar rápido)
    └── <id>/
        ├── overlay.png      # PNG de la cobertura
        └── meta.json        # metadatos completos de esa cobertura

Cada cobertura se computa (o se reusa del cache) con services.coverage y se
persiste. El motor RF no se toca: acá solo guardamos/listамos/borramos.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from app.services import coverage


def _dir() -> Path:
    """Carpeta raíz de coberturas, creada si no existe."""
    d = Path(settings.coverages_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _index_path() -> Path:
    return _dir() / "index.json"


def _load_index() -> list[dict]:
    p = _index_path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save_index(items: list[dict]) -> None:
    _index_path().write_text(
        json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def overlay_path(cid: str) -> Path:
    """Ruta del PNG de una cobertura."""
    return _dir() / cid / "overlay.png"


def existe(cid: str) -> bool:
    return (_dir() / cid / "meta.json").exists()


def listar() -> list[dict]:
    """Lista los metadatos de las coberturas guardadas (más nuevas primero)."""
    items = _load_index()
    # Agregamos la URL del overlay para comodidad del frontend.
    for it in items:
        it["overlay_url"] = f"/api/coverages/{it['id']}/overlay"
    return items


def guardar(nombre: str, params: coverage.CoverageParams) -> dict:
    """Computa (o reusa del cache) la cobertura y la persiste. Devuelve su metadata.

    Propaga los errores de dominio de coverage/dem (DEM faltante, etc.).
    """
    result = coverage.get_or_run(params)

    cid = uuid.uuid4().hex[:8]
    carpeta = _dir() / cid
    carpeta.mkdir(parents=True, exist_ok=True)

    # Guardamos el PNG del overlay.
    overlay_path(cid).write_bytes(result.png)

    meta = {
        "id": cid,
        "nombre": nombre,
        "params": {
            "lat": params.lat,
            "lon": params.lon,
            "txh": params.txh,
            "erp": params.erp,
            "f": params.f,
            "radius": params.radius_km,
            "rxh": params.rxh,
            "rt": params.rt,
            "res": params.res,
        },
        "bbox": list(result.bbox),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (carpeta / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Actualizamos el índice (más nuevas primero).
    items = _load_index()
    items.insert(0, meta)
    _save_index(items)

    return meta


def borrar(cid: str) -> bool:
    """Borra una cobertura (archivos + índice). Devuelve True si existía."""
    items = _load_index()
    nuevos = [it for it in items if it["id"] != cid]
    encontrada = len(nuevos) != len(items)

    carpeta = _dir() / cid
    if carpeta.exists():
        for f in carpeta.iterdir():
            f.unlink()
        carpeta.rmdir()
        encontrada = True

    if encontrada:
        _save_index(nuevos)
    return encontrada
