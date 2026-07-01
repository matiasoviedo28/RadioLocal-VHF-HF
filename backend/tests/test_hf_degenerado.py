"""Guard de regresión del bugfix HF: entradas degeneradas NO deben romper (500).

Cubre la clase entera de casos que provocaban ZeroDivisionError / 500:
  - área muy chica (colapsaba la grilla a 1 punto -> bbox de extensión 0),
  - bbox degenerado con alto o ancho ~0,
  - grilla de valores uniformes (todo el mismo BCR, ej. 100 %).

Testea las funciones PURAS (sin correr el binario ni la red), así es rápido y
corre en cualquier lado. Se puede ejecutar con pytest o directo:
    python -m app... no; desde backend/:  python tests/test_hf_degenerado.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Permite `python tests/test_hf_degenerado.py` desde backend/ sin instalar el paquete.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from app.services import hf_coverage as hf


def test_area_muy_chica_da_422_no_500():
    # Bbox diminuto (< incremento mínimo en ambas dimensiones): defensa en profundidad
    # del guard anti-degenerado (ya no llega por la API, que ahora usa range_km).
    bbox = (-65.02, -32.36, -65.00, -32.34)
    try:
        hf._derivar_incremento(bbox, None)
        assert False, "esperaba HFCoverageNotPossible (422), no siguió"
    except hf.HFCoverageNotPossible:
        pass  # OK: rechazo amable, no 500


def test_bbox_degenerado_alto_o_ancho_cero():
    # Ancho 0 (oeste == este) y alto 0 (sur == norte): degenerados.
    for bbox in (
        (-65.0, -38.0, -65.0, -26.0),   # ancho 0
        (-72.0, -32.0, -58.0, -32.0),   # alto 0
    ):
        try:
            hf._derivar_incremento(bbox, None)
            assert False, "esperaba HFCoverageNotPossible para bbox degenerado"
        except hf.HFCoverageNotPossible:
            pass


def test_bbox_centrado_alcances_coherentes():
    # Área centrada en el Tx: Regional < Continental < DX, y NO depende del zoom.
    tx_lat, tx_lon = -32.35, -65.01
    anchos = []
    for km in (2000.0, 4000.0, 7000.0):
        w, s, e, n = hf._bbox_centrado(tx_lat, tx_lon, km)
        # El Tx queda centrado (salvo clamp), lat dentro de rango, lon clipeado.
        assert -85.0 <= s < n <= 85.0
        assert -180.0 <= w < e <= 180.0
        anchos.append(e - w)
    assert anchos[0] < anchos[1] < anchos[2], "Regional < Continental < DX"


def test_dx_no_supera_el_cap_de_puntos():
    # El alcance más grande (DX) debe entrar en hf_max_points con la grilla derivada.
    bbox = hf._bbox_centrado(-32.35, -65.01, 7000.0)
    inc = hf._derivar_incremento(bbox, None)
    w, s, e, n = bbox
    n_lat = int((n - s) / inc) + 1
    n_lon = int((e - w) / inc) + 1
    assert n_lat * n_lon <= hf.settings.hf_max_points


def test_tamano_raster_no_divide_por_cero():
    # Aunque los guards ya lo evitan, la función debe blindarse sola.
    assert hf._tamano_raster((-65.0, -32.0, -65.0, -32.0)) == (
        hf.settings.hf_raster_max_px, hf.settings.hf_raster_max_px
    )  # bbox de un punto -> raster cuadrado, sin excepción


def test_valores_uniformes_no_rompen_colormap():
    # Grilla toda 100 % (min == max): el colormap discreto NO normaliza por min/max.
    grid = np.full((5, 6), 100.0, dtype="float32")
    r, g, b, a = hf._colormap_bcr(grid)
    # Todo debe caer en la banda "fuerte" (verde #1a9850) sin dividir por nada.
    assert (r == 0x1A).all() and (g == 0x98).all() and (b == 0x50).all()
    assert (a == 230).all()


def test_area_valida_deriva_grilla_multipunto():
    # Sanidad: un área normal sigue derivando una grilla razonable (>=2x2).
    bbox = (-72.0, -38.0, -58.0, -26.0)
    inc = hf._derivar_incremento(bbox, None)
    w, s, e, n = bbox
    n_lat = int((n - s) / inc) + 1
    n_lon = int((e - w) / inc) + 1
    assert n_lat >= 2 and n_lon >= 2


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
