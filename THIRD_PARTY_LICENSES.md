# Licencias de terceros

El código propio de **RadioLocal-VHF-HF** está bajo licencia **MIT** (ver
[LICENSE](LICENSE)). El proyecto empaqueta, además, dos motores de propagación
de terceros que se compilan dentro de la imagen Docker del backend
([backend/Dockerfile](backend/Dockerfile)) y que conservan sus licencias
originales. Este archivo documenta esos componentes y las fuentes de datos
externas que se consumen en tiempo de ejecución.

## Componentes de terceros incluidos en la imagen

### Signal-Server (motor de cobertura VHF)

- **Qué es:** motor de propagación de radio (modelo Longley-Rice / ITM) usado
  para el cálculo de cobertura VHF sobre relieve real.
- **Licencia:** GNU General Public License v2 (GPL v2).
- **Fuente:** https://github.com/W3AXL/Signal-Server
- **Cómo se empaqueta:** se compila desde el código fuente del repositorio
  oficial, fijado al commit pinneado en `backend/Dockerfile`
  (`SIGNALSERVER_COMMIT`). El código fuente de esa versión está disponible en
  el repositorio de origen indicado arriba.

### ITURHFProp / ITU-R P.533 (motor de cobertura HF)

- **Qué es:** implementación de referencia del método ITU-R P.533 para
  predicción de propagación ionosférica HF de larga distancia.
- **Licencia:** libre de reclamos de copyright ("free from any copyright
  assertions"), provisto por la ITU-R "as is", sin garantías de ningún tipo.
- **Fuente:** https://github.com/ITU-R-Study-Group-3/ITU-R-HF
- **Cómo se empaqueta:** se compila desde el tarball de la versión oficial
  pinneada en `backend/Dockerfile` (`ITURHF_VERSION`).

## Datos

Estos no son código de terceros empaquetado, pero se reconocen sus fuentes:

- **Relieve — Copernicus GLO-30**: *Produced using Copernicus WorldDEM-30
  © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided
  under COPERNICUS by the European Union and ESA; all rights reserved.*
- **Número de manchas solares (SSN)** — NOAA/SWPC.
- **Mapa** — [MapLibre GL JS](https://maplibre.org/), tiles de
  [OpenFreeMap](https://openfreemap.org/) y datos de
  [OpenStreetMap](https://www.openstreetmap.org/copyright).

## Nota sobre redistribución

El código propio de este proyecto es MIT y no impone restricciones. Sin
embargo, quien redistribuya el **paquete completo** (incluyendo el binario
compilado de Signal-Server) debe respetar además los términos de la **GPL
v2** de ese componente.
