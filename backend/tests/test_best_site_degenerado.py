"""Guard de regresión de "Mejor ubicación": entradas degeneradas NO deben romper.

Cubre polígonos inválidos (pocos puntos, área nula, puntos alineados) y el
rango de tamaño soportado. Testea las funciones PURAS de geometría (sin tocar
DEM ni el motor RF), así corre rápido y en cualquier lado.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import best_site as bs


def test_menos_de_3_puntos_da_422_no_500():
    try:
        bs.find_best_site([(-32.0, -65.0), (-32.1, -65.1)], bs.BestSiteParams())
        assert False, "esperaba BestSitePolygonInvalido"
    except bs.BestSitePolygonInvalido:
        pass


def test_puntos_alineados_no_forman_area():
    # 3 puntos en línea recta: área nula, no un triángulo.
    poligono = [(-32.0, -65.0), (-32.0, -65.1), (-32.0, -65.2)]
    try:
        bs.find_best_site(poligono, bs.BestSiteParams())
        assert False, "esperaba BestSitePolygonInvalido (área nula)"
    except bs.BestSitePolygonInvalido:
        pass


def test_area_muy_chica_se_rechaza_amable():
    # Triángulo de unos pocos metros de lado: por debajo de DIAGONAL_MIN_KM.
    poligono = [(-32.00000, -65.00000), (-32.00002, -65.00000), (-32.00000, -65.00002)]
    try:
        bs.find_best_site(poligono, bs.BestSiteParams())
        assert False, "esperaba BestSitePolygonInvalido (área chica)"
    except bs.BestSitePolygonInvalido:
        pass


def test_area_muy_grande_se_rechaza_amable():
    # bbox de ~500 km de lado: muy por encima de DIAGONAL_MAX_KM.
    poligono = [(-30.0, -70.0), (-30.0, -65.0), (-25.0, -65.0), (-25.0, -70.0)]
    try:
        bs.find_best_site(poligono, bs.BestSiteParams())
        assert False, "esperaba BestSitePolygonInvalido (área grande)"
    except bs.BestSitePolygonInvalido:
        pass


def test_poligono_valido_no_lanza_por_geometria():
    # Un cuadrado válido de tamaño razonable no debe fallar en la etapa de
    # validación de geometría (puede fallar más adelante por falta de DEM
    # cacheado, que es un BestSiteDEMMissing, no un BestSitePolygonInvalido).
    poligono = [(-32.30, -65.10), (-32.30, -65.00), (-32.20, -65.00), (-32.20, -65.10)]
    try:
        bs.find_best_site(poligono, bs.BestSiteParams())
    except bs.BestSitePolygonInvalido as e:
        assert False, f"no esperaba BestSitePolygonInvalido para un polígono válido: {e}"
    except bs.BestSiteDEMMissing:
        pass  # esperado: no hay DEM cacheado en el entorno de test


def test_diagonal_km_coherente_con_bbox_conocido():
    # ~1° de lat = 111.32 km; a latitud ~-32°, 1° de lon ≈ 111.32*cos(32°) km.
    bbox = (-65.0, -32.0, -64.0, -31.0)
    d = bs._diagonal_km(bbox)
    assert 130.0 < d < 160.0  # diagonal de un cuadrado ~111x94 km


if __name__ == "__main__":
    fallos = 0
    for nombre, fn in sorted(globals().items()):
        if nombre.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"OK  {nombre}")
            except AssertionError as e:
                fallos += 1
                print(f"FALLO  {nombre}: {e}")
    print(f"\n{'TODO OK' if fallos == 0 else str(fallos) + ' FALLO(S)'}")
    sys.exit(1 if fallos else 0)
