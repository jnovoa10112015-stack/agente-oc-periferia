# Contrato `web/` ↔ backend

Este documento define, con precisión de implementación, lo que `web/app.js`
espera del backend (`src/server.ts`). Lo escribe el lado cliente (Agente C,
oleada de front) para que el agente que construya el servidor lo implemente
tal cual, sin adivinar. El front ya está escrito contra este contrato — si el
backend se desvía de esta forma exacta, el chat no va a interpretar los
eventos correctamente.

Principio de seguridad (CLAUDE.md): **la clave del proveedor de modelo nunca
llega al navegador**. El front no pide, no muestra ni recibe en ningún
payload una API key. Solo habla con su propio backend, mismo origen
(`fetch("/api/chat")`, rutas relativas, sin CORS).

---

## 1. `POST /api/chat`

### Request

```http
POST /api/chat
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "sessionId": "9f2b3a10-...-uuid",
  "message": "Procesa la solicitud sol-004"
}
```

- `sessionId`: string. El front lo genera con `crypto.randomUUID()` la primera
  vez que se abre la página y lo persiste en `localStorage`. El backend crea
  la sesión si no existe (no hace falta un endpoint separado de "crear
  sesión").
- `message`: string, texto tal cual lo escribió el usuario (incluye
  respuestas de confirmación: el botón "Confirmar" envía literalmente el
  mensaje `"confirmo"`, el botón "Cancelar" envía `"cancelo"`).

### Respuesta esperada: si todo va bien

`200 OK`, `Content-Type: text/event-stream`, cuerpo como **stream SSE** (no se
usa `EventSource` del navegador porque `EventSource` no soporta `POST`: el
front consume el `ReadableStream` de `fetch` a mano — ver §3 el framing
exacto). El backend debe *flushear* cada evento a medida que ocurre, no
bufferizar toda la respuesta y mandarla al final (si no, el streaming no
sirve de nada y el "pensando" se ve congelado).

### Respuesta esperada: si algo falla antes de empezar a transmitir

Si el body no es válido, la sesión no se puede crear, o hay un error antes de
iniciar el ciclo del agente: responder con status **no 2xx** (ej. `400` o
`500`) y cuerpo JSON:

```json
{ "ok": false, "error": "mensaje legible para mostrar en el chat" }
```

El front no intenta parsear SSE si `res.ok` es `false` o si `res.body` es
`null`; en ese caso lee el JSON de error (si lo hay) y lo muestra como mensaje
de sistema en rojo, sin romper la sesión.

Una vez que el stream **empezó** (status 200 ya enviado), cualquier falla se
comunica *dentro* del stream con el evento `error` (§2.5), nunca cortando la
conexión en seco sin avisar.

---

## 2. Eventos SSE

Framing estándar SSE, un evento por bloque, bloques separados por línea en
blanco:

```
event: <nombre>
data: <JSON compacto, una sola línea>

```

El front parsea con `indexOf("\n\n")`, así que **cada evento debe terminar en
`\n\n`** y el payload de `data:` debe venir en una sola línea (`JSON.stringify`
sin `null, 2`, sin saltos de línea internos).

Orden dentro de un turno: cero o más pares `tool_call` → `tool_result`
intercalados con `message`, terminando opcionalmente en `needs_confirmation`,
y **siempre** cerrando con `done` (o con `error` si el turno no pudo
terminar).

### 2.1 `message` — texto del agente

```
event: message
data: {"text":"Encontré la solicitud sol-004...","final":true}
```

- `text`: fragmento a **agregar** a la burbuja de asistente actualmente
  abierta (no es el texto acumulado completo). Si el backend no hace
  streaming token a token, manda un único evento con todo el texto y
  `"final": true`.
- `final`: `true` cuando este es el último fragmento de esa burbuja. El front
  usa `final` solo para dejar de mostrar el cursor parpadeante; no es
  obligatorio para el parseo.
- Regla de burbujas: el front abre una burbuja nueva de asistente la primera
  vez que ve `message` después de un `tool_call`, `tool_result`,
  `needs_confirmation`, `error` o el inicio del turno. Si el backend quiere
  dos párrafos separados como dos burbujas distintas, tiene que intercalar
  otro evento en el medio (no hay forma de forzar "nueva burbuja" con dos
  `message` seguidos: se concatenan en la misma burbuja).

### 2.2 `tool_call` — el agente invoca una herramienta

```
event: tool_call
data: {"id":"call_1","name":"oc_leer_paquete","args":{"caso":"sol-004"}}
```

- `id`: identificador único de **esta invocación** (no del turno). Debe ser
  distinto para cada llamada, incluso si se llama la misma herramienta dos
  veces en el mismo turno. El front lo usa para emparejar con `tool_result`.
- `name`: nombre tal como lo ve el modelo, formato `<archivo>_<export>` (ej.
  `oc_validar`, `oc_construir_payload`, `oc_crear`).
- `args`: los argumentos tal cual se le pasaron a `execute()`, ya validados
  por zod.

El front renderiza esto como una **tarjeta de herramienta**, nunca como texto
plano: se ve claramente diferenciada de un mensaje del agente, con el nombre
en monoespaciado, un estado "ejecutando…" y los argumentos en un `<pre>`
colapsable.

### 2.3 `tool_result` — resultado de esa invocación

Éxito:

```
event: tool_result
data: {"id":"call_1","ok":true,"data":{"apta":false,"bloqueos":[{"codigo":"RC2","detalle":"..."}],"confirmaciones":[],"derivados":{"indicador_iva":null,"condiciones_pago":"Z030","proveedor_codigo_sap":null},"retroactiva":false}}
```

Error (`ResultadoHerramienta` con `ok:false`, tal cual lo definís en
`src/tipos.ts`):

```
event: tool_result
data: {"id":"call_1","ok":false,"error":"El caso sol-099 no existe en fixtures/reto-03/solicitudes/","codigo":"CASO_NO_ENCONTRADO"}
```

- `id`: **debe coincidir** con el `id` del `tool_call` correspondiente. Si el
  front recibe un `tool_result` con un `id` que no reconoce, no rompe: lo
  reporta como nota de sistema y sigue.
- `data`: lo que devuelve la herramienta. El front **no evalúa ningún
  control**; solo hace *pattern matching* sobre las claves que ya vienen
  resueltas por el backend para pintar colores:
  - si `data.bloqueos` es un array no vacío → tarjeta y chips en **rojo**
    (bloqueo).
  - si no hay bloqueos pero `data.confirmaciones` es un array no vacío →
    **ámbar** (confirmación).
  - por cada clave no nula dentro de `data.derivados` → chip **gris**
    (derivado), como capa informativa adicional (no reemplaza el color de
    bloqueo/confirmación).
  - si `data.retroactiva === true` → chip ámbar adicional "retroactiva".
  - si nada de eso aplica y `ok:true` → tarjeta neutra/verde de "ok".
  - si `ok:false` → tarjeta roja con el mensaje de `error` (y `codigo` si
    viene).
  
  Esta clasificación es puramente visual sobre datos ya decididos en
  `src/reglas/`; el modelo y el front nunca comparan números.

### 2.4 `needs_confirmation` — CA3: el turno termina pidiendo confirmación

```
event: needs_confirmation
data: {
  "pregunta": "La cotización difiere 6% de la solicitud y no informa IVA. ¿Confirmás que continúe con estos valores?",
  "hallazgos": {
    "confirmaciones": [
      {"codigo":"RC5","detalle":"cotización 1060000 vs solicitud 1000000 (6.0%)","recomendacion":"confirmar o pedir cotización corregida"},
      {"codigo":"RC6","detalle":"indicador_iva ausente, derivado del proveedor: C1"}
    ],
    "derivados": {"indicador_iva":"C1","condiciones_pago":null,"proveedor_codigo_sap":null},
    "retroactiva": false
  }
}
```

- Emitir este evento es lo que dispara la UI de confirmación: banner ámbar
  fijo junto al input, con borde/fondo distintivo, más una tarjeta en el
  historial. El input de texto normal **sigue disponible** (el usuario puede
  escribir lo que quiera), pero además aparecen dos botones dedicados,
  "Confirmar" y "Cancelar", que mandan como próximo `message` literalmente
  `"confirmo"` / `"cancelo"`.
- `hallazgos.confirmaciones` reutiliza la forma de `Hallazgo` de
  `src/tipos.ts` (`{codigo, detalle, recomendacion?}`).
- `hallazgos.derivados` y `hallazgos.retroactiva` son opcionales; si no
  aplican, se puede omitir el campo o mandar `null`/`false`.
- El backend solo debe proceder a `oc_crear` en el turno siguiente si el
  mensaje del usuario confirma explícitamente (`confirmado: true` hacia la
  herramienta). El front no decide eso: solo transporta la respuesta del
  humano como el próximo `message` de la conversación.

### 2.5 `error` — error de stream a mitad de turno

```
event: error
data: {"message":"El proveedor del modelo no respondió a tiempo (30000 ms).","recoverable":true}
```

- Se usa para timeouts al proveedor LLM, errores no capturados del ciclo,
  etc. (CA5: un error no mata la sesión). El front lo muestra como mensaje de
  sistema en rojo y vuelve a habilitar el input; el usuario puede seguir
  escribiendo en la misma sesión.
- `recoverable` es informativo; el front hoy no cambia de comportamiento
  según su valor (siempre re-habilita el input), pero se documenta por si el
  backend quiere loggearlo o el front lo usa a futuro para distinguir "reintentá"
  de "esta sesión quedó en un estado raro".

### 2.6 `done` — fin del turno

```
event: done
data: {"needsConfirmation": true}
```

- Siempre es el último evento de un turno exitoso (o penúltimo/ausente si en
  su lugar se manda `error`). Al recibirlo el front: oculta el indicador
  "pensando", cierra cualquier burbuja de asistente abierta y vuelve a
  habilitar el campo de texto para el próximo mensaje.
- `needsConfirmation` es informativo/redundante con el evento
  `needs_confirmation` (que es la fuente de verdad del contenido a mostrar).
  Si el backend llega al tope de iteraciones (CA1, 8 vueltas) sin resolver,
  simplemente manda un `message` explicando qué falta y cierra con
  `done` (`needsConfirmation: false`) — no hace falta un evento nuevo para
  ese caso.
- Si el stream HTTP se corta sin que llegue `done` ni `error` (ej. el proceso
  del backend crashea), el front lo detecta cuando `reader.read()` devuelve
  `done:true` sin haber visto el evento `done`, y muestra una nota de sistema
  avisando que la conexión se cerró antes de tiempo, sin dejar el input
  bloqueado.

---

## 3. Framing exacto que el parser del front acepta

`web/app.js` divide el buffer por `"\n\n"` y, dentro de cada bloque, busca
líneas que empiecen con `event:` y `data:` (ignora cualquier otra línea, por
ejemplo comentarios `:` o `id:` de SSE estándar, que son válidos pero no se
usan). Ejemplo de bytes reales que debe escribir el backend por evento:

```
event: tool_call\ndata: {"id":"call_1","name":"oc_leer_paquete","args":{"caso":"sol-004"}}\n\n
```

Recomendación de implementación en Bun: usar un `ReadableStream` con
`controller.enqueue(new TextEncoder().encode(...))` por cada evento, y
`Content-Type: text/event-stream; charset=utf-8` más `Cache-Control: no-cache`
y `Connection: keep-alive` en los headers de la respuesta.

---

## 4. `GET /api/sessions/:id` (historial)

Usado por el front al abrir la página, si ya hay un `sessionId` guardado en
`localStorage` de una visita anterior.

### Request

```http
GET /api/sessions/9f2b3a10-...-uuid
Accept: application/json
```

### Respuesta si la sesión existe

`200 OK`:

```json
{
  "ok": true,
  "sessionId": "9f2b3a10-...-uuid",
  "mensajes": [
    { "type": "user_message", "text": "Procesa la solicitud sol-004", "ts": "2026-09-21T15:00:00.000Z" },
    { "type": "message", "text": "Encontré la solicitud sol-004...", "ts": "2026-09-21T15:00:01.000Z" },
    { "type": "tool_call", "id": "call_1", "name": "oc_leer_paquete", "args": { "caso": "sol-004" }, "ts": "2026-09-21T15:00:01.200Z" },
    { "type": "tool_result", "id": "call_1", "ok": true, "data": { "...": "..." }, "ts": "2026-09-21T15:00:01.500Z" },
    { "type": "needs_confirmation", "pregunta": "...", "hallazgos": { "...": "..." }, "ts": "2026-09-21T15:00:02.000Z" }
  ]
}
```

- Es la **misma forma de item** que los `data` de los eventos SSE, más
  `"type"` (igual al nombre del evento SSE, salvo `"user_message"` que solo
  existe en el historial: en vivo, el front ya pinta el mensaje del usuario
  apenas lo envía, no espera a que el backend se lo devuelva) y `"ts"`
  (ISO 8601, para orden/depuración; el front no lo muestra, solo repinta en
  orden de array).
- El front reproduce el array completo en orden llamando a las mismas
  funciones de render que usa para el streaming en vivo. Si el último item es
  `needs_confirmation`, el front vuelve a dejar activo el banner de
  confirmación (útil si el usuario recarga la página a mitad de un turno
  pendiente).
- `tool_result` sin un `tool_call` previo en el mismo array, o con un `id`
  que no matchea, no rompe el render (se ignora el emparejamiento, ver §2.3).

### Respuesta si la sesión no existe

`404 Not Found`:

```json
{ "ok": false, "error": "sesión no encontrada" }
```

El front interpreta *cualquier* respuesta no-200 (o un fetch que falla por
red) como "no hay historial que cargar": genera un `sessionId` nuevo y
arranca una conversación vacía. No es un estado de error visible para el
usuario.

---

## 5. Lo que el front asume y no verifica

- **Mismo origen**: el front hace `fetch("/api/chat")` y
  `fetch("/api/sessions/"+id)` con rutas relativas. Si el backend se sirve
  desde otro origen/puerto, hay que resolver CORS del lado del servidor; el
  front no manda modo `cors` especial ni credenciales.
- El front **nunca** llama a `/api/health` ni pide ninguna clave. No hay
  ningún input de API key en la interfaz.
- El front no reintenta automáticamente un `POST /api/chat` fallido: si falla,
  el usuario vuelve a escribir su mensaje (el mensaje de usuario ya quedó
  pintado en el historial local, así que no se pierde de vista aunque no se
  haya procesado).
- El front no impone su propio tope de iteraciones ni de tokens: eso es
  responsabilidad exclusiva del backend (tope de 8 iteraciones fijo en código,
  `MAX_TOKENS_POR_SESION`/`MAX_COSTO_USD_POR_SESION` de `.env.example`); el
  front solo refleja lo que el stream le manda.
