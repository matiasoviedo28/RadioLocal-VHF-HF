"""Descarga masiva de relieve (DEM) por región, para uso 100% offline (CLI).

Arma un "pack" de tiles Copernicus GLO-30 en la caché local (`data/dem/`) para
que después el terreno y el cálculo de cobertura funcionen sin internet. Pensado
para que UNA persona prepare la zona (provincia/país) y comparta `data/dem/`.

La lógica vive en `app.services.pack` (única fuente de verdad): este CLI es solo
una interfaz de línea de comandos. El mismo núcleo lo usan los endpoints del
backend, así que terminal y navegador hacen exactamente lo mismo.

Uso (dentro del contenedor del backend):

    docker compose exec backend python -m app.tools.descargar_region --bbox SUR OESTE NORTE ESTE
    docker compose exec backend python -m app.tools.descargar_region --provincia "tierra del fuego"
    docker compose exec backend python -m app.tools.descargar_region --pais argentina
    docker compose exec backend python -m app.tools.descargar_region --provincia neuquen --concurrency 8
"""

from __future__ import annotations

import argparse
import sys

from app.services import dem, pack


def _imprimir_progreso(estado: dict, evento: dict | None) -> None:
    """Callback de progreso para consola: una línea por tile resuelto."""
    if not evento or not evento.get("tile"):
        return
    etiquetas = {
        "descargado": "descargado",
        "oceano": "océano (sintético)",
        "fallido": "FALLÓ",
    }
    etiqueta = etiquetas.get(evento["categoria"], evento["categoria"])
    print(f"[{estado['done']}/{estado['total']}] {evento['tile']}: {etiqueta}")


def descargar_region(bbox: dem.Bbox, concurrency: int) -> int:
    """Descarga todos los tiles del bbox a la caché. Devuelve un código de salida."""
    tiles = dem.tiles_for_bbox(bbox)
    west, south, east, north = bbox
    print(
        f"Región: bbox (O,S,E,N) = ({west}, {south}, {east}, {north})\n"
        f"Tiles de 1° que la cubren: {len(tiles)}\n"
        f"Caché destino: {dem.dem_dir()}\n"
        f"Concurrencia: {concurrency}\n"
    )

    try:
        resumen = pack.descargar_region_core(
            bbox, concurrency, on_progreso=_imprimir_progreso
        )
    except pack.PackOffline as e:
        print(f"\n✖ {e}", file=sys.stderr)
        return 1

    # --- Resumen + verificación de completitud ---
    print("\n" + "=" * 56)
    print("Resumen de la preparación:")
    print(f"  Descargados : {resumen['descargado']}")
    print(f"  Océano      : {resumen['ocean']}")
    print(f"  Salteados   : {resumen['salteados']} (ya estaban en caché)")
    print(f"  Fallidos    : {resumen['failed']}")
    print("=" * 56)

    if not resumen["completo"]:
        faltan = resumen["faltan"]
        print(
            f"\n✖ Completitud: faltan {len(faltan)} de {resumen['total']} tile(s): "
            f"{faltan}\n  Volvé a correr el mismo comando (es reanudable) para "
            "reintentarlos.",
            file=sys.stderr,
        )
        return 1

    print(f"\n✔ Completitud: los {resumen['total']} tile(s) de la región están en caché.")
    print("  La zona quedó lista para usar terreno y cobertura 100% offline.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.tools.descargar_region",
        description="Descarga masiva de relieve Copernicus GLO-30 por región (pack offline).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    grupo = parser.add_mutually_exclusive_group(required=True)
    grupo.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("SUR", "OESTE", "NORTE", "ESTE"),
        help="Caja de coordenadas en grados: SUR OESTE NORTE ESTE.",
    )
    grupo.add_argument(
        "--provincia",
        type=str,
        help='Nombre de provincia argentina (ej: "tierra del fuego", "neuquen").',
    )
    grupo.add_argument(
        "--pais",
        type=str,
        help="País completo (por ahora solo: argentina).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=6,
        help="Descargas en paralelo (default 6). Ajustá según tu conexión.",
    )
    args = parser.parse_args(argv)

    if args.concurrency < 1:
        raise SystemExit("--concurrency debe ser >= 1.")

    try:
        # resolver_bbox espera el bbox en orden API [SUR, OESTE, NORTE, ESTE],
        # que es justo el orden del argumento --bbox.
        bbox = pack.resolver_bbox(
            provincia=args.provincia, pais=args.pais, bbox=args.bbox
        )
    except pack.PackError as e:
        if args.provincia:
            disponibles = ", ".join(sorted(pack.PROVINCIAS))
            raise SystemExit(f"{e}\nDisponibles: {disponibles}")
        raise SystemExit(str(e))

    return descargar_region(bbox, args.concurrency)


if __name__ == "__main__":
    raise SystemExit(main())
