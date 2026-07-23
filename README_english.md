<p align="center">
  <img src="docs/img/logo.png" alt="RadioLocal-VHF-HF logo" width="160" />
</p>

# RadioLocal-VHF-HF

*This is the English version of this document. For the original Spanish version, see [README.md](README.md).*

[![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![rasterio](https://img.shields.io/badge/rasterio-GDAL-5a9fd4?logo=python&logoColor=white)](https://rasterio.readthedocs.io/)
[![Signal-Server](https://img.shields.io/badge/VHF-Signal--Server%20(ITM%2FLongley--Rice)-f57c00)](https://github.com/W3AXL/Signal-Server)
[![ITU-R P.533](https://img.shields.io/badge/HF-ITU--R%20P.533%20(ITURHFProp)-8e44ad)](https://github.com/ITU-R-Study-Group-3/ITU-R-HF)
[![MapLibre](https://img.shields.io/badge/MapLibre%20GL-4.7-396cb2?logo=maplibre&logoColor=white)](https://maplibre.org/)
[![Copernicus GLO-30](https://img.shields.io/badge/DEM-Copernicus%20GLO--30-0b5394)](https://registry.opendata.aws/copernicus-dem/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Version](https://img.shields.io/badge/version-1.3.4-b71c1c)](https://github.com/matiasoviedo28/RadioLocal-VHF-HF)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![YouTube Tutorial](https://img.shields.io/badge/YouTube-Tutorial-FF0000?logo=youtube&logoColor=white)](https://youtu.be/LfRk-zBDxqQ)

A tool for **planning VHF and HF radio coverage**, running on your own machine, with a
simple, no-frills interface. Built for **emergency services** and **ham radio operators**
alike, anywhere in the world.

![RadioLocal-VHF-HF in action — HF coverage](docs/gif/HF.gif)

---

## What it is, where it comes from, and what it's for

Knowing how far your signal is actually going to reach — before you head out — is
critical: which hills block VHF line of sight, which areas end up with no coverage
at all, where a repeater should go, or which band and time of day will get you a
long-distance HF contact. The web tools that answer these questions run online and
depend on third-party services — exactly what you don't want while you're
coordinating comms out in the field.

RadioLocal-VHF-HF exists to fix that: a tool that's **yours**, that runs **locally**,
so you're never depending on an outside website when it's time to calculate.
Propagation is **always computed on your own machine**, and the data it needs
(terrain, solar conditions) gets downloaded once and stays **cached**, so it keeps
working later even without internet.

It works in **two modes**:

- **VHF** — local coverage over **real terrain** (line-of-sight, hills, elevation).
  Great for planning links and siting repeaters in a given area.
- **HF** — **long-distance** coverage via ionospheric reflection. Shows link
  reliability by **band**, **month**, and **hour**, over thousands of kilometers.

**Who it's for:**

- **Emergency services** (firefighters, civil protection, civil defense): planning
  comms for field operations, siting repeaters, spotting dead zones ahead of time.
- **Ham radio operators everywhere**: estimating a station's VHF range over real
  terrain, and planning local or DX HF contacts based on band, time of day, and
  solar activity.

> Works anywhere in the world: the terrain data is global (Copernicus GLO-30) and
> the HF model (ITU-R P.533) is an international standard.

---

## Features

- **VHF coverage calculation** with **Signal-Server** (**Longley-Rice / ITM** model),
  running **100% locally**. Click on the map to place the transmitter, then fill in
  a form with the parameters (antenna height, ERP, frequency, calculation radius).

![VHF coverage calculation](docs/gif/VHF.gif)

- **Best Site**: draw the perimeter of the area you want to cover on the map (click
  to add points — it closes itself automatically if you don't close it by hand),
  and the tool searches for the coordinates that cover it best. It runs in two
  passes: a fast line-of-sight sweep over real terrain (which also searches a ring
  around the perimeter, since in mountainous terrain the best spot is usually a
  hill *outside* the valley you're trying to cover, not inside it), followed by a
  refinement pass that runs the real VHF engine on the top-scoring candidates. The
  winner gets marked on the map together with its coverage.

![Drawing the perimeter to cover](docs/gif/dibujar.gif)

![Perimeter drawn, ready to calculate](docs/img/jurisdiccion.png)

- **HF coverage calculation** with **ITURHFProp** (the reference implementation of
  **ITU-R P.533**), also **100% local**. An area map showing circuit reliability by
  **band** (80–10 m, or a free-form frequency), **month**, and **hour (UTC)**, with
  a **selectable range** (regional / continental / DX). The **sunspot number
  (SSN)** is fetched automatically from the **NOAA/SWPC** forecast, with an offline
  fallback and a manual override.

![HF coverage at 40 m](docs/img/fronted_hf.png)

![HF coverage example at 10 m](docs/img/example_hf_10.png)

- **Real terrain (DEM)** from **Copernicus GLO-30** (30 m), downloaded on demand
  from **Copernicus's public bucket on AWS**, **no API key needed** (OpenTopography
  is available as an optional fallback).

- **Local terrain cache by tile** (1°×1°, stored as COG files under `data/dem/`): an
  area you've already downloaded won't be fetched again, and stays available even
  without internet.

- **HF works offline out of the box**: the model's ionospheric data ships embedded
  in the image, so HF calculations work without internet from the very first run —
  only the SSN needs a connection (and it has a fallback for when it doesn't).

- **Export to Google Earth (KMZ)**: download a coverage result as a self-contained
  `.kmz` file (image + parameters + transmitter pin) and open it draped over Google
  Earth's 3D terrain.

- **Bulk regional download** (CLI): fetch a large area in one go to work with VHF
  **fully offline** (see [Bulk download / offline use](#bulk-download--offline-use)).

- **Interactive map** built with **MapLibre GL JS**, with terrain hillshading.

- **Docker Compose deployment**: backend (FastAPI) and frontend (nginx + MapLibre)
  start together with a single command.

---

## Requirements

- **Docker** and Docker Compose. Official install guides:
  - **Ubuntu:** https://docs.docker.com/engine/install/ubuntu/
  - **Windows:** https://docs.docker.com/desktop/setup/install/windows-install/
- **Internet connection** is only needed to fetch fresh data the first time: the
  **terrain** for your area (VHF) and NOAA's **SSN** (HF). After that, both are
  cached and work offline. **No API key required.**

---

## Getting started

> 📺 **Prefer watching a video?** Full step-by-step tutorial (Windows, no coding
> required): https://youtu.be/LfRk-zBDxqQ *(the video itself is in Spanish)*

1. **Clone the repository:**

   ```bash
   git clone https://github.com/matiasoviedo28/RadioLocal-VHF-HF.git
   cd RadioLocal-VHF-HF
   ```

2. **Start the services:**

   ```bash
   docker compose up -d --build
   ```

3. **Open the app** in your browser: **http://localhost:8080**

   ![Cloning and starting the project](docs/gif/git_clone.gif)

4. **Use the app.** No configuration needed:
   - In **VHF** mode: zoom into your area, use **"Descargar zona"** (*Download
     area*) the first time to fetch the terrain, then run the coverage calculation.
   - In **HF** mode: switch to **HF** in the top bar, place your station with a
     click, pick band / month / hour / range, and calculate. The SSN fills in on
     its own.

> **Want to work with VHF offline out in the field?** Grab an entire region at once
> with the [Bulk download](#bulk-download--offline-use) command and take the
> `data/dem/` folder with you. (HF mode already works offline without a pack.)

> **Terrain fallback (optional).** Besides Copernicus's public bucket, you can use
> **OpenTopography** as an alternative source by setting
> `RADIOLOCAL_DEM_SOURCE=opentopography` in `.env` (requires a free API key). It's
> **not** used in the default flow.

---

## Bulk download / offline use

For VHF field operations without connectivity, you can build a terrain **"pack"**
for an entire region in one shot, then use terrain and coverage **fully offline**
afterward. **One person** (with internet) prepares it and shares the `data/dem/`
folder.

The **bounding-box method works anywhere in the world**:

```bash
# By bounding box: SOUTH WEST NORTH EAST (anywhere in the world)
docker compose exec backend python -m app.tools.descargar_region --bbox -42 -72 -40 -70

# Tune concurrency to your connection (default 6)
docker compose exec backend python -m app.tools.descargar_region --bbox -42 -72 -40 -70 --concurrency 8
```

There are also **shortcuts by province/country** (`--provincia`, `--pais`) with
presets built in for Argentina:

```bash
docker compose exec backend python -m app.tools.descargar_region --provincia "tierra del fuego"
docker compose exec backend python -m app.tools.descargar_region --pais argentina
```

The tool is **resumable** (skips what's already downloaded), retries on network
failures, shows progress (`[45/520] …`), and verifies completeness at the end.
Tiles that fall over the ocean are generated as **synthetic ocean** (flat, at sea
level) without ever hitting the network.

**Pack size model (rough estimates):**

| Range              | Approx. size  |
|--------------------|---------------|
| Small region       | hundreds of MB |
| Whole country      | ~15–25 GB     |

Once the pack is ready, copy the `data/dem/` folder to the field machine (or share
it): terrain and VHF coverage calculations will work there without internet.

From the **"Descargar zona"** (*Download area*) panel, you can turn on **"Mostrar
en el mapa"** (*Show on map*) to see which areas you already have available
offline, highlighted on the map:

![Downloaded areas highlighted on the map](docs/img/zona_descargada.png)

---

## Version history

- **beta** — Initial template: project skeleton (Docker Compose, base map,
  backend/frontend structure).
- **1.1.0** — VHF working end to end: VHF coverage calculation (Longley-Rice) over
  Copernicus terrain, offline use, Google Earth export (KMZ), and a simple
  interface. **Field-tested and checked against real measurements.**
- **1.2.1** — HF baseline: HF area coverage (ITU-R P.533) by band, month, and
  hour, with automatic SSN from NOAA and a selectable range (regional /
  continental / DX).
- **1.3.4** — Best Site: draw the perimeter of the area you want to cover and the
  tool finds the best spot for a repeater (line-of-sight sweep + refinement with
  the real VHF engine). Windows launcher (`INICIAR.bat` / `APAGAR.bat`, no command
  line needed) with a diagnostic for virtualization disabled in the BIOS.

---

## License

This project's code is licensed under **MIT** (see [LICENSE](LICENSE)).

It includes third-party components under their own licenses — Signal-Server
(GPL v2) and ITURHFProp (ITU-R) — detailed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

---

## More information

- **[docs/ARQUITECTURA.md](docs/ARQUITECTURA.md)** — technical detail: services,
  RF engines (VHF and HF), caching scheme, data sources, and architecture
  decisions. *(this document is in Spanish)*

---

## Attribution & credits

- **Terrain — Copernicus GLO-30** (`COP30` DEM): *Produced using Copernicus
  WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
  provided under COPERNICUS by the European Union and ESA; all rights reserved.*
  Tiles are downloaded from Copernicus's public DEM bucket on AWS
  ([AWS Open Data registry](https://registry.opendata.aws/copernicus-dem/),
  `copernicus-dem-30m`), anonymous access, no cost. Optional alternative source:
  **OpenTopography**.
- **VHF engine — [Signal-Server](https://github.com/W3AXL/Signal-Server)**
  (Longley-Rice / ITM model).
- **HF engine — [ITURHFProp / ITU-R P.533](https://github.com/ITU-R-Study-Group-3/ITU-R-HF)**,
  the ITU-R's reference implementation.
- **Solar data (SSN) — NOAA / SWPC**, smoothed sunspot number forecast.
- **Map — [MapLibre GL JS](https://maplibre.org/)**, tiles from
  [OpenFreeMap](https://openfreemap.org/) and
  [OpenStreetMap](https://www.openstreetmap.org/copyright) data.
