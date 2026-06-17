# Arquitectura — RadioLocal-VHF-HF

Documento vivo. Describe las decisiones de arquitectura, el estado actual de
los servicios y hacia dónde evoluciona el sistema.

---

## Principio rector: datos híbridos, cómputo siempre local

La herramienta debe servir a brigadas en operativos donde **puede no haber
conectividad**. Por eso separamos dos cosas:

- **DATOS** (mapas base, relieve/DEM): *híbridos*. Se intentan obtener online
  (Copernicus GLO-30, tiles) y, si no hay red, se usa la **caché local**.
- **CÓMPUTO** de propagación RF: corre **SIEMPRE local**. Nunca depende de un
  servicio externo. El motor (Signal-Server) vive dentro del despliegue.

Consecuencia de diseño: todo lo necesario para calcular cobertura debe poder
empaquetarse y ejecutarse sin internet.

---

## Servicios — estado ACTUAL (Fase 2)

```
                  ┌──────────────────────────────┐
   navegador  ──► │  frontend (nginx + MapLibre)  │  :8080
                  │  - toggle "Relieve"           │
                  │  - click = Tx + form cobertura│
                  └──────────────┬───────────────┘
                                 │  /api/  (proxy nginx → backend, ACTIVO)
                                 ▼
                  ┌──────────────────────────────┐
                  │  backend (FastAPI)            │  :8000
                  │  - GET  /api/terrain/*        │
                  │  - POST /api/coverage         │
                  │      └─ signalserverLIDAR     │  [cómputo RF local]
                  └──────────────┬───────────────┘
                                 │ lee/escribe      ┌─► OpenTopography (GLO-30)
                                 ▼                  │   [online, on-demand]
                          data/dem/*.tif (COG) ─────┘
                          + manifest.json            [caché local / offline]
```

Dos servicios, orquestados por `docker-compose.yml`, en una red compartida
(`radiolocal-net`). El volumen `./data` persiste la caché de relieve. El motor RF
corre **dentro del backend** (binario compilado), aislado en `services/coverage.py`
para extraerse a un worker más adelante sin reescribirlo.

---

## Servicios — estado OBJETIVO (fases futuras)

```
   navegador ─► frontend (nginx + MapLibre + PMTiles offline)
                     │
                     ▼
                 backend (FastAPI)
                 ├─► worker  (Signal-Server / Longley-Rice)   [cómputo local]
                 ├─► db      (PostgreSQL + PostGIS)            [persistencia]
                 ├─► cache   (Redis)                           [colas / jobs]
                 └─► data/   (COGs de relieve Copernicus GLO-30, cacheados)
```

Estas piezas **todavía no existen**; los lugares quedan marcados (comentarios
en `docker-compose.yml` y carpeta `data/`) para sumarlas sin replantear el diseño.

---

## Componentes

### Backend (FastAPI)
- Punto de entrada: `backend/app/main.py`.
- Configuración centralizada: `backend/app/config.py` (pydantic-settings).
- Routers por dominio en `backend/app/routers/` (`health`, `version`, …).
- A futuro: endpoints de relieve y de cálculo de cobertura; orquestación del worker RF.

### Frontend (nginx + MapLibre GL JS)
- Estáticos en `frontend/public/` (`index.html`, `app.js`, `style.css`).
- `nginx.conf` sirve la SPA y deja **preparado** el `proxy_pass` de `/api/`
  hacia el backend (comentado hasta que el front consuma la API).
- Mapa centrado en Argentina. Hoy usa un estilo **demo online**
  (`demotiles.maplibre.org`); en Fase 4 se reemplaza por **PMTiles offline**.

### Motor RF — Signal-Server *(Fase 2 — implementado)*
- **Fork:** W3AXL/Signal-Server (basado en SPLAT!), commit fijado `7f6242a` (v4.0).
  Compilado vía **build multi-stage**: el stage `builder-ss` trae cmake/g++/spdlog y
  compila; el runtime copia **solo** `signalserverLIDAR` + 3 libs (`libbz2-1.0`,
  `zlib1g`, `libspdlog1.15`). Sin SDF: usamos el binario LIDAR que lee ASCII grid WGS84.
- **Servicio:** `backend/app/services/coverage.py` — función pura `run_coverage(params)`,
  sin dependencias de FastAPI (lista para un worker). `routers/coverage.py` mapea los
  errores Plan A/B (503/409/502) + `CoverageError` (500).
- **Puente de terreno** (`dem.export_ascii_grid`): ventana del DEM → `.asc` AAIGrid int16
  (CreateCopy vía `rasterio.shutil`, sin CLI de GDAL). El motor normaliza ≤0 a nivel del
  mar, lo que resuelve NODATA y el agua (Copernicus rellena con 0).
- **Modelo:** ITM/Longley-Rice (`-pm 1`). Clutter (`-udt`/`-clt`) queda para una fase futura.
- **Cómputo 100% local**, alimentado por los COG de relieve cacheados. La salida (PPM) se
  convierte a PNG RGBA transparente y se georreferencia con bounds centro ± radio (`X-Bbox`).
- **A futuro:** mover el binario y `coverage.py` a un **worker** dedicado (con Redis para
  encolar corridas largas), sin cambiar la lógica.

### Relieve — Copernicus GLO-30 *(Fase 1 — implementado)*
- **Fuente:** OpenTopography, API Global DEM (`demtype=COP30`, GLO-30, 30 m).
  Requiere API key gratuita (`OPENTOPOGRAPHY_API_KEY` en `.env`).
- **Servicio:** `backend/app/services/dem.py`. Errores de dominio tipados
  (`DEMConfigError`, `DEMOfflineError`, `DEMDownloadError`) → códigos HTTP claros
  (503 / 409 / 502) en `routers/terrain.py`.
- **Caché por tiles 1°×1°** en `data/dem/`, COG validado con rio-cogeo, nombrados
  por esquina SW (`S42W072.tif`). `manifest.json` lista lo cacheado (PostGIS más
  adelante). El límite de 450.000 km²/request de OpenTopography motiva el troceo.
- **Patrón online/offline:** `ensure_dem(bbox)` baja faltantes si hay red; si no,
  `DEMOfflineError` ("zona no preparada para offline"). `read_mosaic`/`hillshade`
  computan **siempre local** sobre los tiles cacheados.
- **GDAL en Docker:** wheels manylinux de rasterio (GDAL 3.9 embebido) + `libexpat1`.
  Sin imagen base con GDAL del sistema → imagen liviana.

### Persistencia — PostgreSQL + PostGIS *(Fase 3)*
- Estaciones, escenarios, resultados de cobertura. Se suma cuando haga falta.

---

## Decisiones registradas

| # | Decisión                                                      |
|---|---------------------------------------------------------------|
| 1 | Despliegue con Docker Compose.                                |
| 2 | Backend Python + FastAPI con stack geoespacial.               |
| 3 | Frontend MapLibre GL JS (nginx), preparado para PMTiles.      |
| 4 | Motor RF Signal-Server en un worker.                          |
| 5 | Relieve Copernicus GLO-30 on-demand, cacheado como COG.       |
| 6 | Datos híbridos; cómputo de propagación siempre local.         |
| 7 | PostgreSQL + PostGIS solo cuando se necesite persistencia.    |
| 8 | Motor RF (Fase 2): fork W3AXL/Signal-Server, binario LIDAR (`-lid`), commit fijado, build multi-stage. |
| 9 | Cobertura síncrona en el backend por ahora; `coverage.py` aislado para mover a worker. |

El roadmap por fases está en [../CLAUDE.md](../CLAUDE.md).
