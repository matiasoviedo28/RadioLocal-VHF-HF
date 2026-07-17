<p align="center">
  <img src="img/logo.png" alt="Logo de RadioLocal-VHF-HF" width="120" />
</p>

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
                  │  - */export.kmz → Google Earth│
                  └──────────────┬───────────────┘
                                 │ lee/escribe      ┌─► S3 Copernicus GLO-30
                                 ▼                  │   [bucket público, sin key]
                          data/dem/*.tif (COG) ─────┤   (OpenTopography = fallback)
                          + manifest.json           │
                          + tileList.txt             [caché local / offline]
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

### Motor HF — ITURHFProp (ITU-R P.533) *(Fase HF — implementado)*
Predicción de propagación **HF** por cobertura de **área** (modo distinto al VHF punto-radio).

- **Binario:** `ITURHFProp` + `libp533.so`/`libp372.so`, compilados desde el repo oficial
  ITU-R-HF **v14.3** (tarball vía `curl`, sin git) en un stage `builder-hf` del
  `backend/Dockerfile`. El runtime copia binario + libs a `/usr/local/lib` (`ldconfig`; el
  binario las carga por `dlopen`/soname) + los datos ionosféricos/CCIR (~132 MB) a
  `/opt/hf/data`. Notas de build: hace falta `libc6-dev`, y `make clean` antes de `make all`
  (el tarball trae `.o/.so` precompilados). No toca el stage de Signal-Server.
- **Servicio:** `backend/app/services/hf_coverage.py` — función pura `run_hf_coverage(params)`
  (sin FastAPI). Arma el `.in` desde una plantilla (validada en el spike HF-0), corre el binario,
  **parsea el `.out` mapeando columnas dinámicamente** desde la sección `Data Format` (no
  hardcodea posiciones), reconstruye la grilla de BCR y la rasteriza a PNG RGBA (interpolación
  bilineal con rasterio, sin scipy).
- **SSN (manchas solares R12):** `backend/app/services/ssn.py` — `get_ssn(year, month)` con Plan
  A/B calcado del DEM: descarga el pronóstico de **NOAA/SWPC** (keyless), lo cachea en
  `data/ssn/` (TTL 7 días) y **degrada con elegancia** (online→`noaa`, caché→`cache`,
  sin red ni caché→`default` con `hf_default_ssn=100`). **Nunca lanza** al flujo de cobertura.

**Contrato de endpoints (para el frontend):**
- `POST /api/hf/coverage` — body: `tx_lat, tx_lon, frequency_mhz, month (1–12), hour_utc (0–23),
  range_km` (alcance del área), y opcionales `ssn` (override manual), `year` (default año UTC),
  `noise` (default `RURAL`), `increment`. Responde **PNG** (overlay) + headers: `X-Bbox`
  (`oeste,sur,este,norte`, mismo criterio que el overlay VHF), `X-SSN`, `X-SSN-Source`
  (`noaa|cache|default|manual`), `X-SSN-AsOf`, `X-Grid` (`n_lat x n_lon`), `X-Grid-Inc`.
  Errores: **422** (alcance fuera de rango / params inválidos), 500 (motor).
- `GET /api/hf/ssn?year=&month=` — default = año/mes UTC actual. Responde
  `{value, source, as_of, year, month}` para mostrar la procedencia del SSN en la UI.

**Mapeo de hora UI 0–23 ↔ motor 1–24:** el motor usa la convención **1–24** y **segfaultea con
0**. La UI (y el endpoint) exponen **0–23** (natural); `hf_coverage.py` traduce `UI 0 (medianoche)
→ motor 24` y `UI 1..23 → motor 1..23`. Verificado: hora 0 da patrón nocturno coherente.

**Escala de color (fiabilidad de circuito BCR, %):** bandas discretas — la leyenda del frontend
refleja EXACTAMENTE estos cortes (`_BANDAS_BCR` en `hf_coverage.py`): **≥90** verde fuerte
`#1a9850` · **75–90** verde-amarillo `#a6d96a` · **50–75** naranja `#fdae61` · **<50** rojo
`#d73027` (semitransparente). La baja fiabilidad cerca del Tx en ciertas bandas/horas es la **zona
de silencio** (skip zone) física, no un error.

**Área CENTRADA en el Tx (independiente del zoom):** el área de cálculo NO viene del viewport del
mapa (era un error de diseño: HF es de larga distancia; con zoom cerrado daba un área degenerada).
El usuario elige un **Alcance** (radio en km) y el **backend deriva el bbox = Tx ± alcance**
(`_bbox_centrado` en `hf_coverage.py`, única fuente de la conversión km→grados:
`Δlat° = km/111`, `Δlon° = km/(111·cos(lat_tx))` — la celda en lon crece con la latitud). La latitud
se **clampea** a [-85, 85] y la longitud se **clipea** a [-180, 180] (sin wrappear el antimeridiano).
Presets de la UI (mismos en el `<select>` del frontend, `ALCANCES_HF`): **Regional ~2000 km ·
Continental ~4000 km (default) · DX/Largo ~7000 km**; caps en config (`hf_range_min_km=100`,
`hf_range_max_km=8000`). `latinc/lnginc` se derivan para no pasar `hf_max_points` (alcance mayor ⇒
grilla más gruesa; el campo HF es suave). Tras un cálculo, el frontend hace **`fitBounds`** al
`X-Bbox` para encuadrar toda la cobertura sin importar el zoom previo. **El resultado es idéntico en
cualquier zoom del mapa.**

**Robustez — área degenerada (bugfix):** un área muy chica (viewport con zoom cerrado, ej. bbox de
fracciones de grado) colapsaba la grilla a **1 punto** por dimensión → el bbox de nodos quedaba con
extensión 0 → **`ZeroDivisionError` en `_tamano_raster`** (`lado * span_lat / span_lon` con
`span_lon = 0`) → **HTTP 500**. Fix de raíz: `_derivar_incremento` rechaza áreas con lado
`< _MIN_SPAN_DEG` (1° ≈ 111 km) o alto/ancho ~0 con **422 amable** ("La cobertura HF es de larga
distancia: alejá el mapa…"), y `_tamano_raster` se blinda para caer a un raster cuadrado ante
cualquier extensión 0. **Decisión UX:** un área minúscula no tiene sentido físico en HF (larga
distancia), así que se pide agrandar el área (422 que el frontend ya muestra) en vez de expandir el
bbox silenciosamente. El colormap es discreto por cortes fijos (no normaliza por min/max), así que
grillas de valor uniforme (todo 100 %) no dividen por cero. Guard de regresión:
`backend/tests/test_hf_degenerado.py` (área chica, bbox 0, valores uniformes → nunca 500).

**Frontend (HF-3):** toggle **VHF | HF** en la topbar (default VHF, aditivo). En HF se ocultan
"Relieve"/"Descargar zona" (HF no usa DEM), se cambia al panel `#panel-hf` (banda→MHz, mes, hora,
SSN auto con procedencia, Avanzado plegado con override de SSN/ruido) y se dibuja el overlay con
`agregarOverlayRaster` + leyenda. VHF queda sin cambios de comportamiento.

### Exportación a Google Earth — KMZ *(implementado)*
- **Servicio:** `backend/app/services/kmz.py` — `build_kmz(png, bbox, params, nombre)`
  arma un **KMZ** (ZIP autocontenido, solo `zipfile` de la stdlib): `doc.kml` +
  `files/cobertura.png`. El `<GroundOverlay>` referencia el PNG empaquetado y lo
  ubica con `<LatLonBox>` (north/south/east/west desde el bbox `(O, S, E, N)`,
  **sin flip**: el PNG es north-up, igual que el overlay del mapa web). Lleva un
  `<Placemark>` en el Tx con los parámetros y la atribución Copernicus a nivel
  documento. **No recalcula nada**: reusa el PNG/bbox ya disponibles.
- **Endpoints:** `POST /api/coverage/export.kmz` (cobertura ACTUAL: reusa el cache
  en memoria por params vía `coverage.get_cached`, sin recomputar) y
  `GET /api/coverages/{id}/export.kmz` (cobertura GUARDADA: lee PNG + `meta.json`
  del disco). Ambos responden con `Content-Disposition` (nombre basado en la
  cobertura).

### "Mejor ubicación" — búsqueda del mejor punto para una repetidora *(implementado)*
Problema inverso a la cobertura VHF: el usuario dibuja un **perímetro** (la zona
que quiere cubrir) y el sistema busca las coordenadas que la cubren mejor. Clave
en terreno montañoso: el mejor punto suele ser un cerro, no el centroide del área.

- **Servicio:** `backend/app/services/best_site.py` — función pura `find_best_site`
  (mismo patrón que `coverage.py`: sin FastAPI, pensada para mover a worker). Dos
  etapas:
  1. **Barrido rápido:** grilla de candidatos dentro del polígono **+ un anillo de
     buffer alrededor** (en terreno montañoso el mejor sitio suele estar fuera del
     valle a cubrir). Cada candidato se puntúa por **line-of-sight geométrico**
     (con curvatura terrestre, k=4/3) contra una muestra de puntos del polígono,
     usando `dem.read_mosaic` directo (sin correr el motor RF). Heurística rápida,
     no modela difracción.
  2. **Refinamiento:** a los 3 candidatos mejor puntuados se les corre el motor
     real (`coverage.run_coverage`, Signal-Server/ITM) y se elige el que cubre más
     % real del polígono (medido sobre el PNG resultante, banda alpha). Reusa el
     motor VHF tal cual: no agrega ningún modelo de propagación nuevo.
- **Endpoint:** `POST /api/best-site` — body: perímetro (`poligono`, ≥3 puntos
  lat/lon) + parámetros del transmisor (mismos campos que `/api/coverage`).
  Responde **PNG** (overlay del punto ganador) + `X-Bbox` + `X-Best-Lat/Lon/Score`.
  Mismo contrato de errores que `/api/coverage` (**409** con `bbox`/`missing` si
  falta DEM del área de búsqueda, **422** si el polígono es inválido o su tamaño
  no entra en el rango soportado ~0.5–60 km de diagonal).
- **Frontend:** tercer modo en el toggle de la topbar (`VHF | HF | Mejor
  ubicación`). El mapa entra en "modo dibujo": click agrega un vértice; clickear
  cerca del primer punto (o el botón "Cerrar área") cierra el perímetro; "Buscar
  mejor ubicación" cierra automáticamente si el usuario no lo hizo a mano. Usa
  relieve/DEM igual que VHF (a diferencia de HF): "Relieve" y "Descargar zona"
  quedan disponibles. El resultado se marca con un pin verde + el overlay de
  cobertura real del punto elegido.
- **Geometría:** `shapely` (antes comentado en `requirements.txt` a la espera de
  este momento) para el polígono, buffers y el filtro de candidatos/objetivos.

### Relieve — Copernicus GLO-30 *(Fase 1 — implementado)*
- **Fuente (configurable, `settings.dem_source`):**
  - **`"s3"` (default):** bucket público de Copernicus GLO-30 en AWS
    (`copernicus-dem-30m`), descarga **anónima** por HTTPS, **sin API key** (httpx,
    sin SDK). El .tif vive en
    `{base}/Copernicus_DSM_COG_10_S42_00_W072_00_DEM/<mismo>.tif`.
  - **`"opentopography"` (fallback opcional):** API Global DEM (`demtype=COP30`),
    requiere API key gratuita. Reversible y sin romper nada: ambas fuentes sirven
    el MISMO dato Copernicus GLO-30 → el relieve sale **idéntico** (verificado:
    array byte a byte igual entre S3 y OpenTopography para un mismo tile).
- **Autoridad de existencia — `tileList.txt`:** la lista de tiles del bucket se
  cachea en `data/dem/tileList.txt`. Tile en la lista → se descarga; tile fuera de
  la lista → es **océano** → se sintetiza un tile plano a nivel del mar (0 m), COG,
  **sin pegarle a la red**, marcado `ocean:true` en el manifest.
- **Océano sintético, sin costura:** Copernicus usa **grilla flexible** (las filas
  siempre 3600; las columnas se reducen hacia los polos: <50° = 3600, 50–60° = 2400,
  etc.). El tile de océano **clona la grilla** (dimensiones, paso y offset de medio
  píxel) de los tiles reales de su banda de latitud, así `read_mosaic` no tiene
  costura en la costa austral. Tabla de bandas verificada contra tiles reales del
  bucket (S50=3600, S51=2400). El pipeline (`read_mosaic`, `export_ascii_grid`)
  tolera tiles con menos columnas.
- **Tiles del bucket ya son COG:** se validan con rio-cogeo y se lee su resolución;
  **no se reconvierten** (se guardan tal cual).
- **API key (solo fallback OT):** por **header** `X-OpenTopography-Key` o por `.env`
  (`OPENTOPOGRAPHY_API_KEY`). Precedencia: header > `.env`. La key no se loguea ni
  se expone. `GET /api/config/status` devuelve
  `{requires_api_key, has_api_key}`: con `dem_source="s3"` → `requires_api_key=false`
  y el frontend nunca pide key.
- **Servicio:** `backend/app/services/dem.py`. Errores de dominio tipados
  (`DEMConfigError`, `DEMInvalidKeyError`, `DEMOfflineError`, `DEMDownloadError`)
  → códigos HTTP claros en `routers/terrain.py`, con `detail` estructurado
  (`{code, message}`). Los de key (`no_api_key`/`invalid_api_key`) solo aplican al
  fallback OT.
- **Caché por tiles 1°×1°** en `data/dem/`, COG validado con rio-cogeo, nombrados
  por esquina SW (`S42W072.tif`). `manifest.json` lista lo cacheado (PostGIS más
  adelante).
- **Patrón online/offline:** `ensure_dem(bbox)` baja faltantes si hay red; si no,
  `DEMOfflineError` ("zona no preparada para offline"). `read_mosaic`/`hillshade`
  computan **siempre local** sobre los tiles cacheados.
- **GDAL en Docker:** wheels manylinux de rasterio (GDAL 3.9 embebido) + `libexpat1`.
  Sin imagen base con GDAL del sistema → imagen liviana.

### Descarga masiva por región — pack offline *(herramienta de preparación)*
- **Módulo CLI** `backend/app/tools/descargar_region.py`, ejecutable con
  `docker compose exec backend python -m app.tools.descargar_region …`.
- **Args:** `--bbox SUR OESTE NORTE ESTE`, `--provincia <nombre>` (diccionario de
  provincias argentinas), `--pais argentina`, `--concurrency N` (default 6).
- **Comportamiento:** calcula los tiles del bbox (`tiles_for_bbox`), saltea los
  cacheados (**reanudable**), baja en paralelo con **reintentos** (backoff),
  reusando la lógica de `dem.py` (S3 + océano sintético). Progreso por consola y
  resumen final (descargados/océano/salteados/fallidos) + verificación de
  completitud. Escribe en la misma caché `data/dem/`.
- **Modelo offline:** una persona arma el pack (provincia ~cientos de MB, país
  ~15–25 GB) y comparte `data/dem/`; en campo, terreno + cobertura corren 100%
  offline. Por eso es CLI: no agrega UI ni toca el frontend.

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
| 5 | Relieve Copernicus GLO-30 on-demand, cacheado como COG. Fuente por defecto: bucket público S3 (sin API key); OpenTopography como fallback opcional. Océano sintético para tiles fuera del bucket. CLI de descarga por región para packs offline. |
| 6 | Datos híbridos; cómputo de propagación siempre local.         |
| 7 | PostgreSQL + PostGIS solo cuando se necesite persistencia.    |
| 8 | Motor RF (Fase 2): fork W3AXL/Signal-Server, binario LIDAR (`-lid`), commit fijado, build multi-stage. |
| 9 | Cobertura síncrona en el backend por ahora; `coverage.py` aislado para mover a worker. |
| 10 | Exportación a Google Earth como KMZ autocontenido (`zipfile`, sin libs extra), reusando el PNG/bbox ya calculado (sin recomputar). |
| 11 | "Mejor ubicación": barrido LOS heurístico (rápido, sin motor RF) + refinamiento con el motor real (ITM) sobre los mejores candidatos. Candidatos permitidos fuera del polígono (buffer), no solo adentro. |

El roadmap por fases está en [../CLAUDE.md](../CLAUDE.md).
