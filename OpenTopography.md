# Fuentes de datos de elevación (DEM)

RadioLocal-VHF-HF calcula la cobertura sobre relieve real: el modelo Longley-Rice
necesita la forma del terreno —cerros, valles, pendientes— para estimar hasta dónde
llega la señal. Ese relieve es **Copernicus GLO-30** (30 m de resolución) y se
descarga **una sola vez por zona**, quedando en caché local (`data/dem/`) para
funcionar después aunque no haya internet.

Hay **dos fuentes** para bajar ese relieve:

| Fuente | API key | Cuándo |
|--------|---------|--------|
| **S3 — bucket público de Copernicus** | **No** | **Por defecto.** Recomendada. |
| **OpenTopography** | Sí (gratuita) | Fallback opcional. |

## Por defecto: S3 (sin API key)

No tenés que configurar nada. El relieve viene del **bucket público de Copernicus
DEM en AWS** (`copernicus-dem-30m`), de acceso anónimo. Es exactamente el mismo dato
Copernicus GLO-30, así que el relieve y la cobertura salen idénticos.

> En el flujo por defecto **NO hace falta API key**. Si solo querés usar la
> herramienta, podés ignorar el resto de este documento.

Para preparar zonas grandes (provincia/país) y trabajar 100% offline, mirá la
sección **Descarga masiva / uso offline** del [README](README.md).

---

## Fallback opcional: OpenTopography (con API key)

Solo si elegís esta fuente —poniendo `RADIOLOCAL_DEM_SOURCE=opentopography` en
`.env`— necesitás una API key. [OpenTopography](https://opentopography.org) es un
portal científico que da acceso libre a datos de elevación global; pide una **clave
gratuita y personal**.

> La clave se saca **una sola vez**, es **gratis** y lleva unos 5 minutos. Cada
> persona usa **su propia** clave. Recordá: esto **solo** aplica si activaste el
> fallback OpenTopography; con la fuente por defecto (S3) no se usa.

---

## Cómo obtener tu API Key

### Paso 1 — Crear tu cuenta

1. Entrá a 👉 **https://portal.opentopography.org/newUser**
2. *(Opcional)* Si no manejás inglés, arriba a la izquierda hay un selector de idioma.
3. Completá los campos marcados con asterisco rojo **(\*)**:
   - **Email** (será tu usuario)
   - **Nombre** y **Apellido**
   - **Organization** (organización): podés poner el nombre de tu cuartel o brigada
   - **Affiliation** (afiliación): si no pertenecés a una institución, elegí **"Personal"**
   - **Contraseña** (elegí una segura)
4. El campo **ORCID** es opcional: dejalo vacío.
5. Confirmá el registro.

### Paso 2 — Activar la cuenta (revisá tu email)

1. OpenTopography te envía un **correo de activación** (si no lo ves, revisá la carpeta de **spam / correo no deseado**).
2. ⚠️ El enlace de activación **vence en unos 7 días**, así que activá pronto.
3. Hacé clic en el **enlace de activación** del correo. Listo: tu cuenta queda activada.

### Paso 3 — Iniciar sesión

1. Entrá a 👉 **https://portal.opentopography.org/login**
2. Ingresá con tu **email** y **contraseña**.

### Paso 4 — Pedir tu API Key

1. Ya con la sesión iniciada, buscá el botón **"Request an API Key"** (Pedir una clave de API). Aparece en la página de inicio o en tu panel **MyOpenTopo**.
2. Hacé clic. Se mostrará tu clave: una **cadena larga de letras y números**.

### Paso 5 — Copiar y guardar la clave

1. **Copiá la clave completa** (toda la cadena).
2. Guardala en un lugar seguro (un archivo de texto o un gestor de contraseñas).
   - *No te preocupes si la perdés:* también queda guardada en tu panel **MyOpenTopo** para consultarla más adelante.

---

## Cómo configurar la clave en el proyecto

> ⚠️ Esto aplica **solo con el fallback activo** (`RADIOLOCAL_DEM_SOURCE=opentopography`
> en `.env`). Con la fuente por defecto (S3) el cartel de la app no aparece y la
> clave no se usa.

Hay **dos caminos**. Elegí el que te quede más cómodo: alcanza con uno.

### Camino A — Desde la app (recomendado para usuarios no técnicos)

Con el fallback OpenTopography activo, cuando abrís la app **sin una clave
configurada** aparece un cartel pidiéndola:

1. Abrí la app en http://localhost:8080
2. En el cartel **"API key de OpenTopography"**, pegá tu clave en el campo
   (podés usar el botón 👁 para mostrarla/ocultarla y revisar que esté bien).
3. Hacé clic en **Guardar**.

La clave queda guardada **en tu navegador** (localStorage), en tu propia máquina,
y se usa automáticamente en cada descarga de relieve. La cargás una vez y listo.

> 💡 Si la clave no fuera válida, la primera descarga la detecta y el cartel
> vuelve a aparecer avisándote para que la corrijas.

### Camino B — Por archivo `.env` (para despliegues / uso técnico)

Útil cuando un equipo levanta el servidor con una clave fija para todos:

1. En la raíz del proyecto, copiá el archivo de ejemplo (si todavía no lo hiciste):

   ```bash
   cp .env.example .env
   ```

2. Abrí `.env` con un editor de texto y pegá tu clave:

   ```bash
   OPENTOPOGRAPHY_API_KEY=tu_clave_acá
   ```

3. Guardá el archivo y (re)levantá los servicios:

   ```bash
   docker compose up -d --build
   ```

> 🔒 El archivo `.env` está en `.gitignore`: **nunca** se sube al repositorio. Tu
> clave queda solo en tu máquina.

> ⚙️ **Precedencia:** si cargaste una clave desde la app **y** además hay una en
> `.env`, se usa la de la app (la tuya, en el navegador). Si `.env` ya trae una
> clave, la app **no** muestra el cartel.

---

## Límite del plan gratuito

- Alrededor de **50 descargas por día** para usuarios **no académicos**. Cada
  "casilla" de terreno (tile) que se descarga cuenta como una descarga.
- 💾 **La caché local lo amortigua:** una zona que ya preparaste **no vuelve a
  descargarse**, así que no gasta tu límite al volver a usarla. El tope solo te
  puede afectar si preparás **zonas nuevas muy grandes** de una sola vez. Si
  llegás al límite, esperá al día siguiente.
- 🆓 **Es gratis.** No se pide tarjeta ni pago.

---

## Términos importantes

- 🔑 **Una clave por usuario.** Tu clave es **personal**: no la compartas ni la
  publiques. Por eso cada persona saca la suya (es una condición de uso de
  OpenTopography, y si se incumple pueden anular la clave).
- 🙏 **Acknowledgment.** OpenTopography pide reconocer el uso de sus servicios.
  RadioLocal-VHF-HF lo hace en su atribución:
  *This project uses data and services provided by
  [OpenTopography](https://opentopography.org).* El relieve corresponde a
  **Copernicus GLO-30** (DEM `COP30`).
