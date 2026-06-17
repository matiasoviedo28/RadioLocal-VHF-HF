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
    app_version: str = "0.5.1"  # Recalibración del techo síncrono (~100 km, timeout 280s)

    # Entorno de ejecución: "dev" | "prod"
    env: str = "dev"

    # Orígenes permitidos para CORS (el frontend en :8080).
    # Se mantiene permisivo en desarrollo; ajustar en producción.
    cors_origins: list[str] = ["*"]

    # --- Fase 1: relieve / terreno ---
    # API key de OpenTopography (gratuita). NUNCA se commitea: va en .env.
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

    model_config = SettingsConfigDict(
        env_prefix="RADIOLOCAL_",
        env_file=".env",
        populate_by_name=True,
        extra="ignore",
    )


# Instancia única reutilizable en toda la app.
settings = Settings()
