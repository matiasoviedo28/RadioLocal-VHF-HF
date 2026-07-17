"""Endpoint de "Mejor ubicación": dado un perímetro, busca el mejor Tx (Fase VHF).

Corre síncrono en el backend, igual que /api/coverage (del cual reusa el motor).
Internamente corre varias corridas del motor real (`coverage.run_coverage`)
sobre los candidatos del ranking: puede tardar más que una cobertura VHF normal.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.services import best_site, dem

router = APIRouter(prefix="/api", tags=["mejor-ubicacion"])


class PuntoLatLon(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)


class BestSiteRequest(BaseModel):
    """Perímetro (>=3 puntos) + parámetros del transmisor a ubicar."""

    poligono: list[PuntoLatLon] = Field(..., min_length=3)
    txh: float = Field(10.0, gt=0, description="Altura antena Tx sobre el suelo (m)")
    erp: float = Field(50.0, gt=0, description="Potencia radiada efectiva (W)")
    f: float = Field(150.0, gt=0, description="Frecuencia (MHz)")
    rxh: float = Field(2.0, gt=0, description="Altura antena Rx sobre el suelo (m)")
    rt: float = Field(-100.0, description="Umbral de recepción (dBm)")


@router.post("/best-site")
def best_site_endpoint(req: BestSiteRequest) -> Response:
    """Busca el mejor punto para cubrir el perímetro y devuelve su overlay (PNG).

    Igual que /api/coverage: PNG + X-Bbox. Suma X-Best-Lat/Lon/Score con las
    coordenadas elegidas y el % real (ITM) de la muestra del polígono cubierta.
    """
    poligono = [(p.lat, p.lon) for p in req.poligono]
    params = best_site.BestSiteParams(txh=req.txh, erp=req.erp, f=req.f, rxh=req.rxh, rt=req.rt)

    try:
        resultado = best_site.find_best_site(poligono, params)
    except best_site.BestSitePolygonInvalido as e:
        raise HTTPException(status_code=422, detail=str(e))
    except best_site.BestSiteDEMMissing as e:
        # 409 estructurado: mismo contrato que /api/coverage (bbox + missing), así
        # el frontend reusa el flujo de "preparar zona" ya existente.
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "La zona de esta búsqueda no está preparada. "
                    "Prepará el área primero."
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
    except best_site.BestSiteError as e:
        raise HTTPException(status_code=500, detail=str(e))

    west, south, east, north = resultado.bbox
    return Response(
        content=resultado.png,
        media_type="image/png",
        headers={
            "X-Bbox": f"{west},{south},{east},{north}",
            "X-Best-Lat": f"{resultado.lat}",
            "X-Best-Lon": f"{resultado.lon}",
            "X-Best-Score": f"{resultado.score_pct}",
        },
    )
