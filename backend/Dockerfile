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

# Instalar dependencias Python primero para aprovechar la caché de capas.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el código de la aplicación
COPY app ./app

EXPOSE 8000

# Arrancar el servidor ASGI
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
