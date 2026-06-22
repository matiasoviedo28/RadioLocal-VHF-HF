"""Exportación de una cobertura a Google Earth (KMZ).

Un KMZ es un ZIP autocontenido: `doc.kml` (texto) + el PNG de la cobertura
adentro (`files/cobertura.png`). Así viaja la imagen junto al KML y se abre con
doble clic en Google Earth, sin depender de URLs externas.

Este módulo NO recalcula nada: recibe el PNG y el bbox ya disponibles (del cache
en memoria para la cobertura actual, o del disco para una guardada) y los empaqueta.
Sin librerías extra: solo `zipfile` de la stdlib.
"""

from __future__ import annotations

import math
import re
import unicodedata
import zipfile
from io import BytesIO
from urllib.parse import quote
from xml.sax.saxutils import escape

# El bbox es una tupla (oeste, sur, este, norte), el mismo `dem.Bbox` del resto de
# la app. No importamos `dem` para no arrastrar el stack geoespacial (rasterio):
# este módulo es texto + zip puro.
Bbox = tuple[float, float, float, float]

# Ruta del PNG DENTRO del KMZ. El href del <Icon> debe coincidir exactamente.
_PNG_ARCNAME = "files/cobertura.png"

# Atribución del dato de elevación (Copernicus GLO-30, igual que el README).
_ATRIBUCION = (
    "Generado con RadioLocal-VHF-HF. Relieve: Copernicus GLO-30 (DEM COP30) — "
    "Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus "
    "Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European "
    "Union and ESA; all rights reserved."
)


def _fmt(x: float) -> str:
    """Formatea un float para coordenadas KML (sin notación científica)."""
    return f"{x:.6f}"


def content_disposition(nombre: str) -> str:
    """Header Content-Disposition para descargar el KMZ con el nombre dado.

    Incluye un `filename` ASCII (fallback para clientes viejos) y `filename*` en
    UTF-8 (RFC 5987) para conservar acentos. Ej: "Repetidora Cerro Otto" ->
    cobertura "repetidora-cerro-otto.kmz".
    """
    # Slug ASCII: saca acentos, deja [a-z0-9-], colapsa separadores.
    base = unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-zA-Z0-9]+", "-", base).strip("-").lower() or "cobertura"
    ascii_name = f"{base}.kmz"

    # Nombre "lindo" en UTF-8 para clientes modernos.
    utf8_name = quote(f"{nombre}.kmz")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"


def _descripcion_params(params: dict) -> str:
    """Arma una descripción legible con los parámetros de la cobertura.

    `params` usa las mismas claves que el resto de la app (lat, lon, txh, erp, f,
    radius, rxh, rt, res). Toleramos que falte alguna con `.get`.
    """
    lineas = [
        f"Frecuencia: {params.get('f')} MHz",
        f"Potencia (ERP): {params.get('erp')} W",
        f"Altura de antena Tx: {params.get('txh')} m",
        f"Altura del receptor Rx: {params.get('rxh')} m",
        f"Radio de análisis: {params.get('radius')} km",
        f"Umbral de recepción: {params.get('rt')} dBm",
    ]
    return "\n".join(lineas)


def _anillo_radio(lat: float, lon: float, radius_km: float, n: int = 72) -> str:
    """Devuelve las coordenadas (lon,lat,0 …) de un círculo del radio dado.

    Aproximación local: 1° lat ≈ 111.32 km; los grados de longitud se achican con
    cos(lat). Suficiente para dibujar el alcance nominal como referencia visual.
    """
    dlat = radius_km / 111.32
    # Evita división por cero cerca de los polos (no aplica en AR, pero por las dudas).
    coslat = max(math.cos(math.radians(lat)), 1e-6)
    dlon = radius_km / (111.32 * coslat)

    puntos = []
    for i in range(n + 1):  # +1 para cerrar el anillo (primer punto == último)
        ang = 2.0 * math.pi * i / n
        plon = lon + dlon * math.cos(ang)
        plat = lat + dlat * math.sin(ang)
        puntos.append(f"{_fmt(plon)},{_fmt(plat)},0")
    return " ".join(puntos)


def _build_kml(bbox: Bbox, params: dict, nombre: str) -> str:
    """Arma el texto del doc.kml.

    OJO con el orden del bbox (es el lugar clásico donde se transpone): la
    convención interna es (oeste, sur, este, norte). El <LatLonBox> exige
    north=lat máx, south=lat mín, east=lon máx, west=lon mín. La imagen NO se
    voltea: el PNG es north-up (fila 0 = norte), igual que el overlay del mapa web.
    """
    west, south, east, north = bbox

    nombre_esc = escape(nombre)
    desc_doc = escape(f"{nombre}\n\n{_descripcion_params(params)}\n\n{_ATRIBUCION}")
    desc_tx = escape(_descripcion_params(params))

    lat = params.get("lat")
    lon = params.get("lon")
    radius_km = params.get("radius")

    # Anillo opcional del radio (si tenemos centro y radio válidos).
    anillo = ""
    if lat is not None and lon is not None and radius_km:
        coords = _anillo_radio(float(lat), float(lon), float(radius_km))
        anillo = f"""
    <Placemark>
      <name>Radio {escape(str(radius_km))} km</name>
      <Style>
        <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
        <PolyStyle><fill>0</fill></PolyStyle>
      </Style>
      <Polygon>
        <tessellate>1</tessellate>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>{coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>"""

    # Punto del Tx (solo si tenemos coordenadas).
    placemark_tx = ""
    if lat is not None and lon is not None:
        placemark_tx = f"""
    <Placemark>
      <name>{nombre_esc}</name>
      <description>{desc_tx}</description>
      <Point>
        <coordinates>{_fmt(float(lon))},{_fmt(float(lat))},0</coordinates>
      </Point>
    </Placemark>"""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{nombre_esc}</name>
    <description>{desc_doc}</description>
    <GroundOverlay>
      <name>Cobertura: {nombre_esc}</name>
      <!-- alpha 0xC0 (semitransparente) + blanco: no tiñe el PNG y deja ver el relieve 3D. -->
      <color>c0ffffff</color>
      <Icon>
        <href>{_PNG_ARCNAME}</href>
      </Icon>
      <LatLonBox>
        <north>{_fmt(north)}</north>
        <south>{_fmt(south)}</south>
        <east>{_fmt(east)}</east>
        <west>{_fmt(west)}</west>
      </LatLonBox>
    </GroundOverlay>{placemark_tx}{anillo}
  </Document>
</kml>
"""


def build_kmz(png_bytes: bytes, bbox: Bbox, params: dict, nombre: str) -> bytes:
    """Arma un KMZ (ZIP con doc.kml + files/cobertura.png) y lo devuelve en bytes.

    - `png_bytes`: PNG de la cobertura YA calculado (no se recalcula nada).
    - `bbox`: (oeste, sur, este, norte) de la huella (centro ± radio).
    - `params`: parámetros de la cobertura (lat, lon, txh, erp, f, radius, rxh, rt).
    - `nombre`: nombre de la cobertura (va en <name>/<description>).
    """
    kml = _build_kml(bbox, params, nombre)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # doc.kml comprimido (texto); el PNG va STORED (ya está comprimido).
        zf.writestr("doc.kml", kml)
        zf.writestr(
            zipfile.ZipInfo(_PNG_ARCNAME),
            png_bytes,
            compress_type=zipfile.ZIP_STORED,
        )
    return buffer.getvalue()
