# data/ — Caché de relieve

Esta carpeta guarda el **relieve (DEM) cacheado como COG** (Cloud-Optimized
GeoTIFF), descargado on-demand de **Copernicus GLO-30** vía OpenTopography (Fase 1).

- `dem/` — tiles de 1°×1° (`S42W072.tif`, …) + `manifest.json`.

Sigue el patrón **datos híbridos**: se intenta obtener online y, si no hay red,
se usa lo que ya esté acá. Por eso el contenido **no se versiona** en git
(ver `.gitignore`); solo se mantienen este README y `.gitkeep`.
