// Internacionalización (i18n) del frontend de RadioLocal-VHF-HF.
//
// Solo alcance VISUAL del frontend: los mensajes de error que vienen del
// backend (`detail` de las respuestas HTTP) siguen en español a propósito —
// no se tocan acá. Ver ARQUITECTURA.md si en el futuro se decide traducirlos.
//
// Arquitectura: diccionario de claves por idioma (objeto plano, sin build step
// ni librería). El HTML marca qué traducir con `data-i18n="clave"` (reemplaza
// textContent) y `data-i18n-attrs='{"attr":"clave", ...}'` (reemplaza atributos
// como aria-label/title/placeholder). `aplicarIdioma()` recorre el DOM aplicando
// el diccionario activo; se llama al cargar y cada vez que cambia el idioma.
//
// Contenido generado por JS en runtime (selects de mes/alcance HF, contador de
// puntos del perímetro, texto del tour, mensajes de estado dinámicos, etc.) usa
// la función `t(clave, vars)` directamente en `app.js`, y se re-renderiza al
// cambiar de idioma vía `onCambioIdioma(fn)` (patrón simple de suscripción).
//
// Persistencia: misma convención que el resto de la app (`radiolocal_*` en
// localStorage, acceso directo sin capa de abstracción). Default: español.

const LS_IDIOMA = "radiolocal_idioma";

const IDIOMAS_DISPONIBLES = [
  { clave: "es", nombre: "Español" },
  { clave: "en", nombre: "English" },
  { clave: "zh", nombre: "中文" },
];

// --------------------------------------------------------------------------
// Diccionario. ES es la fuente canónica (todo el texto original de la app
// vivía en español); EN y ZH son traducciones idiomáticas, no literales.
// --------------------------------------------------------------------------
const IDIOMAS = {
  es: {
    // --- Topbar ---
    topbar_subtitulo: "Planificación de cobertura de radio · Argentina",
    topbar_tablist_aria: "Modo de cobertura",
    modo_vhf: "VHF",
    modo_hf: "HF",
    modo_mejor: "Mejor ubicación",
    relieve_label: "Relieve",
    relieve_mostrar: "Mostrar relieve",
    relieve_ocultar: "Ocultar relieve",
    offline_label: "Descargar zona",
    offline_title: "Descargá el terreno de un área para calcular cobertura, también sin internet.",
    ayuda_title: "Abrir la guía paso a paso",
    idioma_title: "Cambiar idioma",

    // --- Campos compartidos entre paneles (mismo texto en VHF/HF/Mejor ubicación) ---
    campo_lat: "Lat",
    campo_lon: "Lon",
    tip_latlon: "Ubicación del transmisor en grados decimales (WGS84). Ej: -32.34, -65.01",
    campo_rxh: "Rx h (m)",
    tip_rxh: "Altura de la antena receptora sobre el suelo, en metros. Handy ~1,5; móvil ~2. Ej: 1.5",
    campo_erp: "ERP (W)",
    campo_frec: "Frec (MHz)",
    campo_umbral: "Umbral (dBm)",

    // --- Panel VHF ---
    vhf_titulo: "Cobertura VHF",
    vhf_ayuda: "Click en el mapa para ubicar el transmisor.",
    vhf_aviso_zoom: "Acercá el mapa para calcular cobertura.",
    vhf_campo_txh: "Tx h (m)",
    vhf_tip_txh: "Altura de la antena del transmisor SOBRE EL SUELO (no sobre el nivel del mar), en metros. Ej: 25",
    vhf_tip_erp: "Potencia radiada efectiva (ERP) en watts = potencia del equipo × ganancia de antena − pérdidas de línea. Si cargás solo la potencia del equipo, el cálculo es conservador. Ej: 25",
    vhf_tip_frec: "Frecuencia del transmisor en MHz. Ej: 150 (banda VHF)",
    vhf_campo_radio: "Radio (km)",
    vhf_tip_radio: "Distancia máxima a calcular desde el transmisor, en km. Más grande = más lento. Ej: 40",
    vhf_tip_umbral: "Señal mínima que el receptor necesita para tener cobertura, en dBm. Más negativo = receptor más sensible = más cobertura. Un VHF típico ronda -100 a -116. Ej: -100",
    vhf_campo_res: "Res (px)",
    vhf_tip_res: "Detalle del cálculo en píxeles. Más alto = más detalle y más lento.",
    vhf_btn_calcular: "Calcular cobertura",
    vhf_btn_guardar: "Guardar cobertura",
    vhf_btn_exportar: "Exportar a Google Earth",
    vhf_guardadas_titulo: "Coberturas guardadas",
    vhf_guardadas_vacio: "Todavía no guardaste ninguna.",

    // --- Panel HF ---
    hf_titulo: "Cobertura HF",
    hf_ayuda: "Hacé clic en el mapa para ubicar tu estación.",
    hf_campo_banda: "Banda",
    hf_tip_banda: "Banda de HF a analizar. Cada banda se calcula en una frecuencia representativa. Elegí 'Otra' para cargar una frecuencia exacta en MHz.",
    hf_opcion_otra: "Otra frecuencia (MHz)…",
    hf_tip_frecotra: "Frecuencia exacta en MHz (1.6 a 30).",
    hf_campo_alcance: "Alcance",
    hf_tip_alcance: "Tamaño del área a analizar, centrada en tu estación. La cobertura HF es de larga distancia; el área NO depende del zoom del mapa.",
    hf_alcance_regional: "Regional (~2000 km)",
    hf_alcance_continental: "Continental (~4000 km)",
    hf_alcance_dx: "DX / Largo (~7000 km)",
    hf_campo_mes: "Mes",
    hf_tip_mes: "Mes del año a analizar (la propagación HF cambia mucho por estación).",
    hf_campo_hora: "Hora UTC",
    hf_tip_hora: "Hora UTC (0 a 23). La propagación HF cambia mucho entre día y noche.",
    hf_ssn_prefijo: "SSN",
    hf_ssn_cargando: "SSN …",
    hf_ssn_sin_datos: "SSN — · sin datos",
    hf_ssn_usado: "SSN usado: {val} · {fuente}",
    hf_avanzado: "Avanzado",
    hf_campo_ssn: "SSN",
    hf_tip_ssn: "Número de manchas solares (R12). Si lo dejás vacío, se toma el pronóstico de NOAA para el mes elegido.",
    hf_ssn_placeholder: "auto",
    hf_campo_ruido: "Ruido",
    hf_tip_ruido: "Ambiente de ruido man-made en el receptor. Rural es un buen default general.",
    hf_ruido_ciudad: "Ciudad",
    hf_ruido_residencial: "Residencial",
    hf_ruido_rural: "Rural",
    hf_ruido_rural_silencioso: "Rural silencioso",
    hf_btn_calcular: "Calcular cobertura HF",
    hf_leyenda_titulo: "Fiabilidad del circuito",
    hf_leyenda_fuerte: "Fuerte (≥ 90 %)",
    hf_leyenda_buena: "Buena (75–90 %)",
    hf_leyenda_marginal: "Marginal (50–75 %)",
    hf_leyenda_baja: "Baja (< 50 %)",
    hf_leyenda_nota: "La baja fiabilidad cerca del transmisor en ciertas bandas/horas es normal (zona de silencio), no un error.",
    hf_fuente_noaa: "pronóstico NOAA",
    hf_fuente_manual: "valor manual",
    hf_fuente_default: "valor por defecto (sin conexión)",
    hf_frecuencia_invalida: "Ingresá una frecuencia válida.",
    hf_calculando: "Calculando cobertura HF…",
    hf_error_prefijo: "Cobertura HF: ",

    mes_1: "enero", mes_2: "febrero", mes_3: "marzo", mes_4: "abril",
    mes_5: "mayo", mes_6: "junio", mes_7: "julio", mes_8: "agosto",
    mes_9: "septiembre", mes_10: "octubre", mes_11: "noviembre", mes_12: "diciembre",

    // --- Panel Mejor ubicación ---
    mejor_titulo: "Mejor ubicación",
    mejor_ayuda: "Dibujá el perímetro de la zona que querés cubrir: click en el mapa para agregar puntos. Con 3 o más puntos, cerrá el área (o directo \"Buscar mejor ubicación\": si no la cerraste, se cierra sola).",
    mejor_contador: "Puntos dibujados: {n}",
    mejor_btn_cerrar: "Cerrar área",
    mejor_btn_reiniciar: "Reiniciar",
    mejor_campo_txh: "Tx h (m)",
    mejor_tip_txh: "Altura de la antena de la repetidora SOBRE EL SUELO (no sobre el nivel del mar), en metros. Ej: 25",
    mejor_tip_erp: "Potencia radiada efectiva (ERP) en watts. Ej: 25",
    mejor_tip_frec: "Frecuencia de la repetidora en MHz. Ej: 150 (banda VHF)",
    mejor_tip_umbral: "Señal mínima que el receptor necesita para tener cobertura, en dBm. Ej: -100",
    mejor_btn_calcular: "Buscar mejor ubicación",
    mejor_buscando: "Buscando el mejor punto (corre varias cobertura de prueba, puede tardar)…",
    mejor_puntos_insuficientes: "Dibujá al menos 3 puntos para definir el área.",
    mejor_resultado: "Mejor punto: {lat}, {lon} · cubre ~{score}% del área dibujada.",
    mejor_error_prefijo: "Mejor ubicación: ",
    mejor_area_grande: "El área de búsqueda abarca {n} tiles (máx. {max}). Dibujá un perímetro más chico.",
    mejor_zona_no_preparada_grande: "La zona de esta búsqueda no está preparada (faltan {faltan} tile/s).\n\nVas a descargar ~{n} tiles (~{gb} GB), puede tardar. ¿Continuar?",
    mejor_zona_no_preparada_chica: "La zona de esta búsqueda no está preparada (faltan {faltan} tile/s).\n\n¿Preparar el área ahora ({n} tile/s, requiere internet)?",
    mejor_preparando: "Preparando el área de búsqueda: {n} tile(s)…",
    mejor_buscando_de_nuevo: "Buscando el mejor punto…",

    // --- Panel Descargar zona / offline ---
    off_titulo: "Descargar zona",
    off_ayuda: "Descargá el relieve de la vista actual o de una provincia para usar el mapa y el cálculo sin internet.",
    off_btn_vista: "Descargar la vista actual",
    off_label_provincia: "Provincia",
    off_btn_provincia: "Descargar provincia",
    off_btn_reintentar: "Reintentar faltantes",
    off_zonas_titulo: "Zonas disponibles offline",
    off_check_mostrar: "Mostrar en el mapa",
    off_check_oceano: "Incluir océano",
    off_leyenda_tierra: "Tierra",
    off_leyenda_oceano: "Océano",
    off_resumen: "{tiles} tiles en caché · {mb} MB en disco",
    off_iniciando_descarga: "Iniciando descarga (~{n} tiles, ~{gb} GB)…",
    off_descarga_en_curso: "Ya hay una descarga en curso. Esperá a que termine.",
    off_descarga_no_iniciada: "No se pudo iniciar: {motivo}",
    off_descarga_red_error: "No se pudo iniciar la descarga (red).",
    off_descarga_grande_confirm: "Vas a descargar ~{n} tiles (~{gb} GB). Es una descarga grande (escala país). ¿Continuar?",
    off_progreso_tiles: "{done}/{total} tiles",
    off_progreso_oceano: "océano {n}",
    off_progreso_fallidos: "fallidos {n}",

    // --- Modal API key ---
    apikey_titulo: "API key de OpenTopography",
    apikey_mensaje_falta: "No tenés una API key de OpenTopography configurada. Si no tenés una, creala gratis.",
    apikey_mensaje_invalida: "Tu API key parece inválida, revisala. Pegá una clave válida de OpenTopography.",
    apikey_link_crear: "Crear cuenta gratis",
    apikey_link_guia: "Guía paso a paso",
    apikey_label_pegar: "Pegá tu API key",
    apikey_placeholder: "Tu clave de OpenTopography",
    apikey_ver_aria: "Mostrar u ocultar la clave",
    apikey_ver_title: "Mostrar/ocultar",
    apikey_btn_cerrar: "Cerrar",
    apikey_btn_guardar: "Guardar",
    apikey_falta_antes_guardar: "Pegá tu API key antes de guardar.",
    apikey_guardada: "API key guardada. Probá \"Descargar zona\".",

    // --- Modal Guardar cobertura ---
    guardar_titulo: "Guardar cobertura",
    guardar_label_nombre: "Nombre",
    guardar_placeholder: "Ej: Repetidora Cerro Otto",
    guardar_btn_cancelar: "Cancelar",
    guardar_btn_ok: "Guardar",

    // --- Modal Relieve no disponible ---
    relieve_modal_titulo: "Relieve no disponible",
    relieve_modal_texto: "Primero descargá la zona para ver el relieve.",
    relieve_modal_cerrar: "Cerrar",
    relieve_modal_descargar: "Descargar zona",

    // --- Tour guiado ---
    tour_omitir: "Omitir tutorial",
    tour_anterior: "Anterior",
    tour_siguiente: "Siguiente",
    tour_finalizar: "Finalizar",
    tour_paso_contador: "Paso {n} de {total}",
    tour_paso_0: "Bienvenido a RadioLocal-VHF-HF. En 4 pasos planificás una cobertura de radio. Podés omitir esta guía cuando quieras.",
    tour_paso_1: "1) Descargá tu zona. Bajá el terreno del área donde vas a trabajar; una vez descargada, funciona incluso sin internet. Al lado, con el botón 🌐 podés cambiar el idioma de la app.",
    tour_paso_2: "2) Ubicá tu estación. Hacé clic en el mapa donde está tu antena y completá los datos de tu equipo. Las 'i' te explican cada dato.",
    tour_paso_3: "3) Calculá la cobertura. El mapa te muestra hasta dónde llega tu señal.",
    tour_paso_4: "4) Mirá el relieve. Activalo para ver el terreno del área.",
    tour_paso_5: "Guardá y compará. Podés guardar coberturas y superponerlas para compararlas.",
    tour_paso_6: "¡Listo! Reabrí esta guía cuando quieras con el botón ?.",

    // --- Mensajes de estado / errores genéricos (JS) ---
    generando_relieve: "Generando relieve…",
    relieve_error_prefijo: "Relieve: ",
    calculando_cobertura: "Calculando cobertura (puede tardar varios segundos)…",
    radio_max_msg: "Por ahora el máximo es {max} km. Los radios mayores llegan con el procesamiento en segundo plano (próxima versión).",
    radio_grande_confirm: "Radio grande ({km} km): puede tardar un par de minutos. ¿Continuar?",
    cobertura_area_grande: "La cobertura abarca {n} tiles (máx. {max}). Reducí el radio.",
    vhf_zona_no_preparada_grande: "La zona de esta cobertura no está preparada (faltan {faltan} tile/s).\n\nVas a descargar ~{n} tiles (~{gb} GB), puede tardar. ¿Continuar?",
    vhf_zona_no_preparada_chica: "La zona de esta cobertura no está preparada (faltan {faltan} tile/s).\n\n¿Preparar el área de la cobertura ahora ({n} tile/s, requiere internet)?",
    zona_no_preparada_error: "Zona no preparada.",
    preparando_area: "Preparando el área de la cobertura: {n} tile(s)…",
    calculando_de_nuevo: "Calculando cobertura…",
    cobertura_error_prefijo: "Cobertura: ",
    cobertura_guardada: "Cobertura \"{nombre}\" guardada.",
    guardando_cobertura: "Guardando cobertura…",
    guardar_error_prefijo: "Guardar: ",
    exportando: "Exportando a Google Earth…",
    kmz_exportado: "KMZ exportado.",
    exportar_error_prefijo: "Exportar: ",
    borrar_confirm: "¿Borrar la cobertura \"{nombre}\"?",
    borrando: "Borrando…",
    borrar_error_prefijo: "Borrar: ",
    overlay_error_prefijo: "Overlay: ",
    guardadas_error_prefijo: "Guardadas: ",
    chk_toggle_title: "Prender/apagar en el mapa",
    info_click_title: "Click para ir a la zona",
    exportar_item_title: "Exportar a Google Earth (KMZ)",
    borrar_item_title: "Borrar",

    err_409: "Zona no preparada. Usá \"Descargar zona\" primero.",
    err_413: "Área demasiado grande. Acercá el zoom.",
    err_422: "No es posible calcular con esos parámetros.",
    err_502: "No se pudo descargar el relieve (problema de red).",
    err_503: "Falta configurar la API key de relieve (en la app o en .env).",
    err_504: "Tiempo de espera agotado.",
    error_generico: "Error",
  },

  en: {
    topbar_subtitulo: "Radio coverage planning · Argentina",
    topbar_tablist_aria: "Coverage mode",
    modo_vhf: "VHF",
    modo_hf: "HF",
    modo_mejor: "Best Site",
    relieve_label: "Terrain",
    relieve_mostrar: "Show terrain",
    relieve_ocultar: "Hide terrain",
    offline_label: "Download area",
    offline_title: "Download the terrain for an area to calculate coverage, offline too.",
    ayuda_title: "Open the step-by-step guide",
    idioma_title: "Change language",

    campo_lat: "Lat",
    campo_lon: "Lon",
    tip_latlon: "Transmitter location in decimal degrees (WGS84). E.g.: -32.34, -65.01",
    campo_rxh: "Rx h (m)",
    tip_rxh: "Receiving antenna height above ground, in meters. Handheld ~1.5; mobile ~2. E.g.: 1.5",
    campo_erp: "ERP (W)",
    campo_frec: "Freq (MHz)",
    campo_umbral: "Threshold (dBm)",

    vhf_titulo: "VHF Coverage",
    vhf_ayuda: "Click on the map to place the transmitter.",
    vhf_aviso_zoom: "Zoom in on the map to calculate coverage.",
    vhf_campo_txh: "Tx h (m)",
    vhf_tip_txh: "Transmitter antenna height ABOVE GROUND (not above sea level), in meters. E.g.: 25",
    vhf_tip_erp: "Effective radiated power (ERP) in watts = radio power × antenna gain − line losses. If you only enter the radio's power, the estimate is conservative. E.g.: 25",
    vhf_tip_frec: "Transmitter frequency in MHz. E.g.: 150 (VHF band)",
    vhf_campo_radio: "Radius (km)",
    vhf_tip_radio: "Maximum distance to calculate from the transmitter, in km. Larger = slower. E.g.: 40",
    vhf_tip_umbral: "Minimum signal the receiver needs to have coverage, in dBm. More negative = more sensitive receiver = more coverage. A typical VHF radio is around -100 to -116. E.g.: -100",
    vhf_campo_res: "Res (px)",
    vhf_tip_res: "Calculation detail in pixels. Higher = more detail and slower.",
    vhf_btn_calcular: "Calculate coverage",
    vhf_btn_guardar: "Save coverage",
    vhf_btn_exportar: "Export to Google Earth",
    vhf_guardadas_titulo: "Saved coverages",
    vhf_guardadas_vacio: "You haven't saved any yet.",

    hf_titulo: "HF Coverage",
    hf_ayuda: "Click on the map to place your station.",
    hf_campo_banda: "Band",
    hf_tip_banda: "HF band to analyze. Each band is calculated at a representative frequency. Pick 'Other' to enter an exact frequency in MHz.",
    hf_opcion_otra: "Other frequency (MHz)…",
    hf_tip_frecotra: "Exact frequency in MHz (1.6 to 30).",
    hf_campo_alcance: "Range",
    hf_tip_alcance: "Size of the area to analyze, centered on your station. HF coverage is long-distance; the area does NOT depend on the map zoom.",
    hf_alcance_regional: "Regional (~2000 km)",
    hf_alcance_continental: "Continental (~4000 km)",
    hf_alcance_dx: "DX / Long (~7000 km)",
    hf_campo_mes: "Month",
    hf_tip_mes: "Month of the year to analyze (HF propagation changes a lot by season).",
    hf_campo_hora: "UTC Hour",
    hf_tip_hora: "UTC hour (0 to 23). HF propagation changes a lot between day and night.",
    hf_ssn_prefijo: "SSN",
    hf_ssn_cargando: "SSN …",
    hf_ssn_sin_datos: "SSN — · no data",
    hf_ssn_usado: "SSN used: {val} · {fuente}",
    hf_avanzado: "Advanced",
    hf_campo_ssn: "SSN",
    hf_tip_ssn: "Sunspot number (R12). If left empty, NOAA's forecast for the chosen month is used.",
    hf_ssn_placeholder: "auto",
    hf_campo_ruido: "Noise",
    hf_tip_ruido: "Man-made noise environment at the receiver. Rural is a good general default.",
    hf_ruido_ciudad: "City",
    hf_ruido_residencial: "Residential",
    hf_ruido_rural: "Rural",
    hf_ruido_rural_silencioso: "Quiet rural",
    hf_btn_calcular: "Calculate HF coverage",
    hf_leyenda_titulo: "Circuit reliability",
    hf_leyenda_fuerte: "Strong (≥ 90%)",
    hf_leyenda_buena: "Good (75–90%)",
    hf_leyenda_marginal: "Marginal (50–75%)",
    hf_leyenda_baja: "Low (< 50%)",
    hf_leyenda_nota: "Low reliability near the transmitter on certain bands/hours is normal (skip zone), not an error.",
    hf_fuente_noaa: "NOAA forecast",
    hf_fuente_manual: "manual value",
    hf_fuente_default: "default value (offline)",
    hf_frecuencia_invalida: "Enter a valid frequency.",
    hf_calculando: "Calculating HF coverage…",
    hf_error_prefijo: "HF coverage: ",

    mes_1: "January", mes_2: "February", mes_3: "March", mes_4: "April",
    mes_5: "May", mes_6: "June", mes_7: "July", mes_8: "August",
    mes_9: "September", mes_10: "October", mes_11: "November", mes_12: "December",

    mejor_titulo: "Best Site",
    mejor_ayuda: "Draw the perimeter of the area you want to cover: click on the map to add points. With 3 or more points, close the area (or go straight to \"Find best site\": if you didn't close it, it closes on its own).",
    mejor_contador: "Points drawn: {n}",
    mejor_btn_cerrar: "Close area",
    mejor_btn_reiniciar: "Reset",
    mejor_campo_txh: "Tx h (m)",
    mejor_tip_txh: "Repeater antenna height ABOVE GROUND (not above sea level), in meters. E.g.: 25",
    mejor_tip_erp: "Effective radiated power (ERP) in watts. E.g.: 25",
    mejor_tip_frec: "Repeater frequency in MHz. E.g.: 150 (VHF band)",
    mejor_tip_umbral: "Minimum signal the receiver needs to have coverage, in dBm. E.g.: -100",
    mejor_btn_calcular: "Find best site",
    mejor_buscando: "Searching for the best site (runs several test coverages, this can take a while)…",
    mejor_puntos_insuficientes: "Draw at least 3 points to define the area.",
    mejor_resultado: "Best site: {lat}, {lon} · covers ~{score}% of the drawn area.",
    mejor_error_prefijo: "Best site: ",
    mejor_area_grande: "The search area spans {n} tiles (max {max}). Draw a smaller perimeter.",
    mejor_zona_no_preparada_grande: "This search area isn't ready yet ({faltan} tile(s) missing).\n\nYou're about to download ~{n} tiles (~{gb} GB), this may take a while. Continue?",
    mejor_zona_no_preparada_chica: "This search area isn't ready yet ({faltan} tile(s) missing).\n\nPrepare the area now ({n} tile(s), needs internet)?",
    mejor_preparando: "Preparing the search area: {n} tile(s)…",
    mejor_buscando_de_nuevo: "Searching for the best site…",

    off_titulo: "Download area",
    off_ayuda: "Download the terrain for the current view or a province so the map and calculations work offline.",
    off_btn_vista: "Download current view",
    off_label_provincia: "Province",
    off_btn_provincia: "Download province",
    off_btn_reintentar: "Retry missing",
    off_zonas_titulo: "Areas available offline",
    off_check_mostrar: "Show on map",
    off_check_oceano: "Include ocean",
    off_leyenda_tierra: "Land",
    off_leyenda_oceano: "Ocean",
    off_resumen: "{tiles} tiles cached · {mb} MB on disk",
    off_iniciando_descarga: "Starting download (~{n} tiles, ~{gb} GB)…",
    off_descarga_en_curso: "A download is already running. Wait for it to finish.",
    off_descarga_no_iniciada: "Couldn't start: {motivo}",
    off_descarga_red_error: "Couldn't start the download (network).",
    off_descarga_grande_confirm: "You're about to download ~{n} tiles (~{gb} GB). This is a large, country-scale download. Continue?",
    off_progreso_tiles: "{done}/{total} tiles",
    off_progreso_oceano: "ocean {n}",
    off_progreso_fallidos: "failed {n}",

    apikey_titulo: "OpenTopography API key",
    apikey_mensaje_falta: "You don't have an OpenTopography API key set up. If you don't have one, create one for free.",
    apikey_mensaje_invalida: "Your API key looks invalid, please check it. Paste a valid OpenTopography key.",
    apikey_link_crear: "Create a free account",
    apikey_link_guia: "Step-by-step guide",
    apikey_label_pegar: "Paste your API key",
    apikey_placeholder: "Your OpenTopography key",
    apikey_ver_aria: "Show or hide the key",
    apikey_ver_title: "Show/hide",
    apikey_btn_cerrar: "Close",
    apikey_btn_guardar: "Save",
    apikey_falta_antes_guardar: "Paste your API key before saving.",
    apikey_guardada: "API key saved. Try \"Download area\".",

    guardar_titulo: "Save coverage",
    guardar_label_nombre: "Name",
    guardar_placeholder: "E.g.: Cerro Otto Repeater",
    guardar_btn_cancelar: "Cancel",
    guardar_btn_ok: "Save",

    relieve_modal_titulo: "Terrain not available",
    relieve_modal_texto: "Download the area first to see the terrain.",
    relieve_modal_cerrar: "Close",
    relieve_modal_descargar: "Download area",

    tour_omitir: "Skip tutorial",
    tour_anterior: "Previous",
    tour_siguiente: "Next",
    tour_finalizar: "Finish",
    tour_paso_contador: "Step {n} of {total}",
    tour_paso_0: "Welcome to RadioLocal-VHF-HF. In 4 steps you'll plan a radio coverage. You can skip this guide anytime.",
    tour_paso_1: "1) Download your area. Fetch the terrain for the area you'll be working in; once downloaded, it works even without internet. Next to it, the 🌐 button lets you change the app's language.",
    tour_paso_2: "2) Place your station. Click on the map where your antenna is and fill in your equipment's data. The 'i' icons explain each field.",
    tour_paso_3: "3) Calculate the coverage. The map shows you how far your signal reaches.",
    tour_paso_4: "4) Check the terrain. Turn it on to see the area's elevation.",
    tour_paso_5: "Save and compare. You can save coverages and overlay them to compare.",
    tour_paso_6: "That's it! Reopen this guide anytime with the ? button.",

    generando_relieve: "Generating terrain…",
    relieve_error_prefijo: "Terrain: ",
    calculando_cobertura: "Calculating coverage (this can take several seconds)…",
    radio_max_msg: "For now the maximum is {max} km. Larger radii will arrive with background processing (next version).",
    radio_grande_confirm: "Large radius ({km} km): this can take a couple of minutes. Continue?",
    cobertura_area_grande: "The coverage spans {n} tiles (max {max}). Reduce the radius.",
    vhf_zona_no_preparada_grande: "This coverage area isn't ready yet ({faltan} tile(s) missing).\n\nYou're about to download ~{n} tiles (~{gb} GB), this may take a while. Continue?",
    vhf_zona_no_preparada_chica: "This coverage area isn't ready yet ({faltan} tile(s) missing).\n\nPrepare the coverage area now ({n} tile(s), needs internet)?",
    zona_no_preparada_error: "Area not prepared.",
    preparando_area: "Preparing the coverage area: {n} tile(s)…",
    calculando_de_nuevo: "Calculating coverage…",
    cobertura_error_prefijo: "Coverage: ",
    cobertura_guardada: "Coverage \"{nombre}\" saved.",
    guardando_cobertura: "Saving coverage…",
    guardar_error_prefijo: "Save: ",
    exportando: "Exporting to Google Earth…",
    kmz_exportado: "KMZ exported.",
    exportar_error_prefijo: "Export: ",
    borrar_confirm: "Delete coverage \"{nombre}\"?",
    borrando: "Deleting…",
    borrar_error_prefijo: "Delete: ",
    overlay_error_prefijo: "Overlay: ",
    guardadas_error_prefijo: "Saved coverages: ",
    chk_toggle_title: "Turn on/off on the map",
    info_click_title: "Click to go to this area",
    exportar_item_title: "Export to Google Earth (KMZ)",
    borrar_item_title: "Delete",

    err_409: "Area not prepared. Use \"Download area\" first.",
    err_413: "Area too large. Zoom in.",
    err_422: "Can't calculate with those parameters.",
    err_502: "Couldn't download the terrain (network issue).",
    err_503: "Terrain API key not configured (in the app or in .env).",
    err_504: "Request timed out.",
    error_generico: "Error",
  },

  zh: {
    topbar_subtitulo: "无线电覆盖规划 · 阿根廷",
    topbar_tablist_aria: "覆盖模式",
    modo_vhf: "VHF",
    modo_hf: "HF",
    modo_mejor: "最佳选址",
    relieve_label: "地形",
    relieve_mostrar: "显示地形",
    relieve_ocultar: "隐藏地形",
    offline_label: "下载区域",
    offline_title: "下载某个区域的地形数据用于计算覆盖，也可离线使用。",
    ayuda_title: "打开分步指南",
    idioma_title: "切换语言",

    campo_lat: "纬度",
    campo_lon: "经度",
    tip_latlon: "发射台位置，十进制度数（WGS84）。例：-32.34, -65.01",
    campo_rxh: "接收天线高 (m)",
    tip_rxh: "接收天线离地高度，单位米。手持机约1.5；车载约2。例：1.5",
    campo_erp: "ERP (瓦)",
    campo_frec: "频率 (MHz)",
    campo_umbral: "门限 (dBm)",

    vhf_titulo: "VHF 覆盖",
    vhf_ayuda: "在地图上点击以放置发射台。",
    vhf_aviso_zoom: "放大地图以计算覆盖范围。",
    vhf_campo_txh: "发射天线高 (m)",
    vhf_tip_txh: "发射天线离地面（非海平面）的高度，单位米。例：25",
    vhf_tip_erp: "有效辐射功率（ERP），单位瓦 = 设备功率 × 天线增益 − 馈线损耗。若只填设备功率，估算会偏保守。例：25",
    vhf_tip_frec: "发射台频率，单位MHz。例：150（VHF频段）",
    vhf_campo_radio: "半径 (km)",
    vhf_tip_radio: "从发射台起算的最大计算距离，单位公里。数值越大计算越慢。例：40",
    vhf_tip_umbral: "接收机获得覆盖所需的最小信号，单位dBm。负值越大＝接收机越灵敏＝覆盖范围越大。典型VHF设备约为-100至-116。例：-100",
    vhf_campo_res: "分辨率 (px)",
    vhf_tip_res: "计算精细度（像素）。越高越精细，也越慢。",
    vhf_btn_calcular: "计算覆盖范围",
    vhf_btn_guardar: "保存覆盖结果",
    vhf_btn_exportar: "导出到 Google Earth",
    vhf_guardadas_titulo: "已保存的覆盖结果",
    vhf_guardadas_vacio: "还没有保存任何结果。",

    hf_titulo: "HF 覆盖",
    hf_ayuda: "在地图上点击以放置你的电台。",
    hf_campo_banda: "频段",
    hf_tip_banda: "要分析的HF频段。每个频段用一个代表频率计算。选择“其他”可输入精确的MHz频率。",
    hf_opcion_otra: "其他频率 (MHz)…",
    hf_tip_frecotra: "精确频率，单位MHz（1.6至30）。",
    hf_campo_alcance: "范围",
    hf_tip_alcance: "以你的电台为中心分析的区域大小。HF覆盖属于远距离传播；该区域不随地图缩放变化。",
    hf_alcance_regional: "区域（约2000公里）",
    hf_alcance_continental: "洲际（约4000公里）",
    hf_alcance_dx: "远距离/DX（约7000公里）",
    hf_campo_mes: "月份",
    hf_tip_mes: "要分析的月份（HF传播随季节变化很大）。",
    hf_campo_hora: "UTC 时间",
    hf_tip_hora: "UTC时间（0至23点）。HF传播在昼夜之间差异很大。",
    hf_ssn_prefijo: "太阳黑子数",
    hf_ssn_cargando: "太阳黑子数 …",
    hf_ssn_sin_datos: "太阳黑子数 — · 无数据",
    hf_ssn_usado: "使用的太阳黑子数：{val} · {fuente}",
    hf_avanzado: "高级选项",
    hf_campo_ssn: "太阳黑子数",
    hf_tip_ssn: "太阳黑子数（R12）。留空则使用NOAA对所选月份的预测值。",
    hf_ssn_placeholder: "自动",
    hf_campo_ruido: "噪声环境",
    hf_tip_ruido: "接收端的人为噪声环境。乡村（Rural）是常用的通用默认值。",
    hf_ruido_ciudad: "城市",
    hf_ruido_residencial: "住宅区",
    hf_ruido_rural: "乡村",
    hf_ruido_rural_silencioso: "安静乡村",
    hf_btn_calcular: "计算 HF 覆盖",
    hf_leyenda_titulo: "通信可靠度",
    hf_leyenda_fuerte: "强（≥ 90%）",
    hf_leyenda_buena: "良好（75–90%）",
    hf_leyenda_marginal: "一般（50–75%）",
    hf_leyenda_baja: "弱（< 50%）",
    hf_leyenda_nota: "在某些频段/时段发射台附近可靠度偏低是正常现象（静区/跳跃区），并非错误。",
    hf_fuente_noaa: "NOAA 预测值",
    hf_fuente_manual: "手动输入值",
    hf_fuente_default: "默认值（离线）",
    hf_frecuencia_invalida: "请输入有效的频率。",
    hf_calculando: "正在计算 HF 覆盖…",
    hf_error_prefijo: "HF 覆盖：",

    mes_1: "一月", mes_2: "二月", mes_3: "三月", mes_4: "四月",
    mes_5: "五月", mes_6: "六月", mes_7: "七月", mes_8: "八月",
    mes_9: "九月", mes_10: "十月", mes_11: "十一月", mes_12: "十二月",

    mejor_titulo: "最佳选址",
    mejor_ayuda: "在地图上画出你想覆盖区域的边界：点击地图添加点。有3个或以上的点后，闭合区域（或直接点“寻找最佳选址”：如果你没手动闭合，它会自动闭合）。",
    mejor_contador: "已画点数：{n}",
    mejor_btn_cerrar: "闭合区域",
    mejor_btn_reiniciar: "重新开始",
    mejor_campo_txh: "发射天线高 (m)",
    mejor_tip_txh: "中继台天线离地面（非海平面）的高度，单位米。例：25",
    mejor_tip_erp: "有效辐射功率（ERP），单位瓦。例：25",
    mejor_tip_frec: "中继台频率，单位MHz。例：150（VHF频段）",
    mejor_tip_umbral: "接收机获得覆盖所需的最小信号，单位dBm。例：-100",
    mejor_btn_calcular: "寻找最佳选址",
    mejor_buscando: "正在寻找最佳选址（会运行多次试算，可能需要一些时间）…",
    mejor_puntos_insuficientes: "请至少画3个点来确定区域。",
    mejor_resultado: "最佳选址：{lat}, {lon} · 覆盖约 {score}% 的所画区域。",
    mejor_error_prefijo: "最佳选址：",
    mejor_area_grande: "搜索区域跨越 {n} 个地形块（最多 {max} 个）。请画一个更小的边界。",
    mejor_zona_no_preparada_grande: "该搜索区域尚未准备好（缺少 {faltan} 个地形块）。\n\n即将下载约 {n} 个地形块（约 {gb} GB），可能需要一些时间。是否继续？",
    mejor_zona_no_preparada_chica: "该搜索区域尚未准备好（缺少 {faltan} 个地形块）。\n\n是否现在准备该区域（{n} 个地形块，需要联网）？",
    mejor_preparando: "正在准备搜索区域：{n} 个地形块…",
    mejor_buscando_de_nuevo: "正在寻找最佳选址…",

    off_titulo: "下载区域",
    off_ayuda: "下载当前视图或某个省份的地形数据，以便离线使用地图和计算功能。",
    off_btn_vista: "下载当前视图",
    off_label_provincia: "省份",
    off_btn_provincia: "下载省份",
    off_btn_reintentar: "重试失败项",
    off_zonas_titulo: "可离线使用的区域",
    off_check_mostrar: "在地图上显示",
    off_check_oceano: "包含海洋",
    off_leyenda_tierra: "陆地",
    off_leyenda_oceano: "海洋",
    off_resumen: "已缓存 {tiles} 个地形块 · 占用磁盘 {mb} MB",
    off_iniciando_descarga: "正在开始下载（约 {n} 个地形块，约 {gb} GB）…",
    off_descarga_en_curso: "已有一个下载任务在进行。请等待其完成。",
    off_descarga_no_iniciada: "无法开始：{motivo}",
    off_descarga_red_error: "无法开始下载（网络问题）。",
    off_descarga_grande_confirm: "即将下载约 {n} 个地形块（约 {gb} GB）。这是一个国家级规模的大下载。是否继续？",
    off_progreso_tiles: "{done}/{total} 个地形块",
    off_progreso_oceano: "海洋 {n}",
    off_progreso_fallidos: "失败 {n}",

    apikey_titulo: "OpenTopography API 密钥",
    apikey_mensaje_falta: "你还没有配置 OpenTopography 的 API 密钥。如果还没有，可以免费创建一个。",
    apikey_mensaje_invalida: "你的 API 密钥似乎无效，请检查。请粘贴一个有效的 OpenTopography 密钥。",
    apikey_link_crear: "免费创建账号",
    apikey_link_guia: "分步指南",
    apikey_label_pegar: "粘贴你的 API 密钥",
    apikey_placeholder: "你的 OpenTopography 密钥",
    apikey_ver_aria: "显示或隐藏密钥",
    apikey_ver_title: "显示/隐藏",
    apikey_btn_cerrar: "关闭",
    apikey_btn_guardar: "保存",
    apikey_falta_antes_guardar: "保存前请先粘贴你的 API 密钥。",
    apikey_guardada: "API 密钥已保存。试试“下载区域”。",

    guardar_titulo: "保存覆盖结果",
    guardar_label_nombre: "名称",
    guardar_placeholder: "例：Cerro Otto 中继台",
    guardar_btn_cancelar: "取消",
    guardar_btn_ok: "保存",

    relieve_modal_titulo: "地形数据不可用",
    relieve_modal_texto: "请先下载该区域以查看地形。",
    relieve_modal_cerrar: "关闭",
    relieve_modal_descargar: "下载区域",

    tour_omitir: "跳过教程",
    tour_anterior: "上一步",
    tour_siguiente: "下一步",
    tour_finalizar: "完成",
    tour_paso_contador: "第 {n} 步，共 {total} 步",
    tour_paso_0: "欢迎使用 RadioLocal-VHF-HF。通过4个步骤即可规划无线电覆盖。你可以随时跳过本指南。",
    tour_paso_1: "1) 下载你的区域。获取你要工作区域的地形数据；下载完成后，即使没有网络也能使用。旁边的 🌐 按钮可以切换应用的语言。",
    tour_paso_2: "2) 放置你的电台。点击地图上你天线所在的位置，并填写设备信息。“i”图标会解释每一项数据。",
    tour_paso_3: "3) 计算覆盖范围。地图会显示你的信号能到达的范围。",
    tour_paso_4: "4) 查看地形。打开它可以查看该区域的地貌。",
    tour_paso_5: "保存并比较。你可以保存多个覆盖结果并叠加显示以进行比较。",
    tour_paso_6: "完成！你可以随时点击“?”按钮重新打开本指南。",

    generando_relieve: "正在生成地形…",
    relieve_error_prefijo: "地形：",
    calculando_cobertura: "正在计算覆盖范围（可能需要几秒钟）…",
    radio_max_msg: "目前最大半径为 {max} 公里。更大的半径将在后台处理功能中支持（下一版本）。",
    radio_grande_confirm: "半径较大（{km} 公里）：可能需要几分钟。是否继续？",
    cobertura_area_grande: "该覆盖范围跨越 {n} 个地形块（最多 {max} 个）。请缩小半径。",
    vhf_zona_no_preparada_grande: "该覆盖区域尚未准备好（缺少 {faltan} 个地形块）。\n\n即将下载约 {n} 个地形块（约 {gb} GB），可能需要一些时间。是否继续？",
    vhf_zona_no_preparada_chica: "该覆盖区域尚未准备好（缺少 {faltan} 个地形块）。\n\n是否现在准备该覆盖区域（{n} 个地形块，需要联网）？",
    zona_no_preparada_error: "区域尚未准备好。",
    preparando_area: "正在准备覆盖区域：{n} 个地形块…",
    calculando_de_nuevo: "正在计算覆盖范围…",
    cobertura_error_prefijo: "覆盖：",
    cobertura_guardada: "覆盖结果“{nombre}”已保存。",
    guardando_cobertura: "正在保存覆盖结果…",
    guardar_error_prefijo: "保存：",
    exportando: "正在导出到 Google Earth…",
    kmz_exportado: "KMZ 已导出。",
    exportar_error_prefijo: "导出：",
    borrar_confirm: "确定删除覆盖结果“{nombre}”吗？",
    borrando: "正在删除…",
    borrar_error_prefijo: "删除：",
    overlay_error_prefijo: "图层：",
    guardadas_error_prefijo: "已保存结果：",
    chk_toggle_title: "在地图上开启/关闭",
    info_click_title: "点击以跳转到该区域",
    exportar_item_title: "导出到 Google Earth (KMZ)",
    borrar_item_title: "删除",

    err_409: "区域尚未准备好。请先使用“下载区域”。",
    err_413: "区域过大。请放大地图缩小范围。",
    err_422: "无法用这些参数进行计算。",
    err_502: "无法下载地形数据（网络问题）。",
    err_503: "缺少地形 API 密钥配置（应用内或 .env 中）。",
    err_504: "请求超时。",
    error_generico: "错误",
  },
};

// --------------------------------------------------------------------------
// Motor: lookup + interpolación + aplicación al DOM
// --------------------------------------------------------------------------
let idiomaActual = localStorage.getItem(LS_IDIOMA) || "es";

// Reemplaza {clave} dentro de un string con los valores de `vars`.
function _interpolar(texto, vars) {
  if (!vars) return texto;
  return texto.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// Traduce `clave` al idioma activo. Cae a español y, si tampoco existe ahí, a
// la clave misma (nunca revienta ni deja un hueco en blanco).
function t(clave, vars) {
  const dic = IDIOMAS[idiomaActual] || IDIOMAS.es;
  const texto = dic[clave] ?? IDIOMAS.es[clave] ?? clave;
  return _interpolar(texto, vars);
}

// Suscripción simple: partes de app.js con contenido dinámico (selects
// poblados por JS, contadores, texto del tour, etc.) registran acá su propio
// re-render, disparado cada vez que cambia el idioma.
const _listenersIdioma = [];
function onCambioIdioma(fn) {
  _listenersIdioma.push(fn);
}

// Recorre el DOM aplicando el diccionario activo a todo lo marcado con
// data-i18n (textContent) y data-i18n-attrs (atributos como aria-label/title/
// placeholder). Se llama al cargar y en cada cambio de idioma.
function aplicarIdioma() {
  document.documentElement.lang = idiomaActual;

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-attrs]").forEach((el) => {
    let mapa;
    try {
      mapa = JSON.parse(el.dataset.i18nAttrs);
    } catch {
      return; // atributo mal formado: no rompemos la carga por esto
    }
    Object.entries(mapa).forEach(([attr, clave]) => {
      el.setAttribute(attr, t(clave));
    });
  });
}

function setIdioma(nuevo) {
  if (!IDIOMAS[nuevo] || nuevo === idiomaActual) return;
  idiomaActual = nuevo;
  localStorage.setItem(LS_IDIOMA, nuevo);
  aplicarIdioma();
  _listenersIdioma.forEach((fn) => fn());
}

// --------------------------------------------------------------------------
// Selector de idioma: botón + mini-menú al lado del botón de ayuda ("?").
// --------------------------------------------------------------------------
function _inicializarSelectorIdioma() {
  const btn = document.getElementById("btn-idioma");
  const menu = document.getElementById("idioma-menu");
  if (!btn || !menu) return;

  menu.innerHTML = "";
  IDIOMAS_DISPONIBLES.forEach(({ clave, nombre }) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.idioma = clave;
    li.textContent = nombre;
    li.addEventListener("click", () => {
      setIdioma(clave);
      cerrarMenu();
    });
    menu.appendChild(li);
  });

  function marcarSeleccionado() {
    menu.querySelectorAll("li").forEach((li) => {
      li.classList.toggle("seleccionado", li.dataset.idioma === idiomaActual);
    });
    const actual = IDIOMAS_DISPONIBLES.find((i) => i.clave === idiomaActual);
    btn.textContent = "🌐 " + (actual ? actual.clave.toUpperCase() : idiomaActual.toUpperCase());
  }

  function abrirMenu() {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    marcarSeleccionado();
  }
  function cerrarMenu() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) abrirMenu();
    else cerrarMenu();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) cerrarMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) cerrarMenu();
  });

  marcarSeleccionado();
  onCambioIdioma(marcarSeleccionado);
}

aplicarIdioma();
_inicializarSelectorIdioma();
