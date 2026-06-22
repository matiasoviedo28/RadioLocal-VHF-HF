"""Endpoints de coberturas guardadas (Fase: guardar/gestionar).

Persisten en disco (sin PostGIS) y corren síncrono. El cálculo reusa el cache de
resultados recientes (o recomputa local, rápido con el DEM ya cacheado).
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from app.services import coverage, coverage_store, dem, kmz

router = APIRouter(prefix="/api/coverages", tags=["coberturas"])


class CoverageParamsIn(BaseModel):
    """Parámetros de la cobertura a guardar (mismos que /api/coverage)."""

    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    txh: float = Field(10.0, gt=0)
    erp: float = Field(25.0, gt=0)
    f: float = Field(150.0, gt=0)
    radius: float = Field(40.0, gt=0)
    rxh: float = Field(2.0, gt=0)
    rt: float = Field(-80.0)
    res: int = Field(1200, gt=0)


class SaveCoverageRequest(BaseModel):
    """Cuerpo de POST: nombre + parámetros."""

    nombre: str = Field(..., min_length=1, max_length=80)
    params: CoverageParamsIn


def _a_params(p: CoverageParamsIn) -> coverage.CoverageParams:
    return coverage.CoverageParams(
        lat=p.lat, lon=p.lon, txh=p.txh, erp=p.erp, f=p.f,
        radius_km=p.radius, rxh=p.rxh, rt=p.rt, res=p.res,
    )


@router.post("", status_code=201)
def guardar(req: SaveCoverageRequest) -> dict:
    """Guarda una cobertura: asegura el overlay (cache o cómputo) y persiste."""
    params = _a_params(req.params)

    try:
        meta = coverage_store.guardar(req.nombre, params)
    except coverage.CoverageNotPossible as e:
        # 422: excede radio máximo / capacidad del motor / memoria disponible.
        raise HTTPException(status_code=422, detail=str(e))
    except coverage.CoverageDEMMissing as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "La zona de esta cobertura no está preparada. "
                    "Prepará el área de la cobertura primero."
                ),
                "missing": e.missing,
                "bbox": list(e.bbox),
            },
        )
    except dem.DEMConfigError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except dem.DEMOfflineError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except dem.DEMDownloadError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except coverage.CoverageError as e:
        raise HTTPException(status_code=500, detail=str(e))

    meta = {**meta, "overlay_url": f"/api/coverages/{meta['id']}/overlay"}
    return meta


@router.get("")
def listar() -> list[dict]:
    """Lista las coberturas guardadas (más nuevas primero)."""
    return coverage_store.listar()


@router.get("/{cid}/overlay")
def overlay(cid: str) -> Response:
    """Devuelve el PNG de la cobertura + header X-Bbox para ubicarla en el mapa."""
    if not coverage_store.existe(cid):
        raise HTTPException(status_code=404, detail="Cobertura no encontrada.")

    meta = next((m for m in coverage_store.listar() if m["id"] == cid), None)
    headers = {}
    if meta:
        headers["X-Bbox"] = ",".join(str(x) for x in meta["bbox"])
    return FileResponse(
        coverage_store.overlay_path(cid), media_type="image/png", headers=headers
    )


@router.get("/{cid}/export.kmz")
def export_kmz(cid: str) -> Response:
    """Exporta una cobertura guardada a un KMZ, SIN recomputar: lee el PNG + meta
    (bbox, params, nombre) ya persistidos en disco y los empaqueta."""
    if not coverage_store.existe(cid):
        raise HTTPException(status_code=404, detail="Cobertura no encontrada.")

    meta = next((m for m in coverage_store.listar() if m["id"] == cid), None)
    if meta is None:
        raise HTTPException(status_code=404, detail="Cobertura no encontrada.")

    png_bytes = coverage_store.overlay_path(cid).read_bytes()
    bbox = tuple(meta["bbox"])  # (oeste, sur, este, norte)
    nombre = meta.get("nombre") or "Cobertura"

    kmz_bytes = kmz.build_kmz(png_bytes, bbox, meta.get("params", {}), nombre)

    return Response(
        content=kmz_bytes,
        media_type="application/vnd.google-earth.kmz",
        headers={"Content-Disposition": kmz.content_disposition(nombre)},
    )


@router.delete("/{cid}", status_code=204)
def borrar(cid: str) -> Response:
    """Borra una cobertura guardada."""
    if not coverage_store.borrar(cid):
        raise HTTPException(status_code=404, detail="Cobertura no encontrada.")
    return Response(status_code=204)
