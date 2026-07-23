// Inicialización del mapa de RadioLocal-VHF-HF.
//
// Mapa base: OpenFreeMap (estilo "positron", claro, sin API key). Es de la
// familia OpenMapTiles, así que la atribución OpenStreetMap/OpenMapTiles viaja
// en el propio style.json y MapLibre la muestra.
//
// FASE OFFLINE (futuro): reemplazar esta fuente online por un PMTiles local
// (mismo esquema OpenMapTiles) sin tocar el resto de la app. Ver CLAUDE.md.
const ESTILO_MAPA = "https://tiles.openfreemap.org/styles/positron";

// Centro aproximado de Argentina y zoom inicial para ver todo el país.
const CENTRO_ARGENTINA = [-64.0, -38.0];
const ZOOM_INICIAL = 4;

// Zoom mínimo para habilitar el cálculo de cobertura (no a nivel país).
const MIN_ZOOM_COBERTURA = 8;

// Tope de tiles 1°×1° para "Preparar zona" (espejo del guard del backend).
const MAX_TILES_PREPARAR = 64;
// A partir de cuántos tiles avisamos que la descarga es grande.
const AVISO_TILES_PREPARAR = 12;

// Política de radio (km) en el modelo SÍNCRONO actual: <=60 normal; 60–100 con
// aviso (tarda un par de minutos); >100 todavía no (llega con el worker async).
const RADIO_MAX_KM = 100;
const RADIO_AVISO_KM = 60;

const map = new maplibregl.Map({
  container: "map",
  style: ESTILO_MAPA,
  center: CENTRO_ARGENTINA,
  zoom: ZOOM_INICIAL,
  // Desactivamos el control de atribución por defecto para agregar el nuestro
  // (no-compacto, siempre visible) y evitar que aparezca duplicado.
  attributionControl: false,
});

// Controles de navegación (zoom + brújula) y atribución siempre visible.
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");

// --------------------------------------------------------------------------
// Estado y utilidades compartidas
// --------------------------------------------------------------------------
const estado = document.getElementById("estado");
const spinner = document.getElementById("spinner");

// Bandera para serializar acciones (evita corridas simultáneas) y mover el spinner.
let ocupado = false;

function setEstado(texto, esError = false) {
  estado.textContent = texto || "";
  estado.classList.toggle("error", !!esError && !!texto);
}

function setOcupado(on, texto) {
  ocupado = on;
  spinner.hidden = !on;
  if (texto) setEstado(texto);
  actualizarControles();
}

// bbox del viewport actual como [oeste, sur, este, norte].
function bboxViewport() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

// Cuenta los tiles 1°×1° que cubren un bbox (mismo criterio que el backend).
function tilesEnBbox([w, s, e, n]) {
  const latMin = Math.floor(s);
  const latMax = Math.ceil(n) - 1;
  const lonMin = Math.floor(w);
  const lonMax = Math.ceil(e) - 1;
  return (latMax - latMin + 1) * (lonMax - lonMin + 1);
}

// Devuelve un mensaje legible a partir de una respuesta de error. Intenta leer
// {detail} del backend; si no es JSON (p. ej. 504 de nginx devuelve HTML), usa
// un texto por código de estado. Así siempre mostramos algo diagnosticable.
async function mensajeDeError(resp) {
  let detalle = "";
  try {
    const d = (await resp.json()).detail;
    // El detail puede ser texto o un objeto estructurado ({message, ...}).
    detalle = typeof d === "string" ? d : d && d.message ? d.message : "";
  } catch {
    /* respuesta no-JSON */
  }
  if (detalle) return `(${resp.status}) ${detalle}`;
  const porCodigo = {
    409: t("err_409"),
    413: t("err_413"),
    422: t("err_422"),
    502: t("err_502"),
    503: t("err_503"),
    504: t("err_504"),
  };
  return `(${resp.status}) ${porCodigo[resp.status] || resp.statusText || t("error_generico")}`;
}

// Agrega (o reemplaza) un overlay raster a partir de un blob PNG y su bbox.
// Lo reusan el relieve y la cobertura.
function agregarOverlayRaster(idSrc, idLayer, blob, bbox, opacity = 0.7) {
  const [w, s, e, n] = bbox;
  const imgUrl = URL.createObjectURL(blob);
  quitarOverlay(idSrc, idLayer);
  map.addSource(idSrc, {
    type: "image",
    url: imgUrl,
    // MapLibre espera las 4 esquinas: arriba-izq, arriba-der, abajo-der, abajo-izq.
    coordinates: [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  });
  map.addLayer({
    id: idLayer,
    type: "raster",
    source: idSrc,
    paint: { "raster-opacity": opacity },
  });
}

function quitarOverlay(idSrc, idLayer) {
  if (map.getLayer(idLayer)) map.removeLayer(idLayer);
  if (map.getSource(idSrc)) map.removeSource(idSrc);
}

// Lee el header X-Bbox de una respuesta (o usa un fallback).
function bboxDeHeader(resp, fallback) {
  return (resp.headers.get("X-Bbox") || fallback.join(",")).split(",").map(Number);
}

// --------------------------------------------------------------------------
// API KEY de OpenTopography (UX de carga)
// La key vive SOLO en localStorage del navegador (cada usuario la suya) y viaja
// por el header X-OpenTopography-Key en cada descarga de relieve. El backend
// nunca nos la devuelve: solo nos dice si hay una en .env (booleano), para no
// molestar a quien ya la tiene configurada por ese camino.
// --------------------------------------------------------------------------
const LS_API_KEY = "radiolocal_ot_key";
let envTieneKey = false; // ¿el .env del servidor ya trae una key?
// ¿La fuente de DEM activa necesita API key? Solo el fallback OpenTopography.
// Con la fuente por defecto (S3, Copernicus) es false: el cartel nunca aparece.
let requiereKey = false;

function getApiKey() {
  return localStorage.getItem(LS_API_KEY) || "";
}
function setApiKey(k) {
  localStorage.setItem(LS_API_KEY, k);
}
// Hay key usable si el usuario cargó una en el navegador O el .env ya trae una.
function hayKeyUsable() {
  return !!getApiKey() || envTieneKey;
}

const modalApiKey = document.getElementById("modal-apikey");
const apiKeyInput = document.getElementById("apikey-input");
const apiKeyMensaje = document.getElementById("apikey-mensaje");
const apiKeyOk = document.getElementById("apikey-ok");
const apiKeyCancelar = document.getElementById("apikey-cancelar");
const apiKeyVer = document.getElementById("apikey-ver");

// Muestra el modal con el mensaje dado. esError pinta el texto de rojo.
function mostrarModalApiKey(mensaje, esError = false) {
  apiKeyMensaje.textContent = mensaje;
  apiKeyMensaje.classList.toggle("error", esError);
  apiKeyInput.value = getApiKey(); // precarga la actual (por si quiere corregirla)
  apiKeyInput.type = "password";
  modalApiKey.hidden = false;
  apiKeyInput.focus();
}
function ocultarModalApiKey() {
  modalApiKey.hidden = true;
}

// Guardar: persiste la key en localStorage y cierra. NO hay endpoint de
// validación: la primera descarga real la valida; si el backend la rechaza
// (invalid_api_key), el cartel vuelve a abrirse con el aviso correspondiente.
apiKeyOk.addEventListener("click", () => {
  const k = apiKeyInput.value.trim();
  if (!k) {
    apiKeyMensaje.textContent = t("apikey_falta_antes_guardar");
    apiKeyMensaje.classList.add("error");
    return;
  }
  setApiKey(k);
  ocultarModalApiKey();
  setEstado(t("apikey_guardada"));
});

apiKeyCancelar.addEventListener("click", ocultarModalApiKey);

// Botón mostrar/ocultar la clave (input password <-> text).
apiKeyVer.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  apiKeyInput.focus();
});

// Si el backend avisa que la key falta o no sirve, reabrimos el cartel con el
// mensaje adecuado. Usa resp.clone() para no consumir el cuerpo (lo lee luego
// mensajeDeError). Devuelve true si el error era de API key.
async function manejarErrorApiKey(resp) {
  let code = null;
  try {
    const d = (await resp.clone().json()).detail;
    code = d && typeof d === "object" ? d.code : null;
  } catch {
    /* respuesta no-JSON */
  }
  if (code === "no_api_key") {
    mostrarModalApiKey(t("apikey_mensaje_falta"));
    return true;
  }
  if (code === "invalid_api_key") {
    mostrarModalApiKey(t("apikey_mensaje_invalida"), true);
    return true;
  }
  return false;
}

// Al iniciar: consultar si el .env del servidor ya tiene key. Si no hay ninguna
// usable (ni navegador ni .env), abrir el cartel para cargar la propia.
async function inicializarApiKey() {
  try {
    const resp = await fetch("/api/config/status");
    if (resp.ok) {
      const s = await resp.json();
      requiereKey = !!s.requires_api_key;
      envTieneKey = !!s.has_api_key;
    }
  } catch {
    /* si el status falla, seguimos: igual evaluamos localStorage */
  }
  // El cartel SOLO aplica al fallback OpenTopography (requires_api_key=true) y
  // únicamente si no hay key usable. Con la fuente por defecto (S3) no hace
  // falta key, así que el modal nunca se muestra.
  if (requiereKey && !hayKeyUsable()) mostrarModalApiKey(t("apikey_mensaje_falta"));
}
inicializarApiKey();

// --------------------------------------------------------------------------
// PASO 1 — Preparar zona (Plan A, requiere internet)
// Descarga y cachea el relieve de un área. Ya no tiene botón propio en la topbar
// (se unificó en "Descargar zona"); esta función la sigue usando el aviso del 409.
// --------------------------------------------------------------------------

// Descarga y cachea los tiles faltantes de un bbox. Lanza error con mensaje claro.
// Si el usuario tiene una key en el navegador, la manda por header (precede al
// .env). Si el backend avisa que falta/ no sirve la key, reabre el cartel.
async function prepararZona(bbox) {
  const headers = { "Content-Type": "application/json" };
  const key = getApiKey();
  if (key) headers["X-OpenTopography-Key"] = key;

  const resp = await fetch("/api/terrain/prepare", {
    method: "POST",
    headers,
    body: JSON.stringify({ bbox }),
  });
  if (!resp.ok) {
    await manejarErrorApiKey(resp);
    throw new Error(await mensajeDeError(resp));
  }
  return resp.json();
}

// --------------------------------------------------------------------------
// Capa de RELIEVE (hillshade del viewport)
// Si la zona no está cacheada (409), NO descarga: pide usar "Descargar zona".
// --------------------------------------------------------------------------
const SRC_RELIEVE = "relieve-src";
const LAYER_RELIEVE = "relieve-layer";
const btnRelieve = document.getElementById("btn-relieve");
let relieveActivo = false;

async function mostrarRelieve() {
  const bbox = bboxViewport();
  const resp = await fetch(`/api/terrain/hillshade?bbox=${bbox.join(",")}`);
  // 409 = la zona no está descargada. No es un error "feo": lo marcamos para
  // que el handler muestre un popup amable que invita a descargar la zona.
  if (resp.status === 409) {
    const err = new Error("offline");
    err.code = "offline";
    throw err;
  }
  if (!resp.ok) throw new Error(await mensajeDeError(resp));
  const xbbox = bboxDeHeader(resp, bbox);
  const blob = await resp.blob();
  agregarOverlayRaster(SRC_RELIEVE, LAYER_RELIEVE, blob, xbbox, 0.7);
}

btnRelieve.addEventListener("click", async () => {
  if (ocupado) return;

  // Apagar. El estado se ve por la clase .activo (relleno); el title alterna.
  if (relieveActivo) {
    quitarOverlay(SRC_RELIEVE, LAYER_RELIEVE);
    relieveActivo = false;
    btnRelieve.classList.remove("activo");
    btnRelieve.title = t("relieve_mostrar");
    setEstado("");
    return;
  }

  // Encender.
  setOcupado(true, t("generando_relieve"));
  try {
    await mostrarRelieve();
    relieveActivo = true;
    btnRelieve.classList.add("activo");
    btnRelieve.title = t("relieve_ocultar");
    setEstado("");
  } catch (e) {
    console.error(e);
    // Zona sin terreno descargado: popup amable en vez del error crudo del 409.
    if (e.code === "offline") {
      setEstado("");
      abrirPopupRelieve();
    } else {
      setEstado(t("relieve_error_prefijo") + e.message, true);
    }
  } finally {
    setOcupado(false);
  }
});

// El title del botón "Relieve" depende del estado (Mostrar/Ocultar): se
// recalcula al cambiar de idioma para no dejarlo en el idioma viejo.
onCambioIdioma(() => {
  btnRelieve.title = t(relieveActivo ? "relieve_ocultar" : "relieve_mostrar");
});

// --------------------------------------------------------------------------
// COBERTURA RF
// Click = ubicar Tx. "Calcular cobertura" computa local (NO descarga relieve).
// Se habilita solo con Tx puesto y zoom razonable.
// --------------------------------------------------------------------------
const SRC_COBERTURA = "cobertura-src";
const LAYER_COBERTURA = "cobertura-layer";

const panel = document.getElementById("panel-cobertura");
const avisoZoom = document.getElementById("aviso-zoom");
const inLat = document.getElementById("cob-lat");
const inLon = document.getElementById("cob-lon");
const btnCalcular = document.getElementById("btn-calcular");
const btnGuardar = document.getElementById("btn-guardar");
const btnExportar = document.getElementById("btn-exportar-kml");
let txMarker = null;
let ultimaCobertura = null; // params de la última cobertura calculada (para guardar)

// Habilita/inhabilita botones según contexto (zoom, Tx, ocupado).
function actualizarControles() {
  const zoomOk = map.getZoom() >= MIN_ZOOM_COBERTURA;
  const hayTx = !!(inLat.value && inLon.value);
  btnCalcular.disabled = ocupado || !hayTx || !zoomOk;
  btnGuardar.disabled = ocupado || !ultimaCobertura;
  // Exportar a Google Earth: mismo gate que Guardar (necesita una cobertura mostrada).
  btnExportar.disabled = ocupado || !ultimaCobertura;
  btnRelieve.disabled = ocupado;
  // Aviso de zoom solo cuando hay Tx pero el zoom es muy lejano.
  avisoZoom.hidden = !(hayTx && !zoomOk);
}

// Invalida la cobertura guardable: tras mover el Tx o cambiar un parámetro, lo
// que se ve en el mapa ya no corresponde al formulario, así que "Guardar" se
// deshabilita hasta volver a calcular.
function invalidarCobertura() {
  ultimaCobertura = null;
  actualizarControles();
}

function fijarTx(lat, lon) {
  inLat.value = lat.toFixed(5);
  inLon.value = lon.toFixed(5);
  ajustarAncho(inLat);
  ajustarAncho(inLon);
  if (txMarker) {
    txMarker.setLngLat([lon, lat]);
  } else {
    txMarker = new maplibregl.Marker({ color: "#b71c1c", draggable: true })
      .setLngLat([lon, lat])
      .addTo(map);
    txMarker.on("dragend", () => {
      const ll = txMarker.getLngLat();
      inLat.value = ll.lat.toFixed(5);
      inLon.value = ll.lng.toFixed(5);
      ajustarAncho(inLat);
      ajustarAncho(inLon);
      invalidarCobertura();
    });
  }
  panel.classList.add("visible");
  invalidarCobertura();
}

// Click = ubicar Tx. Ruteo por modo: en HF va al Tx del panel HF, en "mejor
// ubicación" agrega un vértice del perímetro que se está dibujando, en VHF al
// Tx de siempre (ruta VHF idéntica cuando modoActual === 'vhf').
map.on("click", (ev) => {
  if (modoActual === "hf") fijarTxHF(ev.lngLat.lat, ev.lngLat.lng);
  else if (modoActual === "mejor") agregarPuntoPoligono(ev.lngLat.lat, ev.lngLat.lng);
  else fijarTx(ev.lngLat.lat, ev.lngLat.lng);
});
map.on("zoom", actualizarControles);

btnCalcular.addEventListener("click", async () => {
  if (ocupado || btnCalcular.disabled) return;

  const body = {
    lat: parseFloat(inLat.value),
    lon: parseFloat(inLon.value),
    txh: parseFloat(document.getElementById("cob-txh").value),
    erp: parseFloat(document.getElementById("cob-erp").value),
    f: parseFloat(document.getElementById("cob-f").value),
    radius: parseFloat(document.getElementById("cob-radius").value),
    rxh: parseFloat(document.getElementById("cob-rxh").value),
    rt: parseFloat(document.getElementById("cob-rt").value),
    res: parseInt(document.getElementById("cob-res").value, 10),
  };

  // Política de radio (modelo síncrono): tope 100 km, aviso entre 60 y 100 km.
  if (body.radius > RADIO_MAX_KM) {
    // Mensaje honesto, no error: los radios grandes llegan con el worker async.
    setEstado(t("radio_max_msg", { max: RADIO_MAX_KM }));
    return;
  }
  if (body.radius > RADIO_AVISO_KM) {
    if (!confirm(t("radio_grande_confirm", { km: body.radius }))) {
      return;
    }
  }

  setOcupado(true, t("calculando_cobertura"));
  try {
    let resp = await pedirCobertura(body);

    // 409 con bbox de la HUELLA: la zona de la cobertura no está preparada.
    // Ofrecemos preparar exactamente esa área (Tx ± radio), no el viewport.
    if (resp.status === 409) {
      const detalle = await leerDetalle(resp);
      if (detalle && detalle.bbox) {
        const nTiles = tilesEnBbox(detalle.bbox);
        if (nTiles > MAX_TILES_PREPARAR) {
          throw new Error(t("cobertura_area_grande", { n: nTiles, max: MAX_TILES_PREPARAR }));
        }
        const faltan = (detalle.missing || []).length;
        // Aviso con peso si la descarga es grande; si no, confirm simple.
        const gb = (nTiles * 0.054).toFixed(1);
        const msg =
          nTiles > AVISO_TILES_PREPARAR
            ? t("vhf_zona_no_preparada_grande", { faltan, n: nTiles, gb })
            : t("vhf_zona_no_preparada_chica", { faltan, n: nTiles });
        if (confirm(msg)) {
          setEstado(t("preparando_area", { n: nTiles }));
          await prepararZona(detalle.bbox);
          setEstado(t("calculando_de_nuevo"));
          resp = await pedirCobertura(body); // reintento una vez
        } else {
          throw new Error(t("zona_no_preparada_error"));
        }
      }
    }

    if (!resp.ok) throw new Error(await mensajeDeError(resp));

    const bbox = bboxDeHeader(resp, bboxViewport());
    const blob = await resp.blob();
    agregarOverlayRaster(SRC_COBERTURA, LAYER_COBERTURA, blob, bbox, 0.6);
    // Recordamos los params de esta cobertura para poder guardarla.
    ultimaCobertura = body;
    setEstado("");
  } catch (e) {
    console.error(e);
    setEstado(t("cobertura_error_prefijo") + e.message, true);
  } finally {
    setOcupado(false);
  }
});

// POST /api/coverage con el cuerpo de parámetros.
function pedirCobertura(body) {
  return fetch("/api/coverage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Lee el `detail` de una respuesta JSON (objeto o string), tolerante a errores.
async function leerDetalle(resp) {
  try {
    return (await resp.clone().json()).detail;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// COBERTURAS GUARDADAS
// Guardar la última calculada con un nombre, listar las persistidas, y
// prender/apagar cada una en el mapa (varias a la vez = vista combinada).
// --------------------------------------------------------------------------
const listaGuardadas = document.getElementById("lista-guardadas");
const guardadasVacio = document.getElementById("guardadas-vacio");
// Coberturas actualmente encendidas en el mapa: id -> {srcId, layerId}.
const overlaysActivos = new Map();

// Resumen corto de params para mostrar en cada ítem.
function resumenParams(p) {
  return `${p.f} MHz · ${p.erp} W · r=${p.radius} km · Tx ${p.txh} m`;
}

// --- Modal para pedir el nombre (popup, no prompt nativo) ---
const modalGuardar = document.getElementById("modal-guardar");
const modalNombre = document.getElementById("modal-nombre");
const modalOk = document.getElementById("modal-ok");
const modalCancelar = document.getElementById("modal-cancelar");

// Muestra el modal y resuelve con el nombre (trim) o null si se cancela.
function pedirNombre() {
  return new Promise((resolve) => {
    modalNombre.value = "";
    modalGuardar.hidden = false;
    modalNombre.focus();

    const cerrar = (valor) => {
      modalGuardar.hidden = true;
      modalOk.removeEventListener("click", onOk);
      modalCancelar.removeEventListener("click", onCancel);
      modalNombre.removeEventListener("keydown", onKey);
      modalGuardar.removeEventListener("click", onFondo);
      resolve(valor);
    };
    const onOk = () => cerrar(modalNombre.value.trim() || null);
    const onCancel = () => cerrar(null);
    const onKey = (e) => {
      if (e.key === "Enter") onOk();
      else if (e.key === "Escape") onCancel();
    };
    // Click en el fondo oscuro (fuera del cuadro) = cancelar.
    const onFondo = (e) => {
      if (e.target === modalGuardar) onCancel();
    };

    modalOk.addEventListener("click", onOk);
    modalCancelar.addEventListener("click", onCancel);
    modalNombre.addEventListener("keydown", onKey);
    modalGuardar.addEventListener("click", onFondo);
  });
}

// Guarda la última cobertura calculada (pide un nombre por modal).
btnGuardar.addEventListener("click", async () => {
  if (ocupado || !ultimaCobertura) return;
  const nombre = await pedirNombre();
  if (!nombre) return;

  setOcupado(true, t("guardando_cobertura"));
  try {
    const resp = await fetch("/api/coverages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre, params: ultimaCobertura }),
    });
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    setEstado(t("cobertura_guardada", { nombre }));
    await cargarGuardadas();
  } catch (e) {
    console.error(e);
    setEstado(t("guardar_error_prefijo") + e.message, true);
  } finally {
    setOcupado(false);
  }
});

// --------------------------------------------------------------------------
// EXPORTAR A GOOGLE EARTH (KMZ)
// La cobertura actual se exporta SIN recalcular: el backend reusa el PNG/bbox ya
// generado (cache por params). Las guardadas leen su PNG+meta del disco.
// --------------------------------------------------------------------------

// Dispara la descarga de un blob con un nombre de archivo dado.
function descargarBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Liberamos la URL en el próximo tick (Firefox necesita que el click la use antes).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Saca el filename del header Content-Disposition (o usa un fallback).
function nombreDeContentDisposition(resp, fallback) {
  const cd = resp.headers.get("Content-Disposition") || "";
  // Preferimos filename* (UTF-8, RFC 5987); si no, el filename ASCII entre comillas.
  const estrella = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (estrella) return decodeURIComponent(estrella[1]);
  const simple = cd.match(/filename="?([^";]+)"?/i);
  return simple ? simple[1] : fallback;
}

// Nombre por defecto para la cobertura actual (transitoria, sin nombre propio).
function nombreCoberturaActual(p) {
  return `Cobertura ${p.f}MHz ${p.radius}km`;
}

// Exporta la cobertura ACTUAL (recién calculada) a KMZ.
btnExportar.addEventListener("click", async () => {
  if (ocupado || !ultimaCobertura) return;
  const nombre = nombreCoberturaActual(ultimaCobertura);

  setOcupado(true, t("exportando"));
  try {
    const resp = await fetch("/api/coverage/export.kmz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre, params: ultimaCobertura }),
    });
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    const blob = await resp.blob();
    descargarBlob(blob, nombreDeContentDisposition(resp, "cobertura.kmz"));
    setEstado(t("kmz_exportado"));
  } catch (e) {
    console.error(e);
    setEstado(t("exportar_error_prefijo") + e.message, true);
  } finally {
    setOcupado(false);
  }
});

// Exporta una cobertura GUARDADA a KMZ (descarga directa por ítem).
async function exportarGuardada(item) {
  setOcupado(true, t("exportando"));
  try {
    const resp = await fetch(`/api/coverages/${item.id}/export.kmz`);
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    const blob = await resp.blob();
    descargarBlob(blob, nombreDeContentDisposition(resp, `${item.nombre}.kmz`));
    setEstado(t("kmz_exportado"));
  } catch (e) {
    console.error(e);
    setEstado(t("exportar_error_prefijo") + e.message, true);
  } finally {
    setOcupado(false);
  }
}

// Prende/apaga el overlay de una cobertura guardada.
async function toggleGuardada(item, encender) {
  const srcId = `cov-src-${item.id}`;
  const layerId = `cov-layer-${item.id}`;
  if (!encender) {
    quitarOverlay(srcId, layerId);
    overlaysActivos.delete(item.id);
    return;
  }
  // Bajamos el PNG y lo superponemos usando el bbox del metadata.
  const resp = await fetch(item.overlay_url);
  if (!resp.ok) throw new Error(await mensajeDeError(resp));
  const blob = await resp.blob();
  agregarOverlayRaster(srcId, layerId, blob, item.bbox, 0.6);
  overlaysActivos.set(item.id, { srcId, layerId });
}

// Borra una cobertura guardada (y su overlay si está encendido).
async function borrarGuardada(item) {
  if (!confirm(t("borrar_confirm", { nombre: item.nombre }))) return;
  setOcupado(true, t("borrando"));
  try {
    const resp = await fetch(`/api/coverages/${item.id}`, { method: "DELETE" });
    if (!resp.ok && resp.status !== 204) throw new Error(await mensajeDeError(resp));
    if (overlaysActivos.has(item.id)) toggleGuardada(item, false);
    setEstado("");
    await cargarGuardadas();
  } catch (e) {
    console.error(e);
    setEstado(t("borrar_error_prefijo") + e.message, true);
  } finally {
    setOcupado(false);
  }
}

// Dibuja un ítem de la lista de guardadas.
function renderItem(item) {
  const li = document.createElement("li");

  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = overlaysActivos.has(item.id);
  chk.title = t("chk_toggle_title");
  chk.addEventListener("change", async () => {
    try {
      await toggleGuardada(item, chk.checked);
    } catch (e) {
      console.error(e);
      setEstado(t("overlay_error_prefijo") + e.message, true);
      chk.checked = overlaysActivos.has(item.id); // revertir si falló
    }
  });

  const info = document.createElement("div");
  info.className = "cob-info";
  info.title = t("info_click_title");
  info.innerHTML =
    `<div class="cob-nombre">${item.nombre}</div>` +
    `<div class="cob-params">${resumenParams(item.params)}</div>`;
  // Click en el texto: centra el mapa en la cobertura.
  info.addEventListener("click", () => {
    const [w, s, e, n] = item.bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 40 });
  });

  const exportar = document.createElement("button");
  exportar.className = "cob-exportar";
  exportar.textContent = "🌐";
  exportar.title = t("exportar_item_title");
  exportar.addEventListener("click", () => exportarGuardada(item));

  const del = document.createElement("button");
  del.className = "cob-borrar";
  del.textContent = "🗑";
  del.title = t("borrar_item_title");
  del.addEventListener("click", () => borrarGuardada(item));

  li.append(chk, info, exportar, del);
  return li;
}

// Carga la lista desde el backend y la dibuja (preserva las encendidas).
async function cargarGuardadas() {
  try {
    const resp = await fetch("/api/coverages");
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    const items = await resp.json();

    listaGuardadas.innerHTML = "";
    items.forEach((it) => listaGuardadas.appendChild(renderItem(it)));
    guardadasVacio.hidden = items.length > 0;

    // Si se borró alguna que estaba encendida, limpiamos su overlay huérfano.
    const ids = new Set(items.map((i) => i.id));
    for (const [id, ov] of overlaysActivos) {
      if (!ids.has(id)) {
        quitarOverlay(ov.srcId, ov.layerId);
        overlaysActivos.delete(id);
      }
    }
  } catch (e) {
    console.error(e);
    setEstado(t("guardadas_error_prefijo") + e.message, true);
  }
}

// Estado inicial de los controles + carga de coberturas guardadas.
map.on("load", () => {
  actualizarControles();
  cargarGuardadas();
});

// --------------------------------------------------------------------------
// Tooltips de ayuda: posicionamiento que SIEMPRE queda dentro de la pantalla.
// El tooltip usa position:fixed; acá calculamos su lugar al pasar el mouse o dar
// foco al ícono "i", haciendo "clamp" contra los bordes del viewport y volteándolo
// hacia abajo si no entra arriba. Así los íconos al borde no se cortan.
// --------------------------------------------------------------------------
function posicionarTip(info) {
  const tip = info.querySelector(".tip");
  if (!tip) return;
  const r = info.getBoundingClientRect();
  const margen = 8;
  // visibility:hidden conserva el layout, así que ya se puede medir.
  const ancho = tip.offsetWidth;
  const alto = tip.offsetHeight;

  // Centrado horizontal sobre el ícono, pero acotado a [margen, ancho-pantalla].
  let left = r.left + r.width / 2 - ancho / 2;
  left = Math.max(margen, Math.min(left, window.innerWidth - ancho - margen));

  // Por encima del ícono; si no hay lugar arriba, lo paso abajo.
  let top = r.top - alto - 8;
  if (top < margen) top = r.bottom + 8;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

document.querySelectorAll("#panel-cobertura .info").forEach((info) => {
  info.addEventListener("mouseenter", () => posicionarTip(info));
  info.addEventListener("focus", () => posicionarTip(info));
});

// --------------------------------------------------------------------------
// Ancho dinámico de los inputs: que se ajusten a la cantidad de dígitos para no
// cortar el valor. El CSS (min/max-width) acota el resultado para no desbordar.
// --------------------------------------------------------------------------
function ajustarAncho(input) {
  const txt = input.value || input.getAttribute("value") || "";
  // Largo del texto + margen para el cursor y las flechitas del input numérico.
  const chars = Math.max(txt.length, 2) + 2.5;
  input.style.width = `${chars}ch`;
}

const inputsCobertura = document.querySelectorAll("#panel-cobertura input");
inputsCobertura.forEach((inp) => {
  ajustarAncho(inp); // ajuste inicial (valores por defecto)
  inp.addEventListener("input", () => {
    ajustarAncho(inp);
    // Cambiar un parámetro invalida la cobertura calculada: hay que recalcular.
    invalidarCobertura();
  });
});

// ==========================================================================
// PANEL OFFLINE — descargas por región + overlay de caché (TODO ADITIVO)
//
// ⚠️ CONVENCIÓN DE BBOX (no mezclar):
// - API/regiones: [sur, oeste, norte, este]  (S, O, N, E)
// - viewport (bboxViewport) e interno: [oeste, sur, este, norte]  (O, S, E, N)
// - /api/terrain/cache por tile: [oeste, sur, este, norte]  (O, S, E, N)
// Las conversiones se hacen explícitas y comentadas en cada punto.
// ==========================================================================
const GB_POR_TILE = 0.054; // ~54 MB por tile COP30 (estimación, espejo del backend)
const UMBRAL_GB_AVISO = 3; // solo confirmamos por encima de ~3 GB (escala país)

// --- Elementos del panel ---
const panelOffline = document.getElementById("panel-offline");
const btnOffline = document.getElementById("btn-offline");
const selProvincia = document.getElementById("off-provincia");
const btnDescProv = document.getElementById("off-descargar-prov");
const btnDescVista = document.getElementById("off-descargar-vista");
const offProgreso = document.getElementById("off-progreso");
const offBarraFill = document.getElementById("off-barra-fill");
const offProgresoTxt = document.getElementById("off-progreso-txt");
const btnReintentar = document.getElementById("off-reintentar");
const chkCache = document.getElementById("off-toggle-cache");
const chkOceano = document.getElementById("off-toggle-oceano");
const offLeyenda = document.getElementById("off-leyenda");
const offResumen = document.getElementById("off-resumen");

const regionesPorClave = new Map(); // clave -> bbox [S, O, N, E]
let ultimaDescarga = null; // último payload enviado (para "Reintentar")
let pollTimer = null;

// Cuenta tiles 1°×1° de un bbox en orden API [S, O, N, E] (reusa tilesEnBbox O,S,E,N).
function tilesEnBboxSONE([s, o, n, e]) {
  return tilesEnBbox([o, s, e, n]);
}

function setProgresoTxt(texto) {
  offProgreso.hidden = false;
  offProgresoTxt.textContent = texto || "";
}

// Confirma solo si la descarga es realmente grande (escala país/multi-provincia).
// Igual informa tiles + GB aproximados en todos los casos.
function confirmarDescargaRegion(nTiles) {
  const gb = (nTiles * GB_POR_TILE).toFixed(1);
  if (nTiles * GB_POR_TILE > UMBRAL_GB_AVISO) {
    return confirm(t("off_descarga_grande_confirm", { n: nTiles, gb }));
  }
  return true; // provincias normales: no molestamos
}

// --- Carga del desplegable desde /api/regions (única fuente de verdad) ---
async function cargarRegiones() {
  try {
    const resp = await fetch("/api/regions");
    if (!resp.ok) return;
    const regiones = await resp.json();
    selProvincia.innerHTML = "";
    regiones.forEach((r) => {
      regionesPorClave.set(r.clave, r.bbox); // bbox [S, O, N, E]
      const opt = document.createElement("option");
      opt.value = r.clave;
      opt.textContent = r.nombre;
      selProvincia.appendChild(opt);
    });
  } catch {
    /* sin regiones: el panel sigue usable para "vista actual" */
  }
}

// --- Disparar una descarga (provincia o vista) ---
async function iniciarDescarga(payload, bboxSONE) {
  const nTiles = tilesEnBboxSONE(bboxSONE);
  if (!confirmarDescargaRegion(nTiles)) return;

  const gb = (nTiles * GB_POR_TILE).toFixed(1);
  setProgresoTxt(t("off_iniciando_descarga", { n: nTiles, gb }));
  mostrarReintentar(false);

  try {
    const resp = await fetch("/api/terrain/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status === 409) {
      setProgresoTxt(t("off_descarga_en_curso"));
      arrancarPoll();
      return;
    }
    if (!resp.ok) {
      setProgresoTxt(t("off_descarga_no_iniciada", { motivo: await mensajeDeError(resp) }));
      return;
    }
    ultimaDescarga = { payload, bboxSONE };
    arrancarPoll();
  } catch (e) {
    console.error(e);
    setProgresoTxt(t("off_descarga_red_error"));
  }
}

btnDescProv.addEventListener("click", () => {
  const clave = selProvincia.value;
  const bboxSONE = regionesPorClave.get(clave);
  if (!bboxSONE) return;
  iniciarDescarga({ provincia: clave }, bboxSONE);
});

btnDescVista.addEventListener("click", () => {
  // viewport: [O, S, E, N]  ->  API: [S, O, N, E]
  const [o, s, e, n] = bboxViewport();
  const bboxSONE = [s, o, n, e];
  iniciarDescarga({ bbox: bboxSONE }, bboxSONE);
});

btnReintentar.addEventListener("click", () => {
  if (ultimaDescarga) iniciarDescarga(ultimaDescarga.payload, ultimaDescarga.bboxSONE);
});

// --- Poll del estado de descarga ---
function arrancarPoll() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, 1500);
}
function pararPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function deshabilitarDescargas(on) {
  btnDescProv.disabled = on;
  btnDescVista.disabled = on;
  selProvincia.disabled = on;
}

function mostrarReintentar(on) {
  btnReintentar.hidden = !on;
}

function renderProgreso(st) {
  offProgreso.hidden = false;
  const pct = st.total > 0 ? Math.round((100 * st.done) / st.total) : 0;
  offBarraFill.style.width = `${pct}%`;
  const partes = [t("off_progreso_tiles", { done: st.done, total: st.total })];
  if (st.ocean) partes.push(t("off_progreso_oceano", { n: st.ocean }));
  if (st.failed) partes.push(t("off_progreso_fallidos", { n: st.failed }));
  let txt = partes.join(" · ");
  if (st.state === "running" && st.current) txt += ` · ${st.current}`;
  if (st.message && st.state !== "running") txt = st.message + ` (${partes.join(" · ")})`;
  offProgresoTxt.textContent = txt;
}

async function pollOnce() {
  let st;
  try {
    const resp = await fetch("/api/terrain/download/status");
    st = await resp.json();
  } catch {
    return; // un poll que falla: reintentamos en el próximo tick
  }
  renderProgreso(st);

  if (st.state === "running") {
    deshabilitarDescargas(true);
    return;
  }
  // Terminó (done/error/idle): paramos el poll y refrescamos la caché.
  deshabilitarDescargas(false);
  pararPoll();
  if (st.state !== "idle") await actualizarCache(true);
  mostrarReintentar(st.state === "error" && (st.failed || 0) > 0);
}

// --------------------------------------------------------------------------
// OVERLAY DE CACHÉ — capa GeoJSON nueva (aditiva, no toca el basemap)
// --------------------------------------------------------------------------
const CACHE_SRC = "cache-src";
const CACHE_FILL = "cache-fill";
const CACHE_LINE = "cache-line";
let cacheTiles = []; // [{tile_id, bbox:[O,S,E,N], ocean}]

// Construye la FeatureCollection de cuadrados (filtra océano según el toggle).
function construirFC(incluirOceano) {
  const features = cacheTiles
    .filter((t) => incluirOceano || !t.ocean)
    .map((t) => {
      const [w, s, e, n] = t.bbox; // [O, S, E, N]
      return {
        type: "Feature",
        properties: { ocean: t.ocean },
        geometry: {
          type: "Polygon",
          coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
        },
      };
    });
  return { type: "FeatureCollection", features };
}

function pintarCache() {
  const fc = construirFC(chkOceano.checked);
  const src = map.getSource(CACHE_SRC);
  if (src) {
    src.setData(fc);
    return;
  }
  map.addSource(CACHE_SRC, { type: "geojson", data: fc });
  // Relleno: tierra verde tenue / océano gris-azulado muy de-enfatizado.
  map.addLayer({
    id: CACHE_FILL,
    type: "fill",
    source: CACHE_SRC,
    paint: {
      "fill-color": ["case", ["get", "ocean"], "#90a4ae", "#2e7d32"],
      "fill-opacity": ["case", ["get", "ocean"], 0.18, 0.3],
    },
  });
  // Borde: tierra marcado; océano apenas visible.
  map.addLayer({
    id: CACHE_LINE,
    type: "line",
    source: CACHE_SRC,
    paint: {
      "line-color": ["case", ["get", "ocean"], "#90a4ae", "#2e7d32"],
      "line-width": ["case", ["get", "ocean"], 0.5, 1.5],
    },
  });
}

function quitarCacheOverlay() {
  if (map.getLayer(CACHE_LINE)) map.removeLayer(CACHE_LINE);
  if (map.getLayer(CACHE_FILL)) map.removeLayer(CACHE_FILL);
  if (map.getSource(CACHE_SRC)) map.removeSource(CACHE_SRC);
}

// Trae /api/terrain/cache, actualiza el resumen y (si corresponde) el overlay.
async function actualizarCache(refrescarOverlay = false) {
  try {
    const resp = await fetch("/api/terrain/cache");
    if (!resp.ok) return;
    const data = await resp.json();
    cacheTiles = data.tiles || [];
    const r = data.resumen || { tiles: 0, tamano_total_mb: 0 };
    offResumen.textContent = t("off_resumen", { tiles: r.tiles, mb: r.tamano_total_mb });
    // Si el toggle está tildado (lo está por defecto), pintamos y mostramos la leyenda.
    if (refrescarOverlay && chkCache.checked) {
      pintarCache();
      offLeyenda.hidden = false;
    }
  } catch {
    /* sin caché aún: dejamos el resumen como está */
  }
}

chkCache.addEventListener("change", async () => {
  if (chkCache.checked) {
    if (!cacheTiles.length) await actualizarCache(false);
    pintarCache();
    offLeyenda.hidden = false;
  } else {
    quitarCacheOverlay();
    offLeyenda.hidden = true;
  }
});

chkOceano.addEventListener("change", () => {
  if (chkCache.checked) pintarCache(); // rebuild con/ sin océano
});

// --- Panel "Descargar zona" del topbar ---------------------------------------
// Helper reusable: deja el panel ABIERTO (lo usa el botón del topbar y también
// el popup de "relieve sin datos"). Refresca el resumen de caché al abrir.
function abrirPanelOffline() {
  if (!panelOffline.classList.contains("visible")) {
    panelOffline.classList.add("visible");
    btnOffline.classList.add("activo");
    actualizarCache(true); // refresca resumen + pinta el overlay (toggle tildado)
  }
}

// El botón del topbar abre/cierra (toggle); el helper de arriba solo abre.
btnOffline.addEventListener("click", () => {
  const visible = panelOffline.classList.toggle("visible");
  btnOffline.classList.toggle("activo", visible);
  if (visible) actualizarCache(true); // al abrir: resumen + overlay (toggle tildado)
});

// --- Popup "relieve sin datos" -----------------------------------------------
// Se abre cuando se activa "Relieve" sobre una zona sin terreno descargado (409).
const modalRelieve = document.getElementById("modal-relieve");
const relieveDescargar = document.getElementById("relieve-descargar");
const relieveCerrar = document.getElementById("relieve-cerrar");

function abrirPopupRelieve() {
  modalRelieve.hidden = false;
}
function cerrarPopupRelieve() {
  modalRelieve.hidden = true;
}

// "Descargar zona": cierra el popup y abre el panel de descarga (vista actual lista).
relieveDescargar.addEventListener("click", () => {
  cerrarPopupRelieve();
  abrirPanelOffline();
});
relieveCerrar.addEventListener("click", cerrarPopupRelieve);
// Click en el fondo oscuro (fuera de la tarjeta) también cierra.
modalRelieve.addEventListener("click", (e) => {
  if (e.target === modalRelieve) cerrarPopupRelieve();
});

// --- Init: cargar regiones y reanudar poll si había una descarga en curso ---
(async function inicializarOffline() {
  await cargarRegiones();
  try {
    const st = await (await fetch("/api/terrain/download/status")).json();
    if (st.state === "running") {
      panelOffline.classList.add("visible");
      btnOffline.classList.add("activo");
      arrancarPoll();
    }
  } catch {
    /* sin estado previo: nada que reanudar */
  }
})();

// =============================================================================
// TOUR GUIADO DE PRIMER INGRESO (custom, sin dependencias)
// Resalta paso a paso los elementos clave con un spotlight (overlay oscuro con
// un "agujero" sobre el elemento) + un cartel con el texto. Se muestra solo la
// primera vez (flag en localStorage); el botón "?" lo reabre cuando se quiera.
// =============================================================================
const TOUR_FLAG = "radiolocal_tour_visto";

// Cada paso: selector(es) del elemento a resaltar (null = cartel centrado, sin
// spotlight) y la CLAVE de traducción del texto (ver i18n.js: tour_paso_0..6).
// Para resaltar un área compuesta se pasa un array de selectores y se usa la
// unión de sus rectángulos.
const TOUR_PASOS = [
  { sel: null, clave: "tour_paso_0" },
  { sel: ["#btn-offline", "#idioma-selector"], clave: "tour_paso_1" },
  { sel: "#panel-cobertura", clave: "tour_paso_2" },
  { sel: "#btn-calcular", clave: "tour_paso_3" },
  { sel: "#btn-relieve", clave: "tour_paso_4" },
  { sel: ["#btn-guardar", "#guardadas"], clave: "tour_paso_5" },
  { sel: null, clave: "tour_paso_6" },
];

const tourOverlay = document.getElementById("tour-overlay");
const tourSpot = document.getElementById("tour-spot");
const tourCartel = document.getElementById("tour-cartel");
const tourPaso = document.getElementById("tour-paso");
const tourTexto = document.getElementById("tour-texto");
const tourAnterior = document.getElementById("tour-anterior");
const tourSiguiente = document.getElementById("tour-siguiente");
const tourOmitir = document.getElementById("tour-omitir");
const btnAyuda = document.getElementById("btn-ayuda");

let tourIndice = 0;

// Rectángulo (en coordenadas de viewport) que envuelve a uno o varios elementos.
function tourRectDe(sel) {
  const sels = Array.isArray(sel) ? sel : [sel];
  let r = null;
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) continue;
    const b = el.getBoundingClientRect();
    r = r
      ? {
          top: Math.min(r.top, b.top),
          left: Math.min(r.left, b.left),
          right: Math.max(r.right, b.right),
          bottom: Math.max(r.bottom, b.bottom),
        }
      : { top: b.top, left: b.left, right: b.right, bottom: b.bottom };
  }
  return r;
}

// Pinta el paso actual: posiciona el spotlight y el cartel, y ajusta botones.
function tourRender() {
  const paso = TOUR_PASOS[tourIndice];
  tourPaso.textContent = t("tour_paso_contador", { n: tourIndice + 1, total: TOUR_PASOS.length });
  tourTexto.textContent = t(paso.clave);

  // Navegación: "Anterior" oculto en el primero; "Siguiente"→"Finalizar" al final.
  tourAnterior.style.visibility = tourIndice === 0 ? "hidden" : "visible";
  tourSiguiente.textContent = t(
    tourIndice === TOUR_PASOS.length - 1 ? "tour_finalizar" : "tour_siguiente"
  );

  const rect = paso.sel ? tourRectDe(paso.sel) : null;

  if (!rect) {
    // Sin target: oscurecemos todo (sin agujero) y centramos el cartel.
    tourSpot.hidden = true;
    tourOverlay.classList.add("sin-spot");
    tourCartel.classList.add("centrado");
    tourCartel.style.top = "";
    tourCartel.style.left = "";
    return;
  }
  tourOverlay.classList.remove("sin-spot");

  // Spotlight con un padding alrededor del elemento.
  const pad = 6;
  const top = rect.top - pad;
  const left = rect.left - pad;
  const ancho = rect.right - rect.left + pad * 2;
  const alto = rect.bottom - rect.top + pad * 2;
  tourSpot.hidden = false;
  tourSpot.style.top = `${top}px`;
  tourSpot.style.left = `${left}px`;
  tourSpot.style.width = `${ancho}px`;
  tourSpot.style.height = `${alto}px`;

  // Ubicación del cartel: debajo del elemento si hay lugar; si no, arriba.
  tourCartel.classList.remove("centrado");
  const cartelW = 320;
  const margen = 12;
  let cTop = rect.bottom + margen;
  if (cTop + 160 > window.innerHeight) {
    cTop = Math.max(margen, rect.top - 160 - margen);
  }
  let cLeft = rect.left + (rect.right - rect.left) / 2 - cartelW / 2;
  cLeft = Math.max(margen, Math.min(cLeft, window.innerWidth - cartelW - margen));
  tourCartel.style.top = `${cTop}px`;
  tourCartel.style.left = `${cLeft}px`;
}

function tourAbrir(indice = 0) {
  tourIndice = indice;
  tourOverlay.hidden = false;
  tourRender();
}

function tourCerrar() {
  tourOverlay.hidden = true;
  localStorage.setItem(TOUR_FLAG, "1"); // no reaparece en la próxima visita
}

function tourIr(delta) {
  const next = tourIndice + delta;
  if (next < 0) return;
  if (next >= TOUR_PASOS.length) {
    tourCerrar();
    return;
  }
  tourIndice = next;
  tourRender();
}

tourSiguiente.addEventListener("click", () => tourIr(1));
tourAnterior.addEventListener("click", () => tourIr(-1));
tourOmitir.addEventListener("click", tourCerrar);
btnAyuda.addEventListener("click", () => tourAbrir(0));
// Si cambia el tamaño de la ventana, recolocamos el spotlight sobre su target.
window.addEventListener("resize", () => {
  if (!tourOverlay.hidden) tourRender();
});
// Re-renderiza el paso actual si cambia el idioma mientras el tour está abierto.
onCambioIdioma(() => {
  if (!tourOverlay.hidden) tourRender();
});

// Primera visita: arrancamos el tour automáticamente.
if (!localStorage.getItem(TOUR_FLAG)) {
  tourAbrir(0);
}

// ==========================================================================
// MODO HF — cobertura de propagación HF (ITU-R P.533). TODO ADITIVO.
//
// En modo VHF nada de esto interviene: la app se comporta igual que siempre.
// El toggle del topbar alterna entre el panel VHF y el panel HF, limpiando el
// overlay del otro modo para que no se mezclen cálculos.
// ==========================================================================
const SRC_HF = "hf-src";
const LAYER_HF = "hf-layer";

let modoActual = "vhf"; // 'vhf' | 'hf' | 'mejor'
let txMarkerHF = null; // marcador del Tx en modo HF (separado del de VHF)

const btnModoVHF = document.getElementById("modo-vhf");
const btnModoHF = document.getElementById("modo-hf");
const btnModoMejor = document.getElementById("modo-mejor");
const panelHF = document.getElementById("panel-hf");
const btnOfflineTop = document.getElementById("btn-offline");
const hfLat = document.getElementById("hf-lat");
const hfLon = document.getElementById("hf-lon");
const hfBanda = document.getElementById("hf-banda");
const hfFreqOtraCampo = document.getElementById("hf-freq-otra-campo");
const hfFreqOtra = document.getElementById("hf-freq-otra");
const hfAlcance = document.getElementById("hf-alcance");
const hfMes = document.getElementById("hf-mes");
const hfHora = document.getElementById("hf-hora");
const hfSsnTxt = document.getElementById("hf-ssn-txt");
const hfSsnOverride = document.getElementById("hf-ssn-override");
const hfRuido = document.getElementById("hf-ruido");
const hfCalcular = document.getElementById("hf-calcular");
const hfLeyenda = document.getElementById("hf-leyenda");
const hfSsnFuente = document.getElementById("hf-ssn-fuente");

// Meses y alcances HF: claves de traducción, no texto fijo (ver i18n.js).
const MESES_CLAVES = [
  "mes_1", "mes_2", "mes_3", "mes_4", "mes_5", "mes_6",
  "mes_7", "mes_8", "mes_9", "mes_10", "mes_11", "mes_12",
];

// Alcances HF (radio en km, área CENTRADA en el Tx). Único lugar de la UI donde se
// definen; deben coincidir con los presets de config.py del backend. El área NO
// depende del zoom del mapa (HF es de larga distancia).
const ALCANCES_HF = [
  { km: 2000, clave: "hf_alcance_regional" },
  { km: 4000, clave: "hf_alcance_continental" }, // default
  { km: 7000, clave: "hf_alcance_dx" },
];
const ALCANCE_DEFAULT_KM = 4000;

// Poblar los selects de mes (1-12), hora (0-23) y alcance, con default = UTC
// actual. Re-invocable: al cambiar de idioma se vuelve a llamar (ver
// onCambioIdioma más abajo), preservando la opción ya elegida por `value`
// (estable entre idiomas: son números, solo cambia el texto visible).
function poblarSelectsHF() {
  const mesPrevio = hfMes.value;
  const horaPrevia = hfHora.value;
  const alcancePrevio = hfAlcance.value;

  const ahora = new Date();
  const mesUTC = ahora.getUTCMonth() + 1; // 1-12
  const horaUTC = ahora.getUTCHours(); // 0-23

  hfMes.innerHTML = "";
  MESES_CLAVES.forEach((clave, i) => {
    const op = document.createElement("option");
    op.value = String(i + 1);
    op.textContent = t(clave).charAt(0).toUpperCase() + t(clave).slice(1);
    hfMes.appendChild(op);
  });
  hfMes.value = mesPrevio || String(mesUTC);

  hfHora.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const op = document.createElement("option");
    op.value = String(h);
    op.textContent = `${String(h).padStart(2, "0")}:00`;
    hfHora.appendChild(op);
  }
  hfHora.value = horaPrevia || String(horaUTC);

  hfAlcance.innerHTML = "";
  ALCANCES_HF.forEach(({ km, clave }) => {
    const op = document.createElement("option");
    op.value = String(km);
    op.textContent = t(clave);
    hfAlcance.appendChild(op);
  });
  hfAlcance.value = alcancePrevio || String(ALCANCE_DEFAULT_KM);
}
poblarSelectsHF();
onCambioIdioma(poblarSelectsHF);

// Frecuencia (MHz) elegida: de la banda o del campo libre "Otra".
function hfFrecuencia() {
  if (hfBanda.value === "otra") return parseFloat(hfFreqOtra.value);
  return parseFloat(hfBanda.value);
}

hfBanda.addEventListener("change", () => {
  hfFreqOtraCampo.hidden = hfBanda.value !== "otra";
});

// Habilita "Calcular" sólo con Tx puesto (el área grande la corta el backend).
function actualizarControlesHF() {
  const hayTx = !!(hfLat.value && hfLon.value);
  hfCalcular.disabled = ocupado || !hayTx;
}
map.on("zoom", actualizarControlesHF);

function fijarTxHF(lat, lon) {
  hfLat.value = lat.toFixed(5);
  hfLon.value = lon.toFixed(5);
  if (txMarkerHF) {
    txMarkerHF.setLngLat([lon, lat]);
  } else {
    txMarkerHF = new maplibregl.Marker({ color: "#b71c1c", draggable: true })
      .setLngLat([lon, lat])
      .addTo(map);
    txMarkerHF.on("dragend", () => {
      const ll = txMarkerHF.getLngLat();
      hfLat.value = ll.lat.toFixed(5);
      hfLon.value = ll.lng.toFixed(5);
      actualizarControlesHF();
    });
  }
  actualizarControlesHF();
}

// GET /api/hf/ssn: resuelve el SSN del mes/año y muestra su procedencia.
async function cargarSSN() {
  const year = new Date().getUTCFullYear();
  const month = parseInt(hfMes.value, 10);
  hfSsnTxt.textContent = t("hf_ssn_cargando");
  try {
    const resp = await fetch(`/api/hf/ssn?year=${year}&month=${month}`);
    if (!resp.ok) throw new Error("no");
    const d = await resp.json();
    hfSsnTxt.textContent = `${t("hf_ssn_prefijo")} ${d.value} · ${etiquetaFuenteSSN(d.source)}`;
  } catch {
    hfSsnTxt.textContent = t("hf_ssn_sin_datos");
  }
}

// Traduce la procedencia del SSN a un texto para el usuario.
function etiquetaFuenteSSN(source) {
  if (source === "noaa" || source === "cache") return t("hf_fuente_noaa");
  if (source === "manual") return t("hf_fuente_manual");
  return t("hf_fuente_default");
}

hfMes.addEventListener("change", cargarSSN);
// Si el modo HF está activo cuando cambia el idioma, refrescar el SSN mostrado
// (evita dejar "pronóstico NOAA"/etc. en el idioma viejo).
onCambioIdioma(() => {
  if (modoActual === "hf") cargarSSN();
});

// --- Toggle de modo VHF | HF | Mejor ubicación ---
function setModo(modo) {
  if (modo === modoActual) return;
  const anterior = modoActual;
  modoActual = modo;

  btnModoVHF.classList.toggle("activo", modo === "vhf");
  btnModoHF.classList.toggle("activo", modo === "hf");
  btnModoMejor.classList.toggle("activo", modo === "mejor");
  btnModoVHF.setAttribute("aria-selected", String(modo === "vhf"));
  btnModoHF.setAttribute("aria-selected", String(modo === "hf"));
  btnModoMejor.setAttribute("aria-selected", String(modo === "mejor"));

  // Salir del modo anterior: cada modo limpia SOLO lo suyo (no se mezclan overlays).
  if (anterior === "hf") {
    panelHF.classList.remove("visible");
    quitarOverlay(SRC_HF, LAYER_HF);
  } else if (anterior === "mejor") {
    panelMejor.classList.remove("visible");
    salirModoDibujo();
  } else {
    panel.classList.remove("visible");
    quitarOverlay(SRC_COBERTURA, LAYER_COBERTURA);
  }

  setEstado("");

  if (modo === "hf") {
    // Apagar relieve si estaba activo (HF no usa DEM) y ocultar sus botones.
    if (relieveActivo) {
      quitarOverlay(SRC_RELIEVE, LAYER_RELIEVE);
      relieveActivo = false;
      btnRelieve.classList.remove("activo");
      btnRelieve.title = t("relieve_mostrar");
    }
    btnRelieve.hidden = true;
    btnOfflineTop.hidden = true;
    panelOffline.classList.remove("visible");
    panelHF.classList.add("visible");
    // HF cubre miles de km: si el zoom está muy cerrado, alejamos suave.
    if (map.getZoom() > 6) map.easeTo({ zoom: 5, duration: 600 });
    cargarSSN();
    actualizarControlesHF();
  } else if (modo === "mejor") {
    // Usa relieve/DEM igual que VHF (a diferencia de HF): Relieve/Descargar
    // zona siguen disponibles.
    btnRelieve.hidden = false;
    btnOfflineTop.hidden = false;
    panelMejor.classList.add("visible");
    entrarModoDibujo();
  } else {
    // Volver a VHF.
    btnRelieve.hidden = false;
    btnOfflineTop.hidden = false;
    panel.classList.add("visible");
    actualizarControles();
  }
}

btnModoVHF.addEventListener("click", () => setModo("vhf"));
btnModoHF.addEventListener("click", () => setModo("hf"));
btnModoMejor.addEventListener("click", () => setModo("mejor"));

// --- Cálculo de cobertura HF ---
hfCalcular.addEventListener("click", async () => {
  if (ocupado || hfCalcular.disabled) return;

  const freq = hfFrecuencia();
  if (!freq || freq <= 0) {
    setEstado(t("hf_frecuencia_invalida"), true);
    return;
  }

  // El área es CENTRADA en el Tx con el alcance elegido: NO depende del zoom del
  // mapa. El backend deriva el bbox (Tx ± range_km).
  const body = {
    tx_lat: parseFloat(hfLat.value),
    tx_lon: parseFloat(hfLon.value),
    frequency_mhz: freq,
    month: parseInt(hfMes.value, 10),
    hour_utc: parseInt(hfHora.value, 10),
    noise: hfRuido.value,
    range_km: parseInt(hfAlcance.value, 10),
  };
  // SSN sólo si el usuario lo overrideó en Avanzado; si no, lo resuelve el backend.
  const override = hfSsnOverride.value.trim();
  if (override !== "") body.ssn = parseInt(override, 10);

  setOcupado(true, t("hf_calculando"));
  hfCalcular.disabled = true;
  try {
    const resp = await fetch("/api/hf/coverage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // 422: guard del backend (área muy grande o muy chica). Mostramos el mensaje
    // amable que ya viene en {detail} (p. ej. "alejá el mapa"), no uno hardcodeado.
    if (resp.status === 422) {
      setEstado(await mensajeDeError(resp), true);
      return;
    }
    if (!resp.ok) throw new Error(await mensajeDeError(resp));

    // Sin fallback de viewport: el área la define el backend (Tx ± alcance). El
    // X-Bbox del resultado es la única fuente de los bounds.
    const bbox = bboxDeHeader(resp, bboxViewport());
    const blob = await resp.blob();
    agregarOverlayRaster(SRC_HF, LAYER_HF, blob, bbox, 0.6);
    // Encuadre automático: mostrar toda la cobertura sin importar el zoom previo.
    const [bw, bs, be, bn] = bbox;
    map.fitBounds([[bw, bs], [be, bn]], { padding: 40, duration: 700 });

    // Procedencia del SSN que usó el cálculo (headers X-SSN*).
    const ssnVal = resp.headers.get("X-SSN");
    const ssnSrc = resp.headers.get("X-SSN-Source") || "";
    if (ssnVal) {
      hfSsnFuente.textContent = t("hf_ssn_usado", { val: ssnVal, fuente: etiquetaFuenteSSN(ssnSrc) });
    }
    hfLeyenda.hidden = false;
    setEstado("");
  } catch (err) {
    console.error(err);
    setEstado(t("hf_error_prefijo") + err.message, true);
  } finally {
    setOcupado(false);
    actualizarControlesHF();
  }
});

// ==========================================================================
// MODO "MEJOR UBICACIÓN" — dibujar un perímetro y buscar el mejor punto para
// una repetidora (TODO ADITIVO). Usa relieve/DEM igual que VHF: a diferencia
// de HF, "Relieve" y "Descargar zona" quedan disponibles en este modo.
//
// El mapa entra en "modo dibujo": cada click agrega un vértice. Cerrar el
// área es explícito ("Cerrar área", o clickear cerca del primer punto) pero
// también automático: "Buscar mejor ubicación" cierra el perímetro solo si el
// usuario no lo cerró a mano (con 3+ puntos alcanza para calcular el área).
// ==========================================================================
const SRC_MEJOR_FORMA = "mejor-forma-src";
const LAYER_MEJOR_RELLENO = "mejor-forma-relleno";
const LAYER_MEJOR_LINEA = "mejor-forma-linea";
const SRC_MEJOR_PUNTOS = "mejor-puntos-src";
const LAYER_MEJOR_PUNTOS = "mejor-puntos-layer";
const SRC_MEJOR = "mejor-cobertura-src";
const LAYER_MEJOR = "mejor-cobertura-layer";

const UMBRAL_CIERRE_PX = 12; // click a esta distancia (px) del primer punto = cerrar

const panelMejor = document.getElementById("panel-mejor");
const mejorContador = document.getElementById("mejor-contador");
const mejorCerrar = document.getElementById("mejor-cerrar");
const mejorReiniciar = document.getElementById("mejor-reiniciar");
const mejorCalcular = document.getElementById("mejor-calcular");
const mejorResultadoTxt = document.getElementById("mejor-resultado");

let puntosPoligono = []; // [[lat, lon], ...] en el orden en que se dibujaron
let poligonoCerrado = false;
let mejorMarker = null;

// --- Dibujo del perímetro en el mapa (GeoJSON, aditivo) ---------------------
function formaGeoJSON() {
  const coords = puntosPoligono.map(([lat, lon]) => [lon, lat]);
  if (coords.length < 2) return { type: "FeatureCollection", features: [] };
  // Cerrado -> Polygon (la capa "fill" solo pinta geometría de polígono, la
  // capa "line" dibuja igual el contorno). Abierto -> LineString (solo el trazo).
  const geometry =
    poligonoCerrado && coords.length >= 3
      ? { type: "Polygon", coordinates: [[...coords, coords[0]]] }
      : { type: "LineString", coordinates: coords };
  return { type: "FeatureCollection", features: [{ type: "Feature", geometry, properties: {} }] };
}

function puntosGeoJSON() {
  return {
    type: "FeatureCollection",
    features: puntosPoligono.map(([lat, lon]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {},
    })),
  };
}

function pintarDibujo() {
  const forma = formaGeoJSON();
  const srcForma = map.getSource(SRC_MEJOR_FORMA);
  if (srcForma) {
    srcForma.setData(forma);
  } else {
    map.addSource(SRC_MEJOR_FORMA, { type: "geojson", data: forma });
    map.addLayer({
      id: LAYER_MEJOR_RELLENO,
      type: "fill",
      source: SRC_MEJOR_FORMA,
      paint: { "fill-color": "#b71c1c", "fill-opacity": 0.15 },
    });
    map.addLayer({
      id: LAYER_MEJOR_LINEA,
      type: "line",
      source: SRC_MEJOR_FORMA,
      paint: { "line-color": "#b71c1c", "line-width": 2, "line-dasharray": [2, 1] },
    });
  }

  const puntos = puntosGeoJSON();
  const srcPuntos = map.getSource(SRC_MEJOR_PUNTOS);
  if (srcPuntos) {
    srcPuntos.setData(puntos);
  } else {
    map.addSource(SRC_MEJOR_PUNTOS, { type: "geojson", data: puntos });
    map.addLayer({
      id: LAYER_MEJOR_PUNTOS,
      type: "circle",
      source: SRC_MEJOR_PUNTOS,
      paint: {
        "circle-radius": 5,
        "circle-color": "#fff",
        "circle-stroke-color": "#b71c1c",
        "circle-stroke-width": 2,
      },
    });
  }
}

function quitarDibujo() {
  if (map.getLayer(LAYER_MEJOR_PUNTOS)) map.removeLayer(LAYER_MEJOR_PUNTOS);
  if (map.getSource(SRC_MEJOR_PUNTOS)) map.removeSource(SRC_MEJOR_PUNTOS);
  if (map.getLayer(LAYER_MEJOR_LINEA)) map.removeLayer(LAYER_MEJOR_LINEA);
  if (map.getLayer(LAYER_MEJOR_RELLENO)) map.removeLayer(LAYER_MEJOR_RELLENO);
  if (map.getSource(SRC_MEJOR_FORMA)) map.removeSource(SRC_MEJOR_FORMA);
}

function colocarMarcadorMejor(lat, lon) {
  if (mejorMarker) {
    mejorMarker.setLngLat([lon, lat]);
  } else {
    mejorMarker = new maplibregl.Marker({ color: "#1a9850" }).setLngLat([lon, lat]).addTo(map);
  }
}

function quitarMarcadorMejor() {
  if (mejorMarker) {
    mejorMarker.remove();
    mejorMarker = null;
  }
}

// --- Estado de los controles del panel --------------------------------------
function actualizarControlesMejor() {
  mejorContador.textContent = t("mejor_contador", { n: puntosPoligono.length });
  mejorCerrar.disabled = ocupado || poligonoCerrado || puntosPoligono.length < 3;
  mejorReiniciar.disabled = ocupado || puntosPoligono.length === 0;
  mejorCalcular.disabled = ocupado || puntosPoligono.length < 3;
}
// El contador de puntos es visible mientras el panel está abierto: refrescarlo
// al cambiar de idioma evita dejarlo en el idioma viejo.
onCambioIdioma(() => {
  if (modoActual === "mejor") actualizarControlesMejor();
});

// --- Agregar/cerrar/reiniciar el perímetro -----------------------------------
function agregarPuntoPoligono(lat, lon) {
  if (poligonoCerrado) return; // ya cerrado: "Reiniciar" para dibujar de nuevo

  // Click cerca del primer punto (con 3+ puntos ya puestos) = cerrar el área,
  // igual que la mayoría de las herramientas de dibujo de polígonos.
  if (puntosPoligono.length >= 3) {
    const primero = map.project([puntosPoligono[0][1], puntosPoligono[0][0]]);
    const clic = map.project([lon, lat]);
    if (Math.hypot(primero.x - clic.x, primero.y - clic.y) <= UMBRAL_CIERRE_PX) {
      cerrarPoligono();
      return;
    }
  }

  puntosPoligono.push([lat, lon]);
  pintarDibujo();
  actualizarControlesMejor();
}

function cerrarPoligono() {
  if (poligonoCerrado || puntosPoligono.length < 3) return;
  poligonoCerrado = true;
  pintarDibujo();
  actualizarControlesMejor();
}

function reiniciarDibujo() {
  puntosPoligono = [];
  poligonoCerrado = false;
  quitarMarcadorMejor();
  quitarOverlay(SRC_MEJOR, LAYER_MEJOR);
  mejorResultadoTxt.hidden = true;
  pintarDibujo();
  actualizarControlesMejor();
}

function entrarModoDibujo() {
  puntosPoligono = [];
  poligonoCerrado = false;
  map.doubleClickZoom.disable(); // clicks seguidos para poner puntos, sin zoom accidental
  pintarDibujo();
  actualizarControlesMejor();
}

function salirModoDibujo() {
  map.doubleClickZoom.enable();
  quitarDibujo();
  quitarMarcadorMejor();
  quitarOverlay(SRC_MEJOR, LAYER_MEJOR);
  puntosPoligono = [];
  poligonoCerrado = false;
  mejorResultadoTxt.hidden = true;
}

mejorCerrar.addEventListener("click", () => {
  if (ocupado) return;
  cerrarPoligono();
});
mejorReiniciar.addEventListener("click", () => {
  if (ocupado) return;
  reiniciarDibujo();
});

// --- Cálculo: busca el mejor punto para cubrir el perímetro -----------------
function pedirMejorUbicacion(body) {
  return fetch("/api/best-site", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

mejorCalcular.addEventListener("click", async () => {
  if (ocupado || mejorCalcular.disabled) return;

  // Si el usuario no cerró el área a mano, la cerramos nosotros: alcanza con
  // 3+ puntos para calcular (no hace falta que haya clickeado el primer punto).
  if (!poligonoCerrado) cerrarPoligono();
  if (puntosPoligono.length < 3) {
    setEstado(t("mejor_puntos_insuficientes"), true);
    return;
  }

  const body = {
    poligono: puntosPoligono.map(([lat, lon]) => ({ lat, lon })),
    txh: parseFloat(document.getElementById("mejor-txh").value),
    erp: parseFloat(document.getElementById("mejor-erp").value),
    f: parseFloat(document.getElementById("mejor-f").value),
    rxh: parseFloat(document.getElementById("mejor-rxh").value),
    rt: parseFloat(document.getElementById("mejor-rt").value),
  };

  setOcupado(true, t("mejor_buscando"));
  try {
    let resp = await pedirMejorUbicacion(body);

    // 409 con bbox del área de búsqueda (polígono + margen): mismo flujo que
    // VHF, ofrecemos preparar exactamente esa zona (no el viewport).
    if (resp.status === 409) {
      const detalle = await leerDetalle(resp);
      if (detalle && detalle.bbox) {
        const nTiles = tilesEnBbox(detalle.bbox);
        if (nTiles > MAX_TILES_PREPARAR) {
          throw new Error(t("mejor_area_grande", { n: nTiles, max: MAX_TILES_PREPARAR }));
        }
        const faltan = (detalle.missing || []).length;
        const gb = (nTiles * 0.054).toFixed(1);
        const msg =
          nTiles > AVISO_TILES_PREPARAR
            ? t("mejor_zona_no_preparada_grande", { faltan, n: nTiles, gb })
            : t("mejor_zona_no_preparada_chica", { faltan, n: nTiles });
        if (confirm(msg)) {
          setEstado(t("mejor_preparando", { n: nTiles }));
          await prepararZona(detalle.bbox);
          setEstado(t("mejor_buscando_de_nuevo"));
          resp = await pedirMejorUbicacion(body); // reintento una vez
        } else {
          throw new Error(t("zona_no_preparada_error"));
        }
      }
    }

    if (!resp.ok) throw new Error(await mensajeDeError(resp));

    const bbox = bboxDeHeader(resp, bboxViewport());
    const blob = await resp.blob();
    agregarOverlayRaster(SRC_MEJOR, LAYER_MEJOR, blob, bbox, 0.6);

    const lat = parseFloat(resp.headers.get("X-Best-Lat"));
    const lon = parseFloat(resp.headers.get("X-Best-Lon"));
    const score = resp.headers.get("X-Best-Score");
    colocarMarcadorMejor(lat, lon);

    mejorResultadoTxt.textContent = t("mejor_resultado", {
      lat: lat.toFixed(5),
      lon: lon.toFixed(5),
      score,
    });
    mejorResultadoTxt.hidden = false;

    // Encuadre automático sobre el área calculada (mismo criterio que HF).
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, duration: 700 });
    setEstado("");
  } catch (e) {
    console.error(e);
    setEstado(t("mejor_error_prefijo") + e.message, true);
  } finally {
    setOcupado(false);
    actualizarControlesMejor();
  }
});
