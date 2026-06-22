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
    409: 'Zona no preparada. Usá "Descargar zona" primero.',
    413: "Área demasiado grande. Acercá el zoom.",
    422: "No es posible calcular con esos parámetros.",
    502: "No se pudo descargar el relieve (problema de red).",
    503: "Falta configurar la API key de relieve (en la app o en .env).",
    504: "Tiempo de espera agotado.",
  };
  return `(${resp.status}) ${porCodigo[resp.status] || resp.statusText || "Error"}`;
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

const MSG_API_FALTA =
  "No tenés una API key de OpenTopography configurada. Si no tenés una, creala gratis.";
const MSG_API_INVALIDA =
  "Tu API key parece inválida, revisala. Pegá una clave válida de OpenTopography.";

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
    apiKeyMensaje.textContent = "Pegá tu API key antes de guardar.";
    apiKeyMensaje.classList.add("error");
    return;
  }
  setApiKey(k);
  ocultarModalApiKey();
  setEstado('API key guardada. Probá "Descargar zona".');
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
    mostrarModalApiKey(MSG_API_FALTA);
    return true;
  }
  if (code === "invalid_api_key") {
    mostrarModalApiKey(MSG_API_INVALIDA, true);
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
  if (requiereKey && !hayKeyUsable()) mostrarModalApiKey(MSG_API_FALTA);
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
    btnRelieve.title = "Mostrar relieve";
    setEstado("");
    return;
  }

  // Encender.
  setOcupado(true, "Generando relieve…");
  try {
    await mostrarRelieve();
    relieveActivo = true;
    btnRelieve.classList.add("activo");
    btnRelieve.title = "Ocultar relieve";
    setEstado("");
  } catch (e) {
    console.error(e);
    // Zona sin terreno descargado: popup amable en vez del error crudo del 409.
    if (e.code === "offline") {
      setEstado("");
      abrirPopupRelieve();
    } else {
      setEstado("Relieve: " + e.message, true);
    }
  } finally {
    setOcupado(false);
  }
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

map.on("click", (ev) => fijarTx(ev.lngLat.lat, ev.lngLat.lng));
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
    setEstado(
      `Por ahora el máximo es ${RADIO_MAX_KM} km. Los radios mayores llegan con ` +
        "el procesamiento en segundo plano (próxima versión)."
    );
    return;
  }
  if (body.radius > RADIO_AVISO_KM) {
    if (
      !confirm(
        `Radio grande (${body.radius} km): puede tardar un par de minutos. ¿Continuar?`
      )
    ) {
      return;
    }
  }

  setOcupado(true, "Calculando cobertura (puede tardar varios segundos)…");
  try {
    let resp = await pedirCobertura(body);

    // 409 con bbox de la HUELLA: la zona de la cobertura no está preparada.
    // Ofrecemos preparar exactamente esa área (Tx ± radio), no el viewport.
    if (resp.status === 409) {
      const detalle = await leerDetalle(resp);
      if (detalle && detalle.bbox) {
        const nTiles = tilesEnBbox(detalle.bbox);
        if (nTiles > MAX_TILES_PREPARAR) {
          throw new Error(
            `La cobertura abarca ${nTiles} tiles (máx. ${MAX_TILES_PREPARAR}). Reducí el radio.`
          );
        }
        const faltan = (detalle.missing || []).length;
        // Aviso con peso si la descarga es grande; si no, confirm simple.
        const gb = (nTiles * 0.054).toFixed(1);
        const msg =
          nTiles > AVISO_TILES_PREPARAR
            ? `La zona de esta cobertura no está preparada (faltan ${faltan} tile/s).\n\n` +
              `Vas a descargar ~${nTiles} tiles (~${gb} GB), puede tardar. ¿Continuar?`
            : `La zona de esta cobertura no está preparada (faltan ${faltan} tile/s).\n\n` +
              `¿Preparar el área de la cobertura ahora (${nTiles} tile/s, requiere internet)?`;
        if (confirm(msg)) {
          setEstado(`Preparando el área de la cobertura: ${nTiles} tile(s)…`);
          await prepararZona(detalle.bbox);
          setEstado("Calculando cobertura…");
          resp = await pedirCobertura(body); // reintento una vez
        } else {
          throw new Error("Zona no preparada.");
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
    setEstado("Cobertura: " + e.message, true);
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

  setOcupado(true, "Guardando cobertura…");
  try {
    const resp = await fetch("/api/coverages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre, params: ultimaCobertura }),
    });
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    setEstado(`Cobertura "${nombre}" guardada.`);
    await cargarGuardadas();
  } catch (e) {
    console.error(e);
    setEstado("Guardar: " + e.message, true);
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

  setOcupado(true, "Exportando a Google Earth…");
  try {
    const resp = await fetch("/api/coverage/export.kmz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre, params: ultimaCobertura }),
    });
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    const blob = await resp.blob();
    descargarBlob(blob, nombreDeContentDisposition(resp, "cobertura.kmz"));
    setEstado("KMZ exportado.");
  } catch (e) {
    console.error(e);
    setEstado("Exportar: " + e.message, true);
  } finally {
    setOcupado(false);
  }
});

// Exporta una cobertura GUARDADA a KMZ (descarga directa por ítem).
async function exportarGuardada(item) {
  setOcupado(true, "Exportando a Google Earth…");
  try {
    const resp = await fetch(`/api/coverages/${item.id}/export.kmz`);
    if (!resp.ok) throw new Error(await mensajeDeError(resp));
    const blob = await resp.blob();
    descargarBlob(blob, nombreDeContentDisposition(resp, `${item.nombre}.kmz`));
    setEstado("KMZ exportado.");
  } catch (e) {
    console.error(e);
    setEstado("Exportar: " + e.message, true);
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
  if (!confirm(`¿Borrar la cobertura "${item.nombre}"?`)) return;
  setOcupado(true, "Borrando…");
  try {
    const resp = await fetch(`/api/coverages/${item.id}`, { method: "DELETE" });
    if (!resp.ok && resp.status !== 204) throw new Error(await mensajeDeError(resp));
    if (overlaysActivos.has(item.id)) toggleGuardada(item, false);
    setEstado("");
    await cargarGuardadas();
  } catch (e) {
    console.error(e);
    setEstado("Borrar: " + e.message, true);
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
  chk.title = "Prender/apagar en el mapa";
  chk.addEventListener("change", async () => {
    try {
      await toggleGuardada(item, chk.checked);
    } catch (e) {
      console.error(e);
      setEstado("Overlay: " + e.message, true);
      chk.checked = overlaysActivos.has(item.id); // revertir si falló
    }
  });

  const info = document.createElement("div");
  info.className = "cob-info";
  info.title = "Click para ir a la zona";
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
  exportar.title = "Exportar a Google Earth (KMZ)";
  exportar.addEventListener("click", () => exportarGuardada(item));

  const del = document.createElement("button");
  del.className = "cob-borrar";
  del.textContent = "🗑";
  del.title = "Borrar";
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
    setEstado("Guardadas: " + e.message, true);
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
    return confirm(
      `Vas a descargar ~${nTiles} tiles (~${gb} GB). Es una descarga grande ` +
        "(escala país). ¿Continuar?"
    );
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
  setProgresoTxt(`Iniciando descarga (~${nTiles} tiles, ~${gb} GB)…`);
  mostrarReintentar(false);

  try {
    const resp = await fetch("/api/terrain/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status === 409) {
      setProgresoTxt("Ya hay una descarga en curso. Esperá a que termine.");
      arrancarPoll();
      return;
    }
    if (!resp.ok) {
      setProgresoTxt("No se pudo iniciar: " + (await mensajeDeError(resp)));
      return;
    }
    ultimaDescarga = { payload, bboxSONE };
    arrancarPoll();
  } catch (e) {
    console.error(e);
    setProgresoTxt("No se pudo iniciar la descarga (red).");
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
  const partes = [`${st.done}/${st.total} tiles`];
  if (st.ocean) partes.push(`océano ${st.ocean}`);
  if (st.failed) partes.push(`fallidos ${st.failed}`);
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
    offResumen.textContent = `${r.tiles} tiles en caché · ${r.tamano_total_mb} MB en disco`;
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
// spotlight) y el texto. Para resaltar un área compuesta se pasa un array de
// selectores y se usa la unión de sus rectángulos.
const TOUR_PASOS = [
  {
    sel: null,
    texto:
      "Bienvenido a RadioLocal-VHF-HF. En 4 pasos planificás una cobertura de " +
      "radio. Podés omitir esta guía cuando quieras.",
  },
  {
    sel: "#btn-offline",
    texto:
      "1) Descargá tu zona. Bajá el terreno del área donde vas a trabajar; una " +
      "vez descargada, funciona incluso sin internet.",
  },
  {
    sel: "#panel-cobertura",
    texto:
      "2) Ubicá tu estación. Hacé clic en el mapa donde está tu antena y " +
      "completá los datos de tu equipo. Las 'i' te explican cada dato.",
  },
  {
    sel: "#btn-calcular",
    texto:
      "3) Calculá la cobertura. El mapa te muestra hasta dónde llega tu señal.",
  },
  {
    sel: "#btn-relieve",
    texto: "4) Mirá el relieve. Activalo para ver el terreno del área.",
  },
  {
    sel: ["#btn-guardar", "#guardadas"],
    texto:
      "Guardá y compará. Podés guardar coberturas y superponerlas para " +
      "compararlas.",
  },
  {
    sel: null,
    texto: "¡Listo! Reabrí esta guía cuando quieras con el botón ?.",
  },
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
  tourPaso.textContent = `Paso ${tourIndice + 1} de ${TOUR_PASOS.length}`;
  tourTexto.textContent = paso.texto;

  // Navegación: "Anterior" oculto en el primero; "Siguiente"→"Finalizar" al final.
  tourAnterior.style.visibility = tourIndice === 0 ? "hidden" : "visible";
  tourSiguiente.textContent =
    tourIndice === TOUR_PASOS.length - 1 ? "Finalizar" : "Siguiente";

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

// Primera visita: arrancamos el tour automáticamente.
if (!localStorage.getItem(TOUR_FLAG)) {
  tourAbrir(0);
}
