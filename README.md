# RadioLocal-VHF-HF

Herramienta de planificación de **cobertura de radio** para brigadas de
comunicaciones de **bomberos y protección civil de Argentina**.
Funciona online y **100% offline**.

Empezamos por el módulo **VHF** (cobertura de terreno, modelo Longley-Rice).
El módulo **HF** (propagación ionosférica) vendrá después.

> Estado actual: **Fase 2 — Motor RF**. Dos servicios (backend FastAPI +
> frontend MapLibre) que arrancan con un solo comando. Obtiene y cachea relieve
> real (Copernicus GLO-30) y calcula **cobertura VHF** real con Signal-Server
> (modelo Longley-Rice) sobre ese relieve.

---

## Requisitos

- [Docker](https://docs.docker.com/get-docker/) y Docker Compose.
- Una **API key gratuita de OpenTopography** para descargar relieve (ver abajo).

## Configurar la API key de relieve

El relieve se descarga de [OpenTopography](https://portal.opentopography.org)
(Copernicus GLO-30). Para que la descarga funcione:

1. Registrate en https://portal.opentopography.org/newUser
2. En tu perfil (*myopentopo*) → **Request an API Key**.
3. Copiá el archivo de ejemplo y pegá tu clave:
   ```bash
   cp .env.example .env
   # editá .env y completá OPENTOPOGRAPHY_API_KEY=...
   ```

> El archivo `.env` está en `.gitignore`: **nunca** se commitea. Sin la clave, la
> app igual levanta y muestra el mapa; solo no podrá descargar tiles nuevos
> (sí podrá usar los que ya estén cacheados en `data/dem/`).

## Cómo levantarlo

```bash
docker compose up --build
```

Luego, en el navegador:

| Servicio              | URL                                            |
|-----------------------|------------------------------------------------|
| Mapa (frontend)       | http://localhost:8080                          |
| Backend — health      | http://localhost:8000/health                   |
| Backend — versión     | http://localhost:8000/api/version              |
| Terreno — estado      | http://localhost:8000/api/terrain/status?bbox=…|

En el mapa:
- El botón **Relieve** descarga (si hace falta) y superpone el hillshade de la
  zona visible. Si la zona no está cacheada y no hay internet, avisa que "no
  está preparada para offline".
- **Click en el mapa** ubica un transmisor; con el formulario (altura, ERP,
  frecuencia, radio…) el botón **Calcular cobertura** corre Signal-Server
  (Longley-Rice) y superpone el mapa de cobertura VHF.

Para detener: `Ctrl+C` y luego `docker compose down`.

---

## Arquitectura (resumen)

- **Backend:** Python + FastAPI. A futuro: stack geoespacial (rasterio, GDAL,
  pyproj, shapely) y orquestación del motor RF.
- **Frontend:** MapLibre GL JS servido por nginx. Preparado para PMTiles (offline).
- **Patrón clave:** los **datos** son híbridos (online con *fallback* a caché
  local), pero el **cómputo de propagación corre siempre local**.

El detalle completo está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) y el
contexto del proyecto en [CLAUDE.md](CLAUDE.md).

---

## Roadmap

| Fase | Descripción                                              | Estado     |
|------|----------------------------------------------------------|------------|
| 0    | Esqueleto MVP (backend + frontend)                       | hecha      |
| 1    | Relieve Copernicus GLO-30 cacheado como COG              | hecha      |
| 2    | Motor RF VHF (Signal-Server, Longley-Rice)               | **actual** |
| 3    | Persistencia PostgreSQL + PostGIS                        | pendiente  |
| 4    | Mapas offline con PMTiles                                | pendiente  |
| 5    | Módulo HF (propagación ionosférica)                      | pendiente  |
