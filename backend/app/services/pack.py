"""Núcleo reutilizable de descarga de relieve por región (pack offline).

Es la ÚNICA fuente de verdad de:
- el diccionario de regiones (provincias argentinas + país),
- la lógica de descarga masiva (reanudable, concurrente, con reintentos),
- el estado persistente de la descarga en segundo plano.

Lo usan tanto el CLI (`app.tools.descargar_region`) como los endpoints del backend
(`routers/terrain.py`), para no duplicar lógica.

⚠️ CONVENCIÓN DE BBOX (hay dos órdenes en el sistema, no mezclar):
- **Interno** (`dem.Bbox` y todo `dem.py`): `(oeste, sur, este, norte)` = (W, S, E, N).
- **API/regiones** (entrada de la descarga, salida de `/api/regions`): `[sur, oeste, norte, este]`
  = [S, W, N, E] (mismo orden que el `--bbox` del CLI).
Las conversiones entre ambos viven SOLO acá (`resolver_bbox`, `listar_regiones`).
"""

from __future__ import annotations

import json
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from app.services import dem

# --------------------------------------------------------------------------- #
# Regiones — bboxes en orden INTERNO dem.Bbox: (oeste, sur, este, norte).
# Valores aproximados, generosos: igual se redondean a tiles enteros de 1°.
# --------------------------------------------------------------------------- #
PAIS_ARGENTINA: dem.Bbox = (-73.6, -55.1, -53.6, -21.8)

PROVINCIAS: dict[str, dem.Bbox] = {
    "buenos aires": (-63.4, -41.1, -56.7, -33.2),
    "caba": (-58.55, -34.71, -58.33, -34.53),
    "catamarca": (-69.1, -30.1, -64.9, -25.0),
    "chaco": (-63.5, -28.1, -58.3, -24.0),
    "chubut": (-72.1, -46.1, -63.5, -42.0),
    "cordoba": (-65.8, -35.1, -61.7, -29.4),
    "corrientes": (-59.7, -30.7, -55.6, -27.2),
    "entre rios": (-60.8, -34.1, -57.8, -30.1),
    "formosa": (-62.4, -26.5, -57.5, -22.0),
    "jujuy": (-66.9, -24.6, -64.0, -21.7),
    "la pampa": (-68.3, -39.5, -63.3, -35.0),
    "la rioja": (-69.6, -31.9, -65.9, -27.7),
    "mendoza": (-70.6, -37.6, -66.4, -32.0),
    "misiones": (-56.5, -28.2, -53.6, -25.5),
    "neuquen": (-71.9, -41.1, -68.1, -36.0),
    "rio negro": (-71.9, -42.1, -62.8, -37.5),
    "salta": (-68.6, -26.4, -62.3, -22.0),
    "san juan": (-70.6, -32.9, -66.8, -28.4),
    "san luis": (-67.5, -36.0, -64.8, -31.9),
    "santa cruz": (-73.6, -52.4, -65.7, -46.0),
    "santa fe": (-63.0, -34.1, -59.0, -28.0),
    "santiago del estero": (-65.6, -30.7, -61.6, -25.6),
    "tierra del fuego": (-68.7, -55.1, -63.7, -52.6),
    "tucuman": (-66.2, -28.0, -64.5, -26.0),
}

# Etiqueta legible para el desplegable (Title Case con acentos donde corresponde).
ETIQUETAS: dict[str, str] = {
    "caba": "CABA",
    "cordoba": "Córdoba",
    "entre rios": "Entre Ríos",
    "neuquen": "Neuquén",
    "rio negro": "Río Negro",
    "tucuman": "Tucumán",
}


def _normalizar(nombre: str) -> str:
    """Pasa a minúsculas y saca acentos para buscar provincia de forma tolerante."""
    s = unicodedata.normalize("NFKD", nombre.strip().lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def _etiqueta(clave: str) -> str:
    """Nombre lindo para mostrar (usa ETIQUETAS o Title Case por defecto)."""
    return ETIQUETAS.get(clave, clave.title())


def listar_regiones() -> list[dict]:
    """Provincias disponibles para el desplegable del frontend.

    Devuelve `[{clave, nombre, bbox:[sur, oeste, norte, este]}]` (orden API).
    """
    salida = []
    for clave in sorted(PROVINCIAS):
        w, s, e, n = PROVINCIAS[clave]
        salida.append(
            {"clave": clave, "nombre": _etiqueta(clave), "bbox": [s, w, n, e]}
        )
    return salida


# --------------------------------------------------------------------------- #
# Errores de dominio del pack
# --------------------------------------------------------------------------- #
class PackError(Exception):
    """Error genérico de la descarga por región."""


class PackBusy(PackError):
    """Ya hay una descarga en curso (una sola a la vez)."""


class PackOffline(PackError):
    """Hay tiles para bajar pero no hay conexión al bucket."""


# --------------------------------------------------------------------------- #
# Resolución de región -> bbox interno (oeste, sur, este, norte)
# --------------------------------------------------------------------------- #
def resolver_bbox(
    provincia: str | None = None,
    pais: str | None = None,
    bbox: list[float] | None = None,
) -> dem.Bbox:
    """Determina el bbox INTERNO (oeste, sur, este, norte) según lo recibido.

    `bbox` (si llega) viene en orden API: [sur, oeste, norte, este].
    """
    if pais:
        if _normalizar(pais) != "argentina":
            raise PackError(f"País no reconocido: {pais!r}. Disponible: argentina.")
        return PAIS_ARGENTINA

    if provincia:
        clave = _normalizar(provincia)
        if clave not in PROVINCIAS:
            raise PackError(f"Provincia no reconocida: {provincia!r}.")
        return PROVINCIAS[clave]

    if bbox is not None:
        if len(bbox) != 4:
            raise PackError("bbox debe tener 4 valores: [sur, oeste, norte, este].")
        sur, oeste, norte, este = bbox
        if oeste >= este or sur >= norte:
            raise PackError("bbox inválido: se requiere OESTE<ESTE y SUR<NORTE.")
        return (oeste, sur, este, norte)  # -> orden interno (W, S, E, N)

    raise PackError("Indicá una región: provincia, país o bbox.")


# --------------------------------------------------------------------------- #
# Descarga de un tile con reintentos (reusa dem.download_tile)
# --------------------------------------------------------------------------- #
def _descargar_con_reintentos(tid: str, reintentos: int = 4) -> str:
    """Descarga (o sintetiza) un tile, con backoff ante fallos transitorios.

    Devuelve "oceano" | "descargado". Lanza la última excepción si agota intentos.
    """
    # Clasificación previa: un tile fuera del bucket es océano (sintético, local).
    es_oceano = not dem._tile_in_bucket(tid)

    ultimo_error: Exception | None = None
    for intento in range(1, reintentos + 1):
        try:
            dem.download_tile(tid)
            return "oceano" if es_oceano else "descargado"
        except dem.DEMDownloadError as e:
            ultimo_error = e
            if intento < reintentos:
                # Backoff lineal y prolijo (S3 no tiene rate limit, pero no abusamos).
                import time

                time.sleep(1.5 * intento)
    assert ultimo_error is not None
    raise ultimo_error


# --------------------------------------------------------------------------- #
# Núcleo de descarga por región (lo comparten CLI y endpoint)
# --------------------------------------------------------------------------- #
# El callback de progreso recibe (estado, evento). `evento` es None salvo por
# tile, donde trae {"tile": tid, "categoria": "descargado"|"oceano"|"fallido"}.
ProgresoCb = Callable[[dict, dict | None], None]


def descargar_region_core(
    bbox: dem.Bbox, concurrency: int = 6, on_progreso: ProgresoCb | None = None
) -> dict:
    """Descarga todos los tiles del bbox a la caché. Reanudable y concurrente.

    Llama `on_progreso(estado, evento)` al inicio y tras cada tile. Devuelve un
    resumen final: {total, descargado, ocean, salteados, failed, faltan, completo}.
    """
    tiles = dem.tiles_for_bbox(bbox)
    total = len(tiles)
    pendientes = [t for t in tiles if not dem.is_cached(t)]
    salteados = total - len(pendientes)

    # `done` cuenta TODO lo resuelto (salteados + procesados): así la barra refleja
    # de entrada lo ya cacheado (reanudable = arranca casi llena).
    estado = {
        "total": total,
        "done": salteados,
        "ocean": 0,
        "descargado": 0,
        "failed": 0,
        "salteados": salteados,
        "current": None,
        "message": "",
    }

    def emit(evento: dict | None = None) -> None:
        if on_progreso:
            on_progreso(dict(estado), evento)

    if not pendientes:
        estado["message"] = "La región ya estaba completa."
        emit()
        return _resumen(estado, [])

    if not dem.is_online():
        raise PackOffline(
            "Sin conexión al bucket de Copernicus. Conectate a internet para "
            "armar el pack (la descarga es la única parte que pide red)."
        )

    estado["message"] = f"Preparando {len(pendientes)} tile(s)…"
    emit()

    fallidos: list[str] = []

    def trabajo(tid: str) -> tuple[str, str]:
        try:
            return tid, _descargar_con_reintentos(tid)
        except Exception as e:  # noqa: BLE001 — queremos seguir con el resto
            return tid, f"error:{e}"

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futuros = {pool.submit(trabajo, t): t for t in pendientes}
        for fut in as_completed(futuros):
            tid, resultado = fut.result()
            estado["done"] += 1
            estado["current"] = tid
            if resultado == "descargado":
                estado["descargado"] += 1
                categoria = "descargado"
            elif resultado == "oceano":
                estado["ocean"] += 1
                categoria = "oceano"
            else:
                estado["failed"] += 1
                fallidos.append(tid)
                categoria = "fallido"
            emit({"tile": tid, "categoria": categoria})

    faltan = [t for t in tiles if not dem.is_cached(t)]
    estado["message"] = (
        "Completo." if not faltan else f"Faltan {len(faltan)} tile(s)."
    )
    emit()
    return _resumen(estado, faltan)


def _resumen(estado: dict, faltan: list[str]) -> dict:
    """Arma el dict de resumen final a partir del estado acumulado."""
    return {
        "total": estado["total"],
        "descargado": estado["descargado"],
        "ocean": estado["ocean"],
        "salteados": estado["salteados"],
        "failed": estado["failed"],
        "faltan": faltan,
        "completo": not faltan,
    }


# --------------------------------------------------------------------------- #
# Estado persistente de la descarga en segundo plano (robusto ante polls)
# --------------------------------------------------------------------------- #
_STATUS_FILE = "_download_status.json"
_STALE_S = 180  # si el estado "running" no se actualiza en este tiempo, está colgado
_LOCK = threading.Lock()


def status_path() -> Path:
    """Ruta del archivo de estado (junto a la caché de tiles)."""
    return dem.dem_dir() / _STATUS_FILE


def _estado_idle() -> dict:
    return {
        "state": "idle",
        "total": 0,
        "done": 0,
        "ocean": 0,
        "failed": 0,
        "current": None,
        "message": "",
        "updated_at": None,
        "started_at": None,
        "bbox": None,
    }


def read_status() -> dict:
    """Lee el estado persistido (o uno 'idle' si no existe / está corrupto)."""
    p = status_path()
    if not p.exists():
        return _estado_idle()
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _estado_idle()


def write_status(st: dict) -> None:
    """Persiste el estado, sellando `updated_at`."""
    st["updated_at"] = datetime.now(timezone.utc).isoformat()
    status_path().write_text(
        json.dumps(st, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def is_running() -> bool:
    """True si hay una descarga realmente en curso (con detección de cuelgue)."""
    st = read_status()
    if st.get("state") != "running":
        return False
    ts = st.get("updated_at")
    if ts:
        try:
            last = datetime.fromisoformat(ts)
            if (datetime.now(timezone.utc) - last).total_seconds() > _STALE_S:
                return False  # quedó colgado por un crash: lo tratamos como libre
        except ValueError:
            pass
    return True


def iniciar_descarga_async(bbox: dem.Bbox, concurrency: int = 6) -> dict:
    """Dispara la descarga del bbox en un thread daemon y vuelve al toque.

    Lanza PackBusy si ya hay una corriendo. Devuelve el estado inicial.
    """
    with _LOCK:
        if is_running():
            raise PackBusy("Ya hay una descarga en curso.")
        total = len(dem.tiles_for_bbox(bbox))
        st = _estado_idle()
        st.update(
            {
                "state": "running",
                "total": total,
                "message": "Iniciando…",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "bbox": list(bbox),  # se guarda en orden interno (W, S, E, N)
            }
        )
        write_status(st)

    hilo = threading.Thread(
        target=_runner, args=(bbox, concurrency), daemon=True
    )
    hilo.start()
    return read_status()


def _runner(bbox: dem.Bbox, concurrency: int) -> None:
    """Cuerpo del thread: corre el core y va persistiendo el estado."""

    def on_prog(estado: dict, evento: dict | None) -> None:
        st = read_status()
        st.update(
            {
                "state": "running",
                "total": estado["total"],
                "done": estado["done"],
                "ocean": estado["ocean"],
                "failed": estado["failed"],
                "current": estado.get("current"),
                "message": estado.get("message", ""),
            }
        )
        write_status(st)

    try:
        resumen = descargar_region_core(bbox, concurrency, on_progreso=on_prog)
        st = read_status()
        st["done"] = resumen["total"] - len(resumen["faltan"])
        st["failed"] = resumen["failed"]
        if resumen["completo"]:
            st["state"] = "done"
            st["message"] = "Descarga completa."
        else:
            # Reanudable: quedan faltantes (típicamente por fallos transitorios).
            st["state"] = "error"
            st["message"] = (
                f"Quedaron {len(resumen['faltan'])} tile(s) sin bajar. "
                "Reintentá (es reanudable)."
            )
        st["current"] = None
        write_status(st)
    except PackOffline as e:
        st = read_status()
        st["state"] = "error"
        st["message"] = str(e)
        st["current"] = None
        write_status(st)
    except Exception as e:  # noqa: BLE001 — el estado SIEMPRE debe quedar consistente
        st = read_status()
        st["state"] = "error"
        st["message"] = f"Error inesperado: {e}"
        st["current"] = None
        write_status(st)
