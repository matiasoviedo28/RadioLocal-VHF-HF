"""Endpoint de cobertura HF de área (ITU-R P.533, motor ITURHFProp).

Corre síncrono en el backend (el motor es muy rápido, ~2,5 ms/punto). El servicio
`hf_coverage.run_hf_coverage` está aislado (sin FastAPI) para testear/mover fácil.
Calca el contrato del endpoint de cobertura VHF: responde un PNG (overlay) + header
X-Bbox con los bounds, para que el frontend lo ubique igual que el overlay VHF.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.config import settings
from app.services import hf_coverage, ssn

router = APIRouter(prefix="/api/hf", tags=["cobertura-hf"])


@router.get("/ssn")
def ssn_endpoint(
    year: int | None = Query(None, ge=1900, le=2100),
    month: int | None = Query(None, ge=1, le=12),
) -> dict:
    """Resuelve el SSN (manchas solares, R12) para un mes, con su procedencia.

    year/month por defecto = año/mes UTC actual. La `source` permite que HF-3
    muestre "SSN 102 · pronóstico NOAA" vs "· valor por defecto (sin conexión)".
    """
    ahora = datetime.now(timezone.utc)
    y = year or ahora.year
    m = month or ahora.month
    r = ssn.get_ssn(y, m)
    return {
        "value": r.value,
        "source": r.source,
        "as_of": r.as_of,
        "year": y,
        "month": m,
    }


class HFCoverageRequest(BaseModel):
    """Parámetros de una corrida de cobertura HF de área.

    El área es el bbox del viewport; el incremento de grilla se deriva solo (con un
    tope de puntos) salvo que se pase explícito.
    """

    tx_lat: float = Field(..., ge=-90, le=90, description="Latitud del Tx")
    tx_lon: float = Field(..., ge=-180, le=180, description="Longitud del Tx")
    frequency_mhz: float = Field(7.1, gt=0, description="Frecuencia (MHz), ej. 40 m ≈ 7.1")
    month: int = Field(..., ge=1, le=12, description="Mes (1-12)")
    hour_utc: int = Field(..., ge=0, le=23, description="Hora UTC (0-23; el backend mapea a 1-24 del motor)")
    # SSN opcional: si se omite, el backend lo resuelve desde NOAA (HF-2). Si se
    # pasa, es un override manual y se usa tal cual.
    ssn: int | None = Field(None, ge=0, le=311, description="Manchas solares R12 (override manual)")
    # Año opcional: default = año UTC actual. Consistente con la búsqueda del SSN.
    year: int | None = Field(None, ge=1900, le=2100, description="Año de la predicción")
    noise: str = Field("RURAL", description="Ambiente de ruido man-made (RURAL, CITY, ...)")

    # Alcance (radio) del área HF en km, CENTRADA en el Tx. Reemplaza el bbox del
    # viewport: el área ya NO depende del zoom del frontend. Default = Continental.
    range_km: float = Field(
        settings.hf_range_default_km,
        gt=0,
        description="Alcance del área en km (Tx ± range_km). Ej: 2000 / 4000 / 7000",
    )

    # Incremento de grilla (deg). Opcional: si se omite, se deriva del área.
    increment: float | None = Field(None, gt=0, description="Incremento de grilla (deg)")


@router.post("/coverage")
def hf_coverage_endpoint(req: HFCoverageRequest) -> Response:
    """Calcula la cobertura HF de área y devuelve un PNG (overlay) + header X-Bbox.

    Mismo contrato que /api/coverage (VHF): el frontend ubica el overlay con los
    bounds del header X-Bbox = "oeste,sur,este,norte".

    El SSN se resuelve solo (NOAA) si no viene en el request; si viene, es override
    manual. La procedencia se devuelve en los headers X-SSN* para que HF-3 la muestre.
    """
    year = req.year or datetime.now(timezone.utc).year

    # Resolución del SSN: override manual vs pronóstico de NOAA (con fallback offline).
    if req.ssn is not None:
        ssn_val, ssn_source, ssn_asof = req.ssn, "manual", None
    else:
        r = ssn.get_ssn(year, req.month)
        ssn_val, ssn_source, ssn_asof = r.value, r.source, r.as_of

    params = hf_coverage.HFCoverageParams(
        tx_lat=req.tx_lat,
        tx_lon=req.tx_lon,
        freq_mhz=req.frequency_mhz,
        month=req.month,
        hour_utc=req.hour_utc,
        ssn=ssn_val,
        year=year,
        noise=req.noise,
        range_km=req.range_km,
        increment=req.increment,
    )

    try:
        result = hf_coverage.run_hf_coverage(params)
    except hf_coverage.HFCoverageNotPossible as e:
        # 422: área inválida/enorme o grilla que excede el tope síncrono.
        raise HTTPException(status_code=422, detail=str(e))
    except hf_coverage.HFCoverageError as e:
        # 500: el motor falló o su salida no se pudo parsear.
        raise HTTPException(status_code=500, detail=str(e))

    west, south, east, north = result.bbox
    headers = {
        "X-Bbox": f"{west},{south},{east},{north}",
        # Metadatos de la corrida (útiles para el frontend/diagnóstico).
        "X-Grid": f"{result.n_lat}x{result.n_lon}",
        "X-Grid-Inc": f"{result.latinc:g}",
        # Procedencia del SSN (para que HF-3 muestre la fuente).
        "X-SSN": str(ssn_val),
        "X-SSN-Source": ssn_source,
    }
    if ssn_asof is not None:
        headers["X-SSN-AsOf"] = ssn_asof

    return Response(content=result.png, media_type="image/png", headers=headers)
