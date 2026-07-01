"""Resolución del SSN (número de manchas solares suavizado, R12) desde NOAA.

Patrón online/offline calcado de services/dem.py (Plan A/B):
  - Plan A (online): si hay red y la caché venció o no existe, descarga el JSON de
    pronóstico de NOAA (keyless) y lo cachea en data/ssn/.
  - Plan B (offline / falla): usa la caché aunque esté vencida; y si no hay caché o
    el mes no está en el pronóstico, cae al default de config. NUNCA lanza una
    excepción al flujo de cobertura: siempre devuelve un valor usable, para que la
    app HF funcione 100% offline igual que el relieve.

Fuente (inspeccionada): array de objetos mensuales con los campos exactos
`time-tag` ("YYYY-MM") y `predicted_ssn` (float). Es un PRONÓSTICO (no trae meses
pasados), por eso un mes fuera de rango cae al default con elegancia.
"""

from __future__ import annotations

import json
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx

from app.config import settings


@dataclass
class SSNResult:
    """SSN resuelto + su procedencia (para que HF-3 muestre la fuente)."""

    value: int
    source: str          # "noaa" | "cache" | "default"
    as_of: str | None    # ISO de la descarga de la caché; None si es default


# --------------------------------------------------------------------------- #
# Conectividad (mismo enfoque que dem.is_online: socket al host de la fuente)
# --------------------------------------------------------------------------- #
def _ssn_host() -> str:
    """Host del servicio de NOAA configurado."""
    return httpx.URL(settings.hf_ssn_url).host


def is_online(timeout: float = 3.0) -> bool:
    """Chequeo rápido de conectividad contra el host de NOAA. Si no responde, a
    efectos prácticos estamos offline (no probamos contra un tercero)."""
    try:
        with socket.create_connection((_ssn_host(), 443), timeout=timeout):
            return True
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# Caché en data/ (persistida por el volumen, gitignoreada como el resto de data)
# --------------------------------------------------------------------------- #
def _cache_path() -> Path:
    p = Path(settings.hf_ssn_cache_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _cache_mtime() -> datetime | None:
    """Fecha de descarga de la caché (mtime), en UTC. None si no existe."""
    p = _cache_path()
    if not p.exists():
        return None
    return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)


def _cache_edad_dias() -> float | None:
    """Antigüedad de la caché en días. None si no existe."""
    mt = _cache_mtime()
    if mt is None:
        return None
    return (datetime.now(timezone.utc) - mt).total_seconds() / 86400.0


def _leer_cache() -> list | None:
    """Devuelve el array cacheado (o None si no existe / está corrupto)."""
    p = _cache_path()
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, list) else None


def _fetch_y_cachear() -> list:
    """Descarga el JSON de NOAA (timeout corto), lo guarda crudo en la caché y
    devuelve el array parseado. Puede lanzar (httpx/JSON); el caller lo captura."""
    resp = httpx.get(settings.hf_ssn_url, timeout=10.0, follow_redirects=True)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise ValueError("El JSON de NOAA no es un array como se esperaba.")
    # Guardar los bytes crudos (tal cual vinieron) en la caché.
    _cache_path().write_bytes(resp.content)
    return data


def _lookup(data: list, year: int, month: int) -> int | None:
    """Busca el objeto del mes pedido y devuelve round(predicted_ssn), o None."""
    tag = f"{year:04d}-{month:02d}"
    for obj in data:
        if isinstance(obj, dict) and obj.get("time-tag") == tag:
            ssn = obj.get("predicted_ssn")
            if ssn is not None:
                return int(round(float(ssn)))
    return None


# --------------------------------------------------------------------------- #
# API pública
# --------------------------------------------------------------------------- #
def get_ssn(year: int, month: int) -> SSNResult:
    """Resuelve el SSN para (year, month) con Plan A/B. Nunca lanza."""
    edad = _cache_edad_dias()
    necesita_fetch = edad is None or edad > settings.hf_ssn_ttl_days

    recien_descargado = False
    data: list | None = None
    if necesita_fetch and is_online():
        try:
            data = _fetch_y_cachear()
            recien_descargado = True
        except Exception:
            # Falla de red/HTTP/JSON: seguimos con la caché (Plan B).
            data = None

    if data is None:
        data = _leer_cache()

    if data is not None:
        val = _lookup(data, year, month)
        if val is not None:
            mt = _cache_mtime()
            return SSNResult(
                value=val,
                source="noaa" if recien_descargado else "cache",
                as_of=mt.isoformat() if mt else None,
            )

    # Fallback offline: sin caché útil o mes fuera del pronóstico.
    return SSNResult(value=settings.hf_default_ssn, source="default", as_of=None)
