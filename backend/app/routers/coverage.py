"""Endpoint de cálculo de cobertura RF (Fase 2).

Corre síncrono en el backend (sin worker/Redis todavía). El servicio
`coverage.run_coverage` está aislado para extraerse a un worker más adelante.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.services import coverage, dem

router = APIRouter(prefix="/api", tags=["cobertura"])


class CoverageRequest(BaseModel):
    """Parámetros de la corrida. Defaults VHF para que tarde segundos."""

    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)
    txh: float = Field(10.0, gt=0, description="Altura antena Tx sobre el suelo (m)")
    erp: float = Field(50.0, gt=0, description="Potencia radiada efectiva (W)")
    f: float = Field(150.0, gt=0, description="Frecuencia (MHz)")
    radius: float = Field(40.0, gt=0, description="Radio de análisis (km)")
    rxh: float = Field(2.0, gt=0, description="Altura antena Rx (m)")
    rt: float = Field(-100.0, description="Umbral de recepción (dBm)")
    res: int = Field(1200, gt=0, description="Resolución de salida (px por tile)")


@router.post("/coverage")
def coverage_endpoint(req: CoverageRequest) -> Response:
    """Calcula la cobertura y devuelve un PNG (overlay) + header X-Bbox.

    Mismo patrón que /api/terrain/hillshade: el frontend ubica el overlay con
    los bounds del header.
    """
    params = coverage.CoverageParams(
        lat=req.lat, lon=req.lon, txh=req.txh, erp=req.erp, f=req.f,
        radius_km=req.radius, rxh=req.rxh, rt=req.rt, res=req.res,
    )

    try:
        result = coverage.run_coverage(params)
    except coverage.CoverageNotPossible as e:
        # 422: excede radio máximo / capacidad del motor / memoria disponible.
        raise HTTPException(status_code=422, detail=str(e))
    except coverage.CoverageDEMMissing as e:
        # 409 estructurado: el frontend usa `bbox` para preparar la HUELLA exacta.
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

    west, south, east, north = result.bbox
    return Response(
        content=result.png,
        media_type="image/png",
        headers={"X-Bbox": f"{west},{south},{east},{north}"},
    )
