# Backend FastAPI — RadioLocal-VHF-HF
#
# Build multi-stage:
#   1) builder-ss : compila el motor RF Signal-Server (fork W3AXL, fijado a un
#                   commit). Sus build-deps (cmake, g++, headers) NO llegan a la
#                   imagen final.
#   2) runtime    : python:3.12-slim con el backend; copia SOLO el binario
#                   `signalserverLIDAR` + las libs de runtime mínimas.
#
# Decisión sobre GDAL (Fase 1): NO usamos una imagen base con GDAL del sistema
# (p. ej. ghcr.io/osgeo/gdal), que es pesada y difícil de fijar. Nos apoyamos en
# las wheels manylinux de `rasterio`, que traen GDAL embebido. Imagen liviana y
# build reproducible con `pip install`.

# --------------------------------------------------------------------------- #
# Stage 1 — compilación de Signal-Server (motor RF, Fase 2)
# --------------------------------------------------------------------------- #
# Fork mantenido (2025) de Cloud-RF/Signal-Server. El repo original de Cloud-RF
# quedó como histórico y apunta a este fork. Commit fijado para reproducibilidad.
FROM debian:trixie-slim AS builder-ss

ARG SIGNALSERVER_REPO=https://github.com/W3AXL/Signal-Server.git
ARG SIGNALSERVER_COMMIT=7f6242afb3685ff31d9ad14062b80d692ee56327

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates cmake g++ make libbz2-dev zlib1g-dev libspdlog-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone "${SIGNALSERVER_REPO}" ss \
    && cd ss \
    && git checkout "${SIGNALSERVER_COMMIT}"

# Compila los 3 binarios (signalserver / HD / LIDAR). Usamos el LIDAR, que es el
# que lee tiles ASCII grid WGS84 vía -lid (nuestro camino, sin SDF).
RUN cd ss \
    && mkdir build \
    && cd build \
    && cmake ../src \
    && make -j"$(nproc)"

# --------------------------------------------------------------------------- #
# Stage 1b — compilación del motor HF (ITURHFProp, ITU-R P.533)
# --------------------------------------------------------------------------- #
# Motor de propagación HF, independiente de Signal-Server. Receta portada del
# spike HF-0 (hf-spike/Dockerfile), YA validada. Fuente fijada a la release v14.3
# del repo oficial, bajada como tarball con curl (SIN git) para reproducibilidad.
#
# Notas de build (aprendidas en el spike):
#  - libc6-dev es obligatorio: gcc en debian-slim no trae los headers de libc.
#  - make clean antes de make all: el tarball trae .o/.so precompilados.
#  - El binario NO linkea las libs; las carga con dlopen("libp533.so"/"libp372.so")
#    por soname -> en runtime deben estar en /usr/local/lib + ldconfig.
FROM debian:trixie-slim AS builder-hf

ARG ITURHF_VERSION=14.3
ARG ITURHF_URL=https://github.com/ITU-R-Study-Group-3/ITU-R-HF/archive/refs/tags/v${ITURHF_VERSION}.tar.gz

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates gcc make libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl -fL --retry 3 -o src.tar.gz "${ITURHF_URL}" \
    && tar xzf src.tar.gz \
    && rm src.tar.gz

# El Makefile de Linux/ recurre en P533 -> P372 -> ITURHFProp.
WORKDIR /build/ITU-R-HF-${ITURHF_VERSION}/Linux
RUN make clean && make all

# Consolidar artefactos (binario + 2 libs + datos ionosféricos ~132 MB) en /opt/hf.
WORKDIR /build/ITU-R-HF-${ITURHF_VERSION}
RUN mkdir -p /opt/hf/bin /opt/hf/lib /opt/hf/data \
    && cp ITURHFProp/Linux/ITURHFProp /opt/hf/bin/ \
    && cp P533/Linux/libp533.so       /opt/hf/lib/ \
    && cp P372/Linux/libp372.so       /opt/hf/lib/ \
    && cp -r P372/Data/.              /opt/hf/data/

# --------------------------------------------------------------------------- #
# Stage 2 — runtime del backend
# --------------------------------------------------------------------------- #
FROM python:3.12-slim

# No generar .pyc y salida sin buffer (logs en tiempo real)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Libs de runtime:
# - libexpat1: la espera GDAL embebido en las wheels de rasterio (Fase 1).
# - libbz2-1.0, zlib1g, libspdlog1.15: dependencias dinámicas de signalserver.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libexpat1 libbz2-1.0 zlib1g libspdlog1.15 \
    && rm -rf /var/lib/apt/lists/*

# Copiamos SOLO el binario LIDAR del motor RF desde el stage de compilación.
COPY --from=builder-ss /build/ss/build/signalserverLIDAR /usr/local/bin/signalserverLIDAR

# --- Motor HF (ITURHFProp) desde el stage builder-hf ---
# Binario + las 2 libs compartidas (el binario las carga por dlopen/soname) + los
# datos ionosféricos. ldconfig registra las .so en el cache del loader.
COPY --from=builder-hf /opt/hf/bin/ITURHFProp /usr/local/bin/ITURHFProp
COPY --from=builder-hf /opt/hf/lib/libp533.so /usr/local/lib/libp533.so
COPY --from=builder-hf /opt/hf/lib/libp372.so /usr/local/lib/libp372.so
COPY --from=builder-hf /opt/hf/data/          /opt/hf/data/
RUN ldconfig

# Instalar dependencias Python primero para aprovechar la caché de capas.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el código de la aplicación
COPY app ./app

EXPOSE 8000

# Arrancar el servidor ASGI
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
