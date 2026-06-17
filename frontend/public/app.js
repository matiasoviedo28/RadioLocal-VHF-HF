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
    409: 'Zona no preparada. Usá "Preparar zona" primero.',
    413: "Área demasiado grande. Acercá el zoom.",
    422: "No es posible calcular con esos parámetros.",
    502: "No se pudo descargar el relieve (problema de red).",
    503: "Falta configurar la API key de relieve (.env).",
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
// PASO 1 — Preparar zona (Plan A, requiere internet)
// Descarga y cachea el relieve del área visible. Con guarda de tamaño.
// --------------------------------------------------------------------------
const btnPreparar = document.getElementById("btn-preparar");

// Descarga y cachea los tiles faltantes de un bbox. Lanza error con mensaje claro.
async function prepararZona(bbox) {
  const resp = await fetch("/api/terrain/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox }),
  });
  if (!resp.ok) throw new Error(await mensajeDeError(resp));
  return resp.json();
}

// Si la descarga es grande (> umbral de tiles) pide confirmación con el peso
// aproximado (~54 MB por tile COP30). Devuelve true si se puede continuar.
function confirmarDescarga(nTiles) {
  if (nTiles <= AVISO_TILES_PREPARAR) return true;
  const gb = (nTiles * 0.054).toFixed(1);
  return confirm(
    `Vas a descargar ~${nTiles} tiles (~${gb} GB), puede tardar. ¿Continuar?`
  );
}

btnPreparar.addEventListener("click", async () => {
  if (ocupado) return;
  const bbox = bboxViewport();
  const nTiles = tilesEnBbox(bbox);

  // Guarda de tamaño en el cliente: feedback inmediato sin golpear el backend.
  if (nTiles > MAX_TILES_PREPARAR) {
    setEstado(
      `Esta zona necesita ${nTiles} tiles (máx. ${MAX_TILES_PREPARAR}). Acercá el zoom.`,
      true
    );
    return;
  }
  // Aviso previo si la descarga es grande.
  if (!confirmarDescarga(nTiles)) return;

  setOcupado(true, `Preparando zona: descargando ${nTiles} tile(s)…`);
  try {
    const res = await prepararZona(bbox);
    const bajados = (res.downloaded || []).length;
    setEstado(
      bajados > 0
        ? `Zona lista: ${bajados} tile(s) descargado(s).`
        : "Zona ya estaba preparada."
    );
  } catch (e) {
    console.error(e);
    setEstado("Error al preparar: " + e.message, true);
  } finally {
    setOcupado(false);
  }
});

// --------------------------------------------------------------------------
// Capa de RELIEVE (hillshade del viewport)
// Si la zona no está cacheada (409), NO descarga: pide usar "Preparar zona".
// --------------------------------------------------------------------------
const SRC_RELIEVE = "relieve-src";
const LAYER_RELIEVE = "relieve-layer";
const btnRelieve = document.getElementById("btn-relieve");
let relieveActivo = false;

async function mostrarRelieve() {
  const bbox = bboxViewport();
  const resp = await fetch(`/api/terrain/hillshade?bbox=${bbox.join(",")}`);
  if (!resp.ok) throw new Error(await mensajeDeError(resp));
  const xbbox = bboxDeHeader(resp, bbox);
  const blob = await resp.blob();
  agregarOverlayRaster(SRC_RELIEVE, LAYER_RELIEVE, blob, xbbox, 0.7);
}

btnRelieve.addEventListener("click", async () => {
  if (ocupado) return;

  // Apagar.
  if (relieveActivo) {
    quitarOverlay(SRC_RELIEVE, LAYER_RELIEVE);
    relieveActivo = false;
    btnRelieve.classList.remove("activo");
    btnRelieve.textContent = "Relieve: OFF";
    setEstado("");
    return;
  }

  // Encender.
  setOcupado(true, "Generando relieve…");
  try {
    await mostrarRelieve();
    relieveActivo = true;
    btnRelieve.classList.add("activo");
    btnRelieve.textContent = "Relieve: ON";
    setEstado("");
  } catch (e) {
    console.error(e);
    setEstado("Relieve: " + e.message, true);
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
let txMarker = null;
let ultimaCobertura = null; // params de la última cobertura calculada (para guardar)

// Habilita/inhabilita botones según contexto (zoom, Tx, ocupado).
function actualizarControles() {
  const zoomOk = map.getZoom() >= MIN_ZOOM_COBERTURA;
  const hayTx = !!(inLat.value && inLon.value);
  btnCalcular.disabled = ocupado || !hayTx || !zoomOk;
  btnGuardar.disabled = ocupado || !ultimaCobertura;
  btnPreparar.disabled = ocupado;
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

  const del = document.createElement("button");
  del.className = "cob-borrar";
  del.textContent = "🗑";
  del.title = "Borrar";
  del.addEventListener("click", () => borrarGuardada(item));

  li.append(chk, info, del);
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
