"""Configuración centralizada del backend.

Toda la configuración se lee desde variables de entorno (con valores por
defecto razonables) usando pydantic-settings. Acá vive la versión que expone
el endpoint /api/version.
"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Ajustes de la aplicación, sobreescribibles por entorno.

    Prefijo general de entorno: RADIOLOCAL_ (p. ej. RADIOLOCAL_ENV).
    La API key de OpenTopography es la excepción: se lee de
    OPENTOPOGRAPHY_API_KEY (sin prefijo) vía alias explícito.
    """

    # Identidad de la aplicación
    app_name: str = "RadioLocal-VHF-HF"
    app_version: str = "1.3.3"  # 1.3.3: Mejor ubicación + lanzador Windows

    # Entorno de ejecución: "dev" | "prod"
    env: str = "dev"

    # Orígenes permitidos para CORS (el frontend en :8080).
    # Se mantiene permisivo en desarrollo; ajustar en producción.
    cors_origins: list[str] = ["*"]

    # --- Fase 1: relieve / terreno ---
    # Fuente del DEM:
    #   "s3"            -> bucket público AWS de Copernicus GLO-30 (default, SIN API key).
    #   "opentopography"-> fallback opcional vía OpenTopography (requiere API key).
    # El cambio es reversible: ambos sirven el MISMO dato (Copernicus GLO-30, 30 m),
    # así que el relieve/cobertura salen idénticos cualquiera sea la fuente.
    dem_source: str = "s3"

    # Bucket público de Copernicus GLO-30 en el AWS Open Data registry (descarga
    # anónima por HTTPS, sin credenciales). Los tiles ya son COG.
    #   tile: {base}/Copernicus_DSM_COG_10_S42_00_W072_00_DEM/<mismo>.tif
    #   lista de tiles existentes (autoridad de "qué hay"): {base}/tileList.txt
    copernicus_s3_base: str = "https://copernicus-dem-30m.s3.amazonaws.com"

    # API key de OpenTopography (gratuita). OPCIONAL: solo se usa si
    # dem_source="opentopography". NUNCA se commitea: va en .env.
    # Alias explícito: se lee de OPENTOPOGRAPHY_API_KEY (sin prefijo RADIOLOCAL_).
    opentopography_api_key: str = Field(default="", alias="OPENTOPOGRAPHY_API_KEY")
    opentopography_url: str = "https://portal.opentopography.org/API/globaldem"

    # Tipo de DEM: COP30 = Copernicus GLO-30 (~30 m de resolución).
    dem_demtype: str = "COP30"

    # Carpeta de caché de tiles DEM (COGs). Montada como volumen en Docker.
    dem_dir: str = "/app/data/dem"

    # Tope de tiles por request de "prepare". Alineado para cubrir una huella de
    # cobertura de hasta 200 km (~36 tiles) con margen; el guard evita descargas
    # accidentales tipo país entero.
    dem_max_tiles_per_request: int = 64

    # --- Fase 2: motor RF (Signal-Server) ---
    # Binario compilado en la imagen (variante LIDAR: lee ASCII grid vía -lid).
    signalserver_bin: str = "/usr/local/bin/signalserverLIDAR"

    # Timeout (s) de una corrida de cobertura: corre síncrono en el backend.
    # 280s = justo debajo de los 300s de nginx (el backend corta primero, con
    # mensaje propio). Antes era 120s, que cortaba radios viables desde ~70 km.
    coverage_timeout_s: int = 280

    # Tope DURO de radio (km) en el modelo SÍNCRONO actual. El cómputo ITM a
    # resolución nativa tarda ~radio²; a 300s de nginx el techo real es ~100 km.
    # Radios mayores quedan para la fase de worker asíncrono (próxima versión).
    coverage_max_radius_km: float = 100.0

    # Carpeta de coberturas guardadas (respaldo en disco). Persistida por el volumen.
    coverages_dir: str = "/app/data/coverages"

    # --- Fase HF: motor de propagación HF (ITURHFProp, ITU-R P.533) ---
    # Binario y datos compilados/empaquetados en la imagen (stage builder-hf).
    hf_bin: str = "/usr/local/bin/ITURHFProp"
    hf_data_path: str = "/opt/hf/data/"  # coeficientes CCIR + mapas ionosféricos

    # Timeout (s) de una corrida de área HF. El motor es MUY rápido (~2,5 ms/punto,
    # medido en el spike HF-0), así que 60s es holgado incluso para grillas grandes.
    hf_timeout_s: int = 60

    # Guard de tamaño de grilla: tope de puntos (n_lat*n_lon) de una corrida
    # síncrona. ~40×40 = 1600 puntos ≈ 4s. Áreas que no entren ni con el incremento
    # máximo razonable se rechazan con 422.
    hf_max_points: int = 1600

    # Lado máximo (px) del raster de salida tras interpolar la grilla gruesa.
    hf_raster_max_px: int = 1024

    # --- Alcance del área HF (radio en km, CENTRADA en el Tx; NO depende del zoom) ---
    # Presets que ofrece la UI (mismos valores en el <select> del frontend):
    #   Regional ~2000 km · Continental ~4000 km (default) · DX/Largo ~7000 km.
    # El backend recibe range_km y lo valida contra [min, max]. Ajustables acá.
    hf_range_default_km: float = 4000.0
    hf_range_min_km: float = 100.0
    hf_range_max_km: float = 8000.0

    # SSN (número de manchas solares R12) por defecto. Fallback OFFLINE cuando no
    # hay red ni caché de NOAA, o el mes pedido está fuera del pronóstico.
    hf_default_ssn: int = 100

    # Fuente del SSN: pronóstico mensual de NOAA/SWPC (keyless, sin API key).
    # Array de objetos con campos "time-tag" ("YYYY-MM") y "predicted_ssn".
    hf_ssn_url: str = (
        "https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json"
    )
    # Caché del JSON (persistida por el volumen ./data, gitignoreada como el DEM).
    hf_ssn_cache_path: str = "/app/data/ssn/predicted-solar-cycle.json"
    # TTL de la caché: el archivo de NOAA se actualiza mensual, 7 días sobra.
    hf_ssn_ttl_days: int = 7

    model_config = SettingsConfigDict(
        env_prefix="RADIOLOCAL_",
        env_file=".env",
        populate_by_name=True,
        extra="ignore",
    )


# Instancia única reutilizable en toda la app.
settings = Settings()
