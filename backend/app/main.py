"""Punto de entrada de la API de RadioLocal-VHF-HF.

Crea la aplicación FastAPI, configura CORS para que el frontend pueda
consumir la API y monta los routers por dominio.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    best_site,
    config,
    coverage,
    coverages,
    health,
    hf_coverage,
    regions,
    terrain,
    version,
)

# Aplicación FastAPI con metadatos tomados de la configuración.
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="API de planificación de cobertura de radio (VHF/HF).",
)

# CORS: el frontend (nginx en :8080) consume esta API desde el navegador.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers del MVP (Fase 0).
app.include_router(health.router)
app.include_router(version.router)

# Estado de configuración (UX de la API key de relieve).
app.include_router(config.router)

# Fase 1: relieve / terreno.
app.include_router(terrain.router)

# Regiones disponibles para descarga masiva (provincias argentinas).
app.include_router(regions.router)

# Fase 2: motor RF (cobertura VHF).
app.include_router(coverage.router)

# Coberturas guardadas (persistencia en disco).
app.include_router(coverages.router)

# Fase HF: motor de propagación HF (ITU-R P.533, cobertura de área).
app.include_router(hf_coverage.router)

# "Mejor ubicación": dado un perímetro, busca el mejor punto para una repetidora.
app.include_router(best_site.router)
