# SOLUCION.md — Agente conversacional de Órdenes de Compra (Periferia)

> Estructura obligatoria según `referencia/PRD.md` §9.1. Las secciones 7, 8 y 9
> son de criterio del dueño del proyecto (lectura del proceso, trade-offs y
> supuestos de negocio) y se completan aparte; acá quedan solo con encabezado.

## 1. Problema en una frase

La analista administrativa de Periferia digita a mano en SAP —y valida de
memoria— cada orden de compra que llega por correo como tres piezas sueltas
(solicitud, cotización, aprobación del líder), lo que le cuesta tiempo, expone
a la compañía a errores de centro de costo y de montos mal aprobados, y le
esconde a la dirección qué porcentaje de compras se está creando después de
que ya llegó la factura (retroactivas).

## 2. Arquitectura

Front de chat → backend con el ciclo del agente → herramientas tipadas →
maestros y archivos. El modelo de lenguaje se sienta entre el front y las
herramientas, pero no toca los maestros ni los archivos directamente: todo
pasa por herramientas que devuelven `ResultadoHerramienta<T>` (`src/tipos.ts`).

```
┌────────────────────────┐   HTTP/SSE   ┌───────────────────────────────────────────────┐
│  web/ (HTML + JS plano) │ ───────────▶ │  src/server.ts  (Bun, /api/chat, /api/health)  │
│  historial, tool calls, │ ◀─────────── │        │                                       │
│  estado "esperando      │              │        ▼                                       │
│  confirmación"          │              │  src/agente/ciclo.ts                           │
└────────────────────────┘              │  (bucle: mensaje → decidir herramienta →        │
                                          │   ejecutar → observar → responder; tope 8)     │
                                          │        │                    │                  │
                                          │        ▼                    ▼                  │
                                          │  src/agente/llm.ts   src/tools/oc.ts            │
                                          │  (adaptador del      (6 herramientas zod:       │
                                          │   proveedor de       leer_paquete, validar,      │
                                          │   modelo)            construir_payload,          │
                                          │                      generar_evidencia, crear,    │
                                          │                      leer_excel)                  │
                                          │                             │        │            │
                                          │                  src/reglas/│  src/sap/adapter.ts │
                                          │                  controles.ts  + mock.ts          │
                                          │                  (RC1–RC10,  │        │            │
                                          │                  sin modelo)│        │            │
                                          │                             ▼        ▼            │
                                          │                      src/maestros.ts              │
                                          └──────────┬───────────────────────────┬────────────┘
                                                     │                           │
                                          fixtures/reto-03/ (solo lectura)  out/ (sap/, control.csv,
                                                                             <caso>/aprobacion.txt,
                                                                             <caso>/trazabilidad.json)
```

Dónde vive cada cosa (separación no negociable de `CLAUDE.md`):

- **Comportamiento** (cómo debe conversar el agente, qué nunca debe hacer):
  `src/agente/prompt.md`, un Markdown aparte, no embebido en código.
- **Conocimiento** (qué es un centro de costo, qué significa una OC
  retroactiva, ejemplos de conversación): `conocimiento/ejemplos.md`,
  consumido por el prompt.
- **Ejecución** (leer el paquete, validar, construir el payload, crear la OC):
  `src/tools/oc.ts`, `src/reglas/controles.ts`, `src/sap/`. Puro TypeScript,
  sin modelo de por medio.

El modelo de lenguaje (`src/agente/llm.ts` detrás de `src/agente/ciclo.ts`)
hace exactamente dos cosas: interpreta texto no estructurado (la cotización y
el correo de aprobación, ya normalizados por `oc_leer_paquete`) y conduce la
conversación de confirmación. Nunca compara dos números ni decide si un
control pasa: eso lo resuelven funciones puras en `src/reglas/controles.ts`
que reciben `Paquete` + maestros y devuelven `Validacion` (`src/tipos.ts`).

## 3. Ciclo del agente

El ciclo (`src/agente/ciclo.ts`) sigue el patrón mensaje → decidir herramienta
→ ejecutar → observar → responder:

1. El servidor arma la lista de mensajes: system prompt (`src/agente/prompt.md`)
   + historial de la sesión + el mensaje nuevo del usuario.
2. Llama al modelo a través del adaptador (`src/agente/llm.ts`), pasándole la
   descripción de las 6 herramientas de `src/tools/oc.ts`.
3. Si el modelo responde con una llamada a herramienta, el ciclo valida los
   argumentos con el `zod` de esa herramienta, la ejecuta, y agrega el
   resultado (el string `{ ok, data }` o `{ ok, error }`) al historial como
   mensaje de herramienta. Vuelve al paso 2.
4. Si el modelo responde con texto (sin llamar herramienta), el turno termina
   y esa respuesta se manda al front.
5. Cada vuelta del paso 2–3 cuenta como una iteración. Al llegar a **8**
   (tope fijo en código, `CLAUDE.md` — no los 25 que sugiere el PRD genérico
   en §6.3/CA1; el criterio propio del proyecto prevalece sobre la sugerencia
   genérica, y no es variable de entorno: cambiarlo es un cambio de diseño,
   no de configuración), el ciclo corta, arma una respuesta con lo que se
   alcanzó a hacer y lo que falta, y se lo dice explícitamente al usuario —
   no reintenta en silencio ni entra en bucle.

**Confirmación humana (CA3):** cuando `oc_validar` devuelve `confirmaciones`
no vacías, el prompt obliga al modelo a cerrar el turno con una pregunta
explícita en vez de llamar a `oc_crear`. Pero la garantía real no depende de
que el modelo "se acuerde": `oc_crear` en sí misma rechaza la creación si hay
bloqueos abiertos, y si hay confirmaciones pendientes exige
`confirmado: true` explícito en sus argumentos. El código es el que decide,
no el prompt — igual que con las reglas RC1–RC10 (CA2: el modelo no puede
afirmar un valor, ni forzar una creación, que no haya salido de una
herramienta).

Toda llamada a herramienta se emite al front (para que se vea nombre,
argumentos y resultado resumido) y se anexa a `out/log.jsonl`. Un error de
herramienta o del proveedor de modelo (incluido un timeout de esa llamada) se
traduce a lenguaje claro en el chat; la sesión sigue viva y el siguiente
mensaje del usuario se puede seguir procesando.

## 4. Elección del modelo

**Proveedor elegido: Anthropic Claude, vía la Anthropic Messages API con tool
use.** La clave se lee de `ANTHROPIC_API_KEY` y el modelo de `ANTHROPIC_MODEL`
(por ejemplo `claude-sonnet-5`; si se omite, el código aplica un default
razonable de la familia Sonnet) — ambas en `.env.example`, nunca en el
repositorio, el front o los logs. Es una elección de esta oleada de trabajo,
no un compromiso irreversible: el PRD permite cualquier proveedor y el
adaptador (`src/agente/llm.ts`) existe justamente para que cambiarlo toque un
solo archivo.

Por qué Claude/Sonnet para este caso de uso:

- Uso de herramientas (tool use) estructurado y confiable con esquemas
  `zod`/JSON Schema, que es el único canal por el que el modelo puede afirmar
  un valor en este diseño — necesita ser preciso llamando la herramienta
  correcta con los argumentos correctos, no "creativo".
- Sigue bien instrucciones estrictas y negativas ("nunca inventes un dato",
  "nunca llames `oc_crear` sin confirmación") sostenidas en un system prompt
  largo y separado del código, que es exactamente cómo pide el PRD que viva
  el comportamiento (`src/agente/prompt.md`).
- Relación costo/calidad adecuada para un flujo de pocas llamadas por caso
  (lectura, validación, confirmación) frente a modelos de gama alta que
  serían sobredimensionados para este problema.

**Costo estimado por caso procesado** (orden de magnitud, no medición real —
se debe recalcular con `out/log.jsonl` una vez el ciclo esté implementado):
un caso sin excepciones recorre ~4 llamadas a herramienta (`leer_paquete`,
`validar`, `construir_payload`, `generar_evidencia` + `crear`), cada una con
el system prompt, el historial acumulado y el resultado JSON de la
herramienta anterior en el contexto. Estimando ~8.000–12.000 tokens de
entrada y ~1.000–1.500 de salida por caso a los precios públicos de Sonnet
(del orden de USD 3 / MTok de entrada y USD 15 / MTok de salida), el costo
ronda **USD 0.04–0.06 por caso**, con ~5–8 llamadas a herramienta en total si
se cuentan los turnos de confirmación (un caso con confirmación agrega un
turno más: la pregunta y la respuesta del usuario). Es una estimación de
diseño, no una medición — se recalcula con `out/log.jsonl` una vez el ciclo
esté implementado. `MAX_TOKENS_POR_SESION` y `MAX_COSTO_USD_POR_SESION` en
`.env.example` existen justamente para que ninguna sesión pueda escaparse de
este orden de magnitud, con dos topes independientes (tokens y USD) por si
cambia el precio del proveedor.

## 5. Matriz de controles

Las 10 reglas viven como funciones puras en `src/reglas/controles.ts`: reciben
`Paquete` + `Maestros` (`src/maestros.ts`) y devuelven una `Validacion` con
`bloqueos`, `confirmaciones` y `derivados` — nunca invocan al modelo.

| # | Tipo | Cómo se implementa |
|---|---|---|
| RC1 | Bloqueo | Busca el proveedor en `proveedores.json` por `nit`; si no hay NIT, por nombre normalizado (minúsculas, sin tildes, sin puntuación, sin sufijos "S.A.S."/"S.A."/"Ltda."). Bloquea si no aparece o si `activo = false`. |
| RC2 | Bloqueo | Exige `aprobacion.aprobado = true` y que el remitente (`aprobacion.de`) esté en la lista de `aprobadores` del `centro_costo` de la solicitud. |
| RC3 | Bloqueo | Con el aprobador ya resuelto por RC2, compara `valor_total` contra su `tope` para ese centro de costo. |
| RC4 | Bloqueo | Verifica que el `centro_costo` exista y que `subarea` esté en su lista de `subareas`. |
| RC5 | Confirmación | `abs(cotizacion.total − valor_total) / valor_total`; confirma si supera 2 % o si no hay cotización, mostrando ambos valores en el detalle. |
| RC6 | Confirmación + derivado | Si falta `indicador_iva`, lo deriva de `proveedor.indicador_iva_default` y agrega una confirmación (no es solo informativo). |
| RC7 | Derivado | Si falta `condiciones_pago`, lo deriva de `proveedor.condiciones_pago_default` sin pedir confirmación: solo se informa en `derivados`. |
| RC8 | Confirmación | Si existe `factura` con fecha anterior a `fecha_solicitud`, marca `retroactiva = true` y agrega confirmación (queda en `out/control.csv`). |
| RC9 | Confirmación | Compara la fecha de aprobación contra `fecha_solicitud`; si es anterior, confirma. |
| RC10 | Bloqueo | `cantidad × valor_unitario` vs. `valor_total`, tolerancia ±1 unidad monetaria. |

Cada hallazgo (`Hallazgo` en `src/tipos.ts`) trae `codigo`, `detalle` en
lenguaje llano con los números de por medio, y una `recomendacion` accionable
para el humano — el objetivo no es solo "esto no cuadra" sino "esto es lo
próximo que hay que hacer".

**La regla más difícil de implementar fue RC2**, porque no es independiente:
resolver "quién puede aprobar" requiere primero resolver el `centro_costo`
(RC4) y, una vez resuelto el aprobador correcto, RC3 (tope) y RC9 (fecha de
aprobación) dependen de ese mismo aprobador. Si RC2 falla en encontrar al
aprobador, RC3 y RC9 no tienen contra qué comparar y no deberían dispararse
con un mensaje engañoso ("tope superado" cuando en realidad no hay aprobador
válido). El orden de evaluación —centro de costo, luego aprobación, y solo
si ambos resuelven, tope y fecha— importa tanto como la comparación en sí.

## 6. Diseño del adaptador SAP real

`src/sap/adapter.ts` fija la interfaz (`consultarProveedor`, `crearOrden`,
`buscarOrdenPorReferencia`) y `src/sap/mock.ts` la implementa sobre archivos
en `out/sap/`. Para producción:

**Opción de integración elegida: OData `API_PURCHASEORDER_PROCESS_SRV`** (SAP
S/4HANA, expuesto vía SAP Gateway/BTP) en vez de RFC/BAPI directo
(`BAPI_PO_CREATE1`) o SAP Integration Suite como intermediario. Razón: dado
que la viabilidad de la conexión no está confirmada (§2.1 del PRD), OData
sobre HTTPS es lo que más chance tiene de estar ya expuesto o de habilitarse
rápido sin abrir un canal RFC persistente ni instalar conectores SAP GUI en
el servidor del agente; además el contrato es más fácil de simular y probar
con contratos JSON, parecido a como ya está modelado `OrdenCompra` en
`src/tipos.ts`. Si el Gateway OData no estuviera expuesto y abrirlo no fuera
viable en el corto plazo, la alternativa es SAP Integration Suite como capa
intermedia: el agente seguiría hablando HTTPS/JSON hacia el iFlow, y este
traduciría internamente a IDoc o BAPI sin que el backend del agente tenga que
manejar esos protocolos.

**Mapeo del payload de 7.4 a la estructura real**: la cabecera de
`OrdenCompra` (`sociedad` → `CompanyCode`, `organizacion_compras` →
`PurchasingOrganization`, `proveedor.codigo_sap` → `Supplier`, `moneda` →
`DocumentCurrency`, `condiciones_pago` → `PaymentTerms`) mapea a la entidad
`PurchaseOrder`; cada elemento de `posiciones` mapea a una entidad hija
`PurchaseOrderItem` (`descripcion` → texto breve, `cantidad` →
`OrderQuantity`, `precio_unitario` → `NetPriceAmount`, `centro_costo` y
`subarea` → la cuenta de asignación de la posición, `indicador_iva` →
`TaxCode`). `referencia.solicitud_id` se guarda en un campo de referencia de
cabecera (p. ej. `YourReference`) — es la clave de la idempotencia. La
evidencia de aprobación (`out/<caso>/aprobacion.txt` o `.pdf`) se sube aparte
por el servicio de adjuntos de SAP (Attachment/ArchiveLink) referenciando el
número de OC ya creado.

**Autenticación y credenciales**: OAuth2 client credentials (o certificado
x.509) contra el mismo IdP corporativo, con un scope acotado a creación y
consulta de órdenes de compra. Las credenciales viven como variables de
entorno del backend, igual que la clave del modelo — nunca en el agente, en
el prompt, en el repositorio ni en el front. Se rotan igual que cualquier
credencial de servicio.

**Idempotencia frente a reintentos**: mismo principio que ya usa `mock.ts`:
antes de crear, `buscarOrdenPorReferencia(solicitud_id)` consulta si ya existe
una OC con esa referencia; si existe, se devuelve esa (`idempotente: true`)
en vez de crear una segunda. Si SAP responde con error parcial (por ejemplo,
timeout después de haber creado la orden del lado de SAP), el adaptador real
debe **consultar por referencia antes de reintentar la creación**, nunca
asumir que un timeout significa que no se creó nada.

**Plan B si la conexión no es viable**: el agente igual ahorra la digitación
generando, en `out/sap-carga/<caso>.csv` (o el formato de carga masiva que
use el equipo, tipo LSMW), una fila lista para importar con los mismos campos
de `OrdenCompra`, más el payload resumido en el chat "listo para pegar" en
SAP GUI. La analista deja de digitar de memoria y de validar reglas a mano;
solo pega o importa un archivo ya validado.

## 7. Lectura del proceso

## 8. Decisiones y trade-offs

### Estado de `paquete`/`validacion`/`payload` en el servidor, no en el modelo

**Contexto y hallazgo.** Al verificar el ciclo en vivo contra la API real de
Gemini (`gemini-flash-lite-latest`, el modelo más económico de la familia,
elegido a propósito), el caso más simple posible (`sol-001`, sin bloqueos ni
confirmaciones) **no llegaba a crear la orden dentro del tope fijo de 8
iteraciones**. La causa, confirmada con las trazas reales del servidor, no
era la API ni el modelo "fallando": el diseño original le pedía al modelo que
**reprodujera de memoria, como argumento de la siguiente llamada**, el
`Paquete` completo devuelto por `oc_leer_paquete` y la `Validacion` completa
devuelta por `oc_validar` — objetos JSON grandes y anidados. El modelo
económico, al copiarlos, omitía sistemáticamente las claves cuyo valor era
`null` (`cotizacion.validez_hasta`, `paquete.factura`,
`derivados.indicador_iva`/`condiciones_pago`) porque `.nullable()` en
`src/tipos.ts` exige la clave presente (aunque sea `null`), no solo el valor —
y `.nullable()` no se puede tocar por otra cosa que no sea el schema, que está
fuera de alcance (`tipos.ts` no se modifica). Cada omisión disparaba un
rechazo de zod y consumía una iteración completa en el reintento; con dos
reintentos (en `oc_validar` y en `oc_construir_payload`) ya no alcanzaba el
tope para llegar a `oc_crear`.

**Decisión tomada:** mover ese estado al servidor. `src/agente/ciclo.ts`
ahora guarda, por sesión y por `caso`, el último `Paquete` leído, la última
`Validacion`, el `sha256` de la evidencia y el `payload` construido
(`EstadoCaso` / `estadosPorCaso`, ver el archivo). Las herramientas
`oc_validar`, `oc_construir_payload` y `oc_crear` pasaron a exponerle al
modelo un esquema de argumentos reducido — básicamente `{ caso }` (más
`confirmado` en `oc_crear`, que sí es una decisión genuina del humano) — y es
`ciclo.ts` quien arma los argumentos completos que la herramienta real
necesita, tomándolos de esa caché, antes de llamar a su `execute()` sin
cambiarle el contrato. Si el modelo invoca una herramienta para un caso cuyo
paso previo no se ejecutó todavía en esa sesión (por ejemplo, `oc_validar`
sin haber llamado antes a `oc_leer_paquete`), no se resuelve en silencio: se
le devuelve un error explícito indicando qué llamar primero. El contrato de
cada herramienta en `src/tools/oc.ts` (su `args`/`execute`, lo que exige el
PRD §6.2) no cambió en absoluto, y `demo.ts` —que llama a las herramientas
directo, sin pasar por `ciclo.ts`— sigue funcionando exactamente igual.

**Resultado medido** (tres corridas en vivo contra la API real, sesión
nueva cada vez, `gemini-flash-lite-latest` sin cambiar):

| Caso | Resultado | Iteraciones consumidas |
|---|---|---|
| `sol-001` (creación limpia) | OC `4500000001`, `idempotente:false` | 6 de 8 |
| `sol-001` otra vez | misma OC `4500000001`, `idempotente:true` | 6 de 8 |
| `sol-003` (bloqueo RC2+RC3) | no crea, bloqueos reportados | 3 de 8 |

El peor caso observado (una creación completa: leer, validar, generar
evidencia, construir payload, crear, más el mensaje final) gasta **6 de 8**
iteraciones — exactamente el techo estructural del flujo documentado en
`src/agente/prompt.md` §"Las herramientas y su secuencia", sin ningún
reintento por error de reproducción. **El tope de 8 sigue siendo razonable**:
deja 2 iteraciones de margen para un imprevisto real (una llamada que falla y
se reintenta una vez), no hace falta subirlo.

**Alternativa descartada: subir de modelo.** Cambiar `gemini-flash-lite-latest`
por un modelo Gemini más capaz también habría resuelto el síntoma (un modelo
más grande reproduce JSON grande con más fidelidad). Se descartó porque trata
el síntoma, no la causa: le paga a un modelo — con dinero real, por token, en
cada llamada — por hacer de memoria (reproducir un objeto que ya existe en
el servidor) un trabajo que el servidor puede hacer determinísticamente y
gratis. Además no elimina el riesgo de fondo: incluso un modelo más capaz
puede, ocasionalmente, reproducir mal un objeto grande, y ese riesgo
desaparece por completo — no "se reduce" — moviendo el estado al servidor.
El criterio general: si un dato ya salió de una herramienta en esta sesión,
el modelo no debería tener que volver a escribirlo para que el sistema lo
reconozca.

## 9. Supuestos

## 10. Cobertura

> Estado verificado al cierre de la oleada 3 (deploy/seguridad/módulo bonus en
> construcción paralela a esta sección). Cada fila se confirmó releyendo el
> código real al momento de escribir esto, no de memoria de oleadas
> anteriores.

| Historia | Estado | Qué falta |
|---|---|---|
| HU-1 · Leer el paquete | **Hecho** | `oc_leer_paquete` (`src/tools/oc.ts`) normaliza los 5 campos del paquete; un adjunto ausente (`cotizacion`, `aprobacion`, `factura`) se reporta como `null` sin lanzar excepción. Verificado en `demo.ts` (28/28 aserciones, los 6 casos) y en varias corridas en vivo contra la API real de Gemini. Nada pendiente dentro del alcance del reto. |
| HU-2 · Validar contra maestros y controles | **Hecho** | RC1–RC10 completos en `src/reglas/controles.ts`, expuestos vía `oc_validar`. `apta`, `bloqueos`, `confirmaciones`, `derivados` verificados en `demo.ts` y en vivo: bloqueos RC1 (sol-002), RC2+RC3 (sol-003), confirmaciones RC5 (sol-004), RC8 retroactiva (sol-005), RC6+RC7 derivados (sol-006) — los cinco, ejercitados de verdad contra el modelo real, no solo en el motor de reglas aislado. |
| HU-3 · Construir el payload | **Hecho** | `oc_construir_payload` valida contra `OrdenCompraSchema` y escribe la trazabilidad en `out/<caso>/trazabilidad.json`. Supuesto documentado (no una falla): `posiciones[0].unidad` queda fija en `"UN"` porque `Solicitud` (`src/tipos.ts`) no trae un campo de unidad — no hay nada de qué derivarla. |
| HU-4 · Generar la evidencia de aprobación | **Parcial** | P0 (`aprobacion.txt` con encabezados, cuerpo y `sha256`) hecho y probado repetidas veces. P1 (`aprobacion.pdf`) **no implementado**: no hay dependencia `pdf-lib` en `package.json` ni código que genere PDF — queda pendiente, es opcional según el PRD. |
| HU-5 · Crear la OC en SAP simulado | **Hecho** | `oc_crear` con numeración secuencial desde `4500000001` (`src/sap/mock.ts`), idempotencia verificada en vivo varias veces (mismo `numero_oc`, `idempotente:true`, sin duplicar), `out/control.csv` con las columnas exactas. El ciclo completo (`src/agente/ciclo.ts`, `src/server.ts`, `src/agente/llm.ts`) está construido y probado de punta a punta contra la API real de Gemini, incluido el flujo de confirmación humana (respondido tanto con el literal `"confirmo"` como con un `"sí"` libre) y un gate de dos partes en código (`casoConfirmacionPendiente` + `casosValidadosEnEsteTurno`) que impide que una confirmación abandonada, o autoconfirmada dentro del mismo turno en que se replantea, cree una orden — cubierto por tests que fallan sin el gate y pasan con él (`src/agente/ciclo.test.ts`). |
| HU-6 · Manejo de errores | **Hecho** | `ResultadoHerramienta<T>` en las 6 herramientas, ninguna lanza excepción; probado con casos reales (paquete inexistente, argumentos inválidos del modelo, error real de cuota de la API de Gemini) sin que la sesión muera. `oc_leer_excel` sigue siendo un stub deliberado — P1 opcional del PRD, no una falla de HU-6. |

**Fuera de las 6 HU, pero relevante para no inflar la cobertura general:**
- **Front (`web/`)**: construido en la oleada 1 (HTML+JS plano, tarjetas de herramienta, banner de confirmación). Dentro de esta sesión se probó el ciclo completo contra Gemini real, pero **siempre a través de un cliente de prueba en Bun** (`fetch` + parseo manual de SSE), nunca abriendo `web/index.html` en un navegador real contra el servidor corriendo. El contrato SSE que consume (`web/CONTRATO.md`) es el mismo que implementa `src/server.ts`, pero la combinación front-navegador + backend real no tiene una verificación visual todavía.
- **Despliegue**: a la fecha de esta sección, `README.md` todavía dice `<pendiente-de-despliegue>` en "Link de prueba" — no hay una URL pública confirmada. Es tarea de otro agente de esta misma oleada; si seguís viendo este placeholder, no está resuelto todavía.

## 11. Uso de IA

_Pendiente de consolidar — este repositorio se construye con varios agentes de
IA en paralelo, organizados por oleadas (ver `prompts/oleada-1.md` a
`oleada-4-auditor.md`, material de trabajo interno, no se sube al
repositorio). Esta sección documenta la porción de "Documentación base"
(oleada 1): se usó un agente Claude Code (modelo Sonnet, fijado explícitamente
al inicio de la sesión) para redactar `README.md`, `.env.example`, los
scripts de `package.json` y este esqueleto de `SOLUCION.md`, a partir de una
lectura completa de `CLAUDE.md` y `referencia/PRD.md` — sin tocar `src/`,
`web/` ni `fixtures/`. El detalle completo de qué se le pidió a la IA en cada
oleada, qué propuso y qué se descartó, se consolida al final con el dueño del
proyecto una vez cierran las cuatro oleadas._

## 12. Riesgos

- **Credenciales expuestas** (clave del modelo hoy; usuario/contraseña
  técnico o cliente OAuth2 de SAP en producción, sección 6). Mitigación: se
  leen solo de variables de entorno del backend (`GEMINI_API_KEY` y, en
  producción, las credenciales del adaptador SAP real); nunca viajan al
  front, al prompt, al repositorio ni a los logs, y `/api/health` nunca las
  expone (CLAUDE.md). Se rotan igual que cualquier credencial de servicio.
- **El modelo "arregla" un dato para que el flujo avance** (alucinación de
  datos). Es el riesgo que más le importa a este diseño. Mitigación: los
  controles RC1–RC10 viven en código puro (`src/reglas/controles.ts`), nunca
  en el prompt; el payload final sale de `oc_construir_payload`, no de texto
  libre del modelo; y `oc_crear` rechaza estructuralmente crear con un
  bloqueo abierto o una confirmación pendiente sin `confirmado: true`, sin
  depender de que el modelo "se acuerde" de la regla.
- **Doble creación de la misma OC** (por ejemplo, un reintento del front tras
  un timeout, o el usuario confirmando dos veces). Mitigación: `oc_crear`
  siempre consulta `buscarOrdenPorReferencia(solicitud_id)` antes de crear
  (HU-5); si ya existe, devuelve el mismo número con `idempotente: true` en
  vez de una segunda orden. La numeración secuencial vive en un único archivo
  (`out/sap/ordenes.jsonl`), no en escrituras concurrentes descoordinadas.
- **Cambios de maestros no reflejados** (proveedores, centros de costo,
  indicadores de IVA o condiciones de pago que cambian en SAP real pero
  quedan desactualizados en la copia que usa el agente). En este reto los
  maestros son los JSON estáticos de `fixtures/`; en producción deberían
  consultarse en vivo o replicarse con sincronización frecuente, no vivir en
  un archivo que alguien olvida actualizar.
- **La conexión real a SAP no sea viable en el corto plazo.** Mitigación:
  Plan B documentado en la sección 6 (archivo de carga masiva / payload listo
  para pegar), que igual elimina la digitación aunque no la creación
  automática.
- **El correo de aprobación no sea evidencia suficiente para auditoría.**
  Hoy RC2 valida que exista y venga del aprobador correcto, pero un correo es
  falsificable en teoría. Mitigación a futuro: exigir firma digital o que la
  aprobación pase por un flujo con SSO en vez de texto libre de correo.
- **Uso indebido de un link público sin autenticación.** El PRD permite que
  el link de prueba sea público. Mitigación: el tope fijo de 8 iteraciones
  por turno (código, `CLAUDE.md`) y los topes por sesión configurables por
  variable de entorno (`MAX_TOKENS_POR_SESION`, `MAX_COSTO_USD_POR_SESION`)
  acotan cuánto puede gastar una sesión de la clave del modelo; en producción
  esto se complementa con autenticación real y rate limiting, ambos fuera del
  alcance de este reto (sección 3.2).
- **El tope de costo se verifica entre turnos, no entre iteraciones, dentro de
  un mismo turno** (`src/agente/ciclo.ts`, función `procesarMensaje`).
  `MAX_COSTO_USD_POR_SESION` (y `MAX_TOKENS_POR_SESION`) se comprueban una
  sola vez, al recibir cada mensaje nuevo del usuario — no se vuelven a
  evaluar entre las hasta 8 idas y vueltas herramienta→modelo que puede tener
  ese mismo turno (CA1). En la práctica, esto significa que una sola vuelta
  con varias llamadas a herramienta puede terminar gastando más de lo que el
  tope permite antes de que el control se dispare, recién en el próximo
  mensaje del usuario. Se dejó así por simplicidad: el gasto de un turno ya
  está acotado arriba por el tope fijo de 8 iteraciones, así que el peor caso
  es finito y conocido (8 llamadas al modelo, cada una con `maxOutputTokens`
  limitado), no una fuga sin límite — no hacía falta más precisión para el
  alcance de este reto. El arreglo correcto para producción sería revisar el
  acumulado de costo/tokens **dentro** del bucle de iteraciones (justo después
  de sumar cada respuesta del modelo, antes de decidir si se le pide otra
  herramienta), cortando el turno a mitad de camino con el mismo mensaje de
  "se alcanzó el tope" en vez de esperar al siguiente mensaje del usuario.
- **Cinco-más agentes de IA construyendo en paralelo sobre el mismo
  repositorio.** Riesgo de contratos inconsistentes entre módulos (por
  ejemplo, que una herramienta devuelva una forma distinta a la que espera el
  ciclo). Mitigación: `src/tipos.ts` como vocabulario compartido que nadie
  modifica, y `bunx tsc --noEmit` como compuerta obligatoria antes de dar por
  cerrada cualquier oleada.
