# SOLUCION.md — Agente conversacional de Órdenes de Compra (Periferia)

> Estructura obligatoria según `referencia/PRD.md` §9.1.

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
5. Cada vuelta del paso 2–3 cuenta como una iteración. Al llegar al tope
   (`MAX_ITERACIONES`, 8 por defecto — `CLAUDE.md`; no los 25 que sugiere el
   PRD genérico en §6.3/CA1, el criterio propio del proyecto prevalece sobre
   la sugerencia genérica; configurable por variable de entorno porque el PRD
   pide explícitamente que lo sea, aunque el valor por defecto no cambió), el
   ciclo corta, arma una respuesta con lo que se alcanzó a hacer y lo que
   falta, y se lo dice explícitamente al usuario — no reintenta en silencio
   ni entra en bucle.

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
argumentos y resultado resumido) y se anexa como una línea JSON a
`out/log.jsonl` (`ts`, `sessionId`, `herramienta`, `args`, `resultado`
completo) — `registrarLog` en `src/agente/ciclo.ts`, nunca lanza si falla la
escritura (deja constancia en stderr y el turno sigue). Un error de
herramienta o del proveedor de modelo (incluido un timeout de esa llamada) se
traduce a lenguaje claro en el chat; la sesión sigue viva y el siguiente
mensaje del usuario se puede seguir procesando.

## 4. Elección del modelo

**Proveedor y modelo:** Google Gemini, modelo `gemini-flash-lite-latest`, el de menor costo de la familia. El modelo se verificó contra el listado real de la API, no se asumió por nombre.

**Por qué.** La decisión depende de qué se le pide al modelo dentro de este proceso, y aquí se le pide poco. Las diez reglas de control están en código: comparar un NIT contra el maestro, un monto contra un tope, una fecha contra otra. El modelo no interviene en ninguna.

Lo que sí hace son tres cosas: entender lo que la analista escribe en el chat, extraer datos de textos en prosa como el correo de aprobación y la cotización, y conducir la conversación cuando hay que pedir una confirmación.

Ninguna de las tres mejora con un modelo de mayor capacidad. Extraer una fecha y un nombre de un correo de dos párrafos no se hace mejor con más razonamiento disponible; se hace igual. Pagar por esa capacidad sería pagar por algo que el proceso no usa.

**Un matiz que vale la pena, porque el más económico tampoco es automático.** Durante las pruebas, este modelo falló, pero no razonando: fallaba copiando. El diseño original lo obligaba a transportar los datos de la solicitud de una herramienta a la siguiente, y omitía los campos vacíos. La respuesta correcta no fue subir de modelo, sino quitarle esa tarea y dejar el estado del lado del servidor. El detalle está en la sección 8.

De ahí sale el criterio: la capacidad del modelo se elige según lo que efectivamente se le pide, y si algo falla, primero se revisa si se le está pidiendo lo que corresponde.

**Costo por caso.** En la capa gratuita de Google AI Studio el costo es cero, que es lo que se usó para este reto. Como referencia para producción, un caso limpio consume seis llamadas al modelo y el peor caso medido también seis, con entradas del orden de unos pocos miles de tokens cada una. Medido sobre una corrida real de sol-001, un caso consume 48.624 tokens y cuesta USD 0,005, es decir medio centavo de dólar por orden.

La estimación importa menos que el mecanismo: el sistema mide el consumo por caso y lo registra junto con la orden, de modo que el costo real se conoce con datos y no con proyecciones. La sección 10 explica para qué sirve ese dato.

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

**La regla más difícil de implementar fue RC2**, porque el dato que necesita
—quién puede aprobar— depende de resolver primero el `centro_costo` de la
solicitud: la lista de `aprobadores` vive por centro de costo (`CentroCosto`
en `src/tipos.ts`), no es global. `controles.ts` busca ese `centroCosto` una
sola vez, al principio de `validar()`, y RC2, RC3, RC4 y RC9 lo reutilizan
cada una por su lado.

RC3 (tope) y RC9 (fecha de aprobación) **se evalúan de forma independiente**
de si RC2 encontró o no a un aprobador válido — a propósito, no por omisión.
`src/reglas/controles.ts` las corre siempre que hay `aprobacion` en el
paquete: RC3 usa el tope del aprobador que coincida en ese centro de costo
si lo hay, y si no, el tope más alto entre los aprobadores registrados para
ese centro (nunca deja de validar el monto solo porque RC2 ya lo marcó como
no autorizado). La razón es que **encadenarlas escondería hallazgos reales**:
`sol-003` (fixture real) tiene a la vez un
aprobador que no corresponde a ese centro de costo (RC2) y un monto por
encima del tope de cualquier aprobador posible (RC3) — si RC3 dependiera de
que RC2 resuelva primero, el segundo bloqueo quedaría oculto hasta que se
resuelva el primero, y quien lee el resultado tendría que corregir y
reintentar dos veces en vez de ver ambos problemas juntos. `demo.ts` verifica
exactamente esto: `sol-003` sale con **ambos** códigos, RC2 y RC3, en el mismo
resultado de `oc_validar`.

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

## 7. Lectura del proceso: órdenes de compra retroactivas

**Qué encontré.** El control RC8 marca los casos donde existe una factura con
fecha anterior a la solicitud: la compra se ejecutó antes de que existiera
una orden aprobada. El diagnóstico del proceso indica que esto ocurre con
frecuencia y que la cotización se omite en esos casos. Hoy no se sabe qué
porcentaje del total representa.

**Por qué importa.** La aprobación previa no es un paso administrativo. Es el
momento en que se toman cinco decisiones distintas: si el gasto es
necesario, a qué proveedor se le compra, a qué precio, con cargo a qué
centro de costo, y quién asume la responsabilidad según su tope. Las cinco
requieren que la compra todavía no haya ocurrido.

Cuando la factura llega primero, ninguna de las cinco sigue disponible. No
se decide si comprar, porque ya se compró. No se elige proveedor, porque ya
se eligió. No se negocia precio, porque el proveedor sabe que no hay
competencia. El centro de costo se imputa para cuadrar, no para planear. Y
quien firma asume un compromiso que ya no puede evitar, incluso si el monto
supera su tope, en cuyo caso el gasto quedó sin autorización válida.

El control no se debilita: cambia de naturaleza. Deja de ser una decisión y
pasa a ser el registro de algo que ya ocurrió. Esa es la diferencia entre
proteger el patrimonio y documentar su uso.

Hay una consecuencia adicional. Cuando comprar primero y legalizar después
funciona sin costo, la matriz de aprobación deja de operar en la práctica
aunque siga vigente en el papel. A partir de cierta frecuencia, el problema
ya no son las órdenes retroactivas: es que el control dejó de existir.

**Qué propongo.**

**1. Medir desde el primer día.** El agente produce el registro que hoy no
existe: porcentaje de retroactivas sobre el total, desagregado por área
solicitante, aprobador, proveedor, monto y antigüedad de la factura. Esa
desagregación no es descriptiva, decide la respuesta. Si las retroactivas se
concentran en montos bajos y urgentes, el proceso no tiene un carril rápido
y la gente lo esquiva para poder trabajar. Si se concentran en montos
altos, es un problema de autorización y la respuesta es otra.

**2. Control inmediato por monto, sin esperar la medición.** Bloquear todas
las órdenes retroactivas no es una opción. La compra ya ocurrió: el
proveedor entregó, la factura existe y la obligación de pago también.
Negarse a crear la orden no revierte nada; deja un gasto ejecutado por
fuera del sistema y un proveedor sin pagar. Todas tienen que terminar
registradas, porque lo que no queda registrado no se puede medir ni
corregir.

Entonces la pregunta no es si se registran, sino por qué vía. Y ahí la
práctica establecida distingue dos cosas que suelen confundirse. Aprobar es
autorizar algo que todavía puede no hacerse. Ratificar es reconocer, por
escrito y con nombre, que se autoriza algo ya ejecutado. Cuando la factura
llegó primero, lo que corresponde es ratificar, y eso se tramita como
excepción documentada.

Esa distinción tiene una consecuencia práctica que justifica el esfuerzo: la
excepción se cuenta y se reporta, mientras que una aprobación tardía
registrada como aprobación normal desaparece entre las demás y el indicador
nunca se construye.

Queda definir a partir de qué monto la ratificación exige un nivel superior.
El umbral no hay que inventarlo: la matriz de aprobación vigente ya
establece qué montos requieren qué jerarquía, y esa es la decisión de riesgo
que la compañía ya tomó. La ratificación se sujeta a la misma matriz.

Hay un caso donde esto deja de ser un trámite. Si el monto supera el tope de
quien aprobó, el gasto no quedó aprobado tarde: quedó comprometido por
alguien que nunca tuvo la facultad de comprometerlo. Ahí la ratificación
tiene que venir del nivel que sí la tiene, y ese caso se reporta aparte.

El umbral queda provisional hasta la primera medición. Si la mayoría de los
casos cae por debajo, no está separando nada y hay que bajarlo.

**3. Plan de remediación con responsable y fecha.** El área administrativa
perdió capacidad operativa y digita cada orden a mano. Eso no justifica el
desvío, pero sí explica su volumen, y tiene un efecto práctico: si se
endurece el control sin reducir el tiempo de creación de la orden, el
desvío no desaparece, se vuelve más difícil de detectar. Las solicitudes
empiezan a fecharse hacia atrás y se pierde el indicador. El agente ataca
esa causa directamente, porque reduce el tiempo de creación a minutos.

**4. Seguimiento mensual al comité, con la tendencia.** No alertas caso por
caso: a la tercera semana nadie las abre. Dos indicadores: porcentaje de
retroactivas sobre el total, y monto acumulado comprometido sin aprobación
previa. Si el primero baja y el segundo no, el problema se movió a las
compras grandes y es más grave, no menos.

**Cómo se trata esto en compañías con control interno formalizado.** No se
explica por qué ocurrió. Se levanta el hallazgo, se asigna responsable con
fecha de remediación y se hace seguimiento hasta el cierre. La causa raíz,
incluida la falta de capacidad operativa, se documenta dentro del plan,
nunca como atenuante del incumplimiento. Un desvío aislado se corrige en el
área; uno sistemático que ya fue reportado y persiste escala al comité de
auditoría.

**Qué hace el agente y qué no.** El agente detecta el caso, exige
confirmación explícita, lo registra (RC8, `src/reglas/controles.ts`) y
produce la medición (`retroactiva` en cada fila de `out/control.csv`). No
modifica fechas ni bloquea por defecto, porque bloquear no revierte una
compra ya ejecutada: solo trasladaría el trabajo a un proceso manual
paralelo, sin registro, y se perdería el dato.

Lo que el agente no puede hacer es impedir que alguien decida comprar fuera
del proceso. Esa decisión se toma antes de que exista cualquier solicitud,
fuera del alcance de cualquier sistema. El agente convierte un desvío
invisible en un dato contado y ejecuta el control donde el control todavía
puede operar. Corregir la causa es una decisión de gobierno.

## 8. Decisiones y trade-offs

El PRD define diez reglas de control, RC1 a RC10, que toda solicitud debe
pasar antes de convertirse en orden de compra. Verifican cosas como que el
proveedor exista y esté activo, que el aprobador pertenezca al centro de
costo correcto, que el monto no supere su tope, o que la factura no tenga
fecha anterior a la solicitud. Según el resultado, una solicitud puede
quedar bloqueada, requerir confirmación del usuario, o pasar limpia.

Las tres decisiones que siguen determinan quién hace qué dentro de ese
proceso: qué resuelve el programa, qué resuelve el modelo de lenguaje, y qué
requiere que una persona decida.

### 1. Las validaciones las ejecuta el programa, no el modelo de lenguaje

Las diez reglas están escritas como código (`src/reglas/controles.ts`).
Cuando llega una solicitud, el programa compara el NIT contra el maestro de
proveedores, el monto contra el tope del aprobador, la fecha de la factura
contra la de la solicitud. El modelo de lenguaje no participa en ninguna de
esas comparaciones.

Lo que sí hace el modelo son las tareas donde el resultado depende de
interpretar algo escrito en lenguaje natural: leer el correo de aprobación y
extraer quién aprobó y cuándo (normalizado por `oc_leer_paquete`, con
`estaAprobado` como detección determinística, no del modelo), entender lo
que el analista escribe en el chat, y conducir la conversación cuando hay
que pedir una confirmación.

**Alternativa descartada:** entregarle las diez reglas al modelo como
conocimiento y dejar que las aplique.

**Por qué:** una comparación en código da el mismo resultado todas las
veces, y se puede demostrar sin llamar al modelo (`demo.ts`). Si tiene un
error, es un error fijo que se corrige una vez. El mismo control aplicado
por un modelo puede acertar nueve veces y fallar la décima sin que haya
cambiado nada, y no hay manera de garantizar que la décima no sea la de la
demostración en vivo.

**Condición para que esto funcione:** los datos que alimentan las reglas
(topes de aprobación, maestro de proveedores, matriz de centros de costo)
tienen que poder modificarse sin tocar el programa. Si ampliar la facultad
de un aprobador exige un despliegue, el control deja de reflejar lo que la
compañía decidió. Hoy esos datos son los JSON estáticos de `fixtures/`; la
administración de esos datos en producción se describe en la sección 10.

### 2. El servidor guarda lo que el agente ya leyó; el modelo no lo transporta

Procesar una solicitud toma varios pasos: leer el paquete de documentos,
validarlo, generar la evidencia, construir el mensaje para SAP y crear la
orden. Cada paso necesita los datos del paso anterior. En este diseño, el
servidor los guarda y cada herramienta recibe únicamente el identificador
del caso.

**Alternativa descartada:** que el modelo copie el paquete completo de una
llamada a la siguiente, que fue el diseño inicial.

**Por qué:** se probó contra la API real de Gemini (`gemini-flash-lite-latest`,
el modelo más económico de la familia, elegido a propósito) y falló de
forma reproducible: el caso más simple posible (`sol-001`, sin bloqueos ni
confirmaciones) no llegaba a crear la orden dentro del tope de iteraciones.
Al copiar el `Paquete` y la `Validacion` completos de una llamada a la
siguiente, el modelo omitía sistemáticamente las claves cuyo valor era
`null` (`cotizacion.validez_hasta`, `paquete.factura`,
`derivados.indicador_iva`/`condiciones_pago`) porque `.nullable()` en
`src/tipos.ts` exige la clave presente (aunque sea `null`), no solo el
valor — y el esquema está fuera de alcance (`tipos.ts` no se modifica). Cada
omisión disparaba un rechazo de zod y consumía una iteración completa en el
reintento; con dos reintentos (en `oc_validar` y en `oc_construir_payload`)
ya no alcanzaba el tope para llegar a `oc_crear`.

Había dos salidas. Una era usar un modelo más capaz, que probablemente copia
sin equivocarse. La otra era quitarle al modelo la tarea de transportar
datos. Elegí la segunda: la primera paga capacidad de razonamiento — con
dinero real, por token, en cada llamada — para resolver un problema de
transcripción, y deja la causa intacta, de modo que el defecto reaparece en
cuanto el objeto vuelve a crecer. El criterio general: si un dato ya salió
de una herramienta en esta sesión, el modelo no debería tener que volver a
escribirlo para que el sistema lo reconozca.

`src/agente/ciclo.ts` ahora guarda, por sesión y por `caso`, el último
`Paquete` leído, la última `Validacion`, el `sha256` de la evidencia y el
`payload` construido (`EstadoCaso` / `estadosPorCaso`). Las herramientas
`oc_validar`, `oc_construir_payload` y `oc_crear` pasaron a exponerle al
modelo un esquema de argumentos reducido — básicamente `{ caso }` (más
`confirmado` en `oc_crear`, que sí es una decisión genuina del humano) — y es
`ciclo.ts` quien arma los argumentos completos que la herramienta real
necesita, tomándolos de esa caché, antes de llamar a su `execute()` sin
cambiarle el contrato. Si el modelo invoca una herramienta para un caso cuyo
paso previo no se ejecutó todavía en esa sesión, no se resuelve en
silencio: se le devuelve un error explícito indicando qué llamar primero. El
contrato de cada herramienta en `src/tools/oc.ts` (su `args`/`execute`, lo
que exige el PRD §6.2) no cambió, y `demo.ts` —que llama a las herramientas
directo, sin pasar por `ciclo.ts`— sigue funcionando exactamente igual.

**Resultado medido** (tres corridas en vivo contra la API real, sesión nueva
cada vez, `gemini-flash-lite-latest` sin cambiar):

| Caso | Resultado | Iteraciones consumidas |
|---|---|---|
| `sol-001` (creación limpia) | OC `4500000001`, `idempotente:false` | 6 de 8 |
| `sol-001` otra vez | misma OC `4500000001`, `idempotente:true` | 6 de 8 |
| `sol-003` (bloqueo RC2+RC3) | no crea, bloqueos reportados | 3 de 8 |

El peor caso observado (una creación completa: leer, validar, generar
evidencia, construir payload, crear, más el mensaje final) gasta **6 de
8** iteraciones — el mismo caso pasó de agotar las ocho sin crear nada, con
el diseño descartado, a consumir seis con el estado en el servidor. Con
`MAX_ITERACIONES` en 8 por defecto quedan 2 iteraciones de margen para un
imprevisto real (una llamada que falla y se reintenta una vez).

### 3. Un bloqueo no se levanta desde el chat

Las diez reglas producen dos tipos de resultado adverso. Unas piden
confirmación: el agente muestra una diferencia y pregunta si procede igual.
Otras bloquean: el agente explica qué falta y no ofrece forma de continuar.

**Alternativa descartada:** permitir que el usuario levante también los
bloqueos confirmando.

**Por qué:** las dos situaciones son distintas. En una confirmación, el
usuario tiene el dato a la vista y decide con criterio, por ejemplo si
acepta una diferencia entre el monto cotizado y el solicitado. Un bloqueo
señala que falta una condición para que la orden sea válida: el proveedor no
existe en el maestro, o el aprobador no pertenece al centro de costo.
Confirmar no crea el proveedor.

Lo que el bloqueo produce es la tarea correcta. El caso queda pendiente,
alguien crea el proveedor en el maestro, y la solicitud se reprocesa y pasa.
El dato queda arreglado para todas las órdenes siguientes. Si en cambio el
bloqueo se pudiera confirmar, la orden saldría y el maestro seguiría
incompleto, apareciendo otra vez en la próxima compra al mismo proveedor.
Esto es lo que hace `oc_crear` estructuralmente: rechaza crear si
`validacion.bloqueos.length > 0`, sin ninguna forma de pasarle por alto ese
resultado desde sus argumentos.

## 9. Supuestos

El PRD describe el punto de partida y el de llegada, pero deja tramos sin
definir en el medio. Para ubicar dónde, conviene recorrer el proceso
completo tal como ocurre hoy:

1. Un área necesita comprar algo y envía por correo la solicitud, la
   cotización y el respaldo.
2. El líder responde ese correo aprobando.
3. La analista administrativa lee el correo, revisa que todo esté completo
   y que la aprobación sea válida.
4. La analista digita la orden en SAP.
5. La orden queda registrada y contabilidad puede revisarla.

El reto pide automatizar el paso 4 y buena parte del 3. Los supuestos que
siguen corresponden a los tramos que el PRD no define.

**1. Cómo llegan los documentos al agente.** En el reto, los documentos de
cada solicitud están puestos de antemano en carpetas del sistema
(`fixtures/reto-03/solicitudes/<caso>/`): el correo, la solicitud, la
cotización y la aprobación. El agente los lee de ahí cuando la analista le
indica el número de caso.

En el proceso real esos documentos llegan como adjuntos de un correo. El PRD
no define quién los recibe ni quién los guarda. Asumí que existe un paso
previo, fuera del alcance de este entregable, que recibe el correo y deja
los documentos disponibles para el agente. Sin ese paso, alguien tendría que
hacerlo a mano, y el tiempo que se ahorra en el paso 4 se volvería a gastar
antes.

**2. Quién inicia la conversación.** El PRD plantea que la analista escribe
en el chat "procesa la solicitud tal". Asumí eso y así está construido.

Vale señalar lo que implica. La analista sigue revisando su correo para
enterarse de qué llegó, y después escribe el número de cada caso. Si
llegaron diez solicitudes, lee diez correos igual que antes. Lo que se
automatiza es el paso 4, que es la digitación.

El diseño que propongo en la sección 10 mueve el inicio al agente: él revisa
qué llegó y le presenta a la analista un resumen de las solicitudes del día,
indicando cuáles están completas y cuáles necesitan su decisión. La analista
deja de buscar y pasa a decidir. El canal directo se mantiene para los casos
urgentes.

**3. Que el caso indicado sea el caso correcto.** Los diez controles
verifican que una solicitud esté bien por dentro: que su proveedor exista,
que su aprobador tenga facultad, que los montos coincidan. Ninguno puede
verificar que la solicitud procesada sea la que la analista quería procesar.

Si escribe un número equivocado que corresponde a otra solicitud real, el
agente la procesa entera, pasa todos los controles y crea una orden correcta
de un pedido que nadie pidió.

Asumí que el número que la analista escribe es el correcto. Este supuesto
desaparece con el diseño del punto anterior: si el agente presenta la lista
de lo que llegó y la analista responde sobre esa lista, nadie transcribe
nada y el error deja de ser posible.

**4. Quién confirma las excepciones.** Cuando un control exige confirmación,
la orden registra el nombre de quien la autorizó (`confirmado_por` en cada
excepción, `src/tools/oc.ts`). El reto declara la autenticación de usuarios
fuera de alcance, así que ese nombre sale de la variable de entorno
`USUARIO_CONFIRMADOR` (por defecto `"analista"`), configurada una vez para
todo el servicio — no por sesión ni por persona. En producción sale de la
sesión del usuario que está conectado.

**5. Numeración de órdenes.** El consecutivo de la orden de compra se asigna
localmente (`src/sap/mock.ts`, un archivo `out/sap/ordenes.jsonl`
serializado con un mutex en el proceso — ver sección 10, "Qué falta para
producción", punto 7). Esto asume una sola instancia del sistema en
ejecución. Con varias, el consecutivo lo entrega la base de datos, que es lo
estándar. Fuera del alcance del reto, que declara la persistencia como
no-objetivo.

## 10. Cobertura y qué falta para producción

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
- **Despliegue**: en producción (Render.com free tier, Docker) en
  **https://agente-oc-periferia.onrender.com** — sin clave de acceso,
  público. Verificado en vivo contra esa URL (no localhost): procesa
  `sol-001` y crea la OC `4500000001` correctamente. Detalle en `README.md`
  ("Link de prueba"). El plan gratuito de Render duerme tras ~15 min sin
  tráfico; el primer pedido después de eso puede tardar hasta un minuto en
  responder — es el arranque en frío del plan, no una falla de la app.

### Qué falta para producción

Lo entregado resuelve el tramo que el reto delimitó: dada una solicitud ya
identificada, validarla contra los controles y crear la orden. Lo que sigue
es lo que falta para que esto funcione en el proceso real.

**1. Que los documentos lleguen solos al agente.** En el reto, los
documentos de cada solicitud ya están en una carpeta del sistema. Alguien
los puso ahí. El PRD no dice quién.

Si en producción eso lo hace una persona, el proceso empeora: alguien
tendría que abrir cada correo, descargar los adjuntos y guardarlos en la
carpeta correcta. Eso toma más tiempo que digitar la orden en SAP, que es
justamente lo que se quería eliminar.

Hace falta una pieza que reciba el correo y guarde sus adjuntos. Es lo
primero que hay que construir, porque sin eso el agente no tiene con qué
trabajar.

**2. Que el agente inicie el trabajo y le cuente qué llegó.** Hoy la
analista revisa su correo, se entera de qué llegó y escribe el número de
cada solicitud en el chat. Si llegaron diez, lee diez correos. Lo que se
automatiza es la digitación.

La alternativa es que el agente revise lo que llegó, procese lo que está
completo y le presente un resumen. El resumen tiene que decir de qué se
trata cada solicitud, no solo cuántas hay, porque la analista es
responsable de lo que se aprueba y no puede autorizar algo que no sabe qué
es:

```
Llegaron 10 solicitudes.

Listas para crear (8):
- Contabilidad, renovación de 15 licencias de software, $12.400.000,
  proveedor Softline
- Gestión Humana, dotación de seguridad, $3.200.000, proveedor
  Dotaciones del Norte
- (…)

Bloqueada (1): Mantenimiento, repuestos de planta, $8.900.000. El
proveedor no está en el maestro.

Necesita tu decisión (1): Contabilidad, equipos de cómputo. La
solicitud dice $25.000.000 y la cotización $26.500.000, una
diferencia de 6 %. ¿Procedo?
```

Con eso la analista deja de buscar y transcribir, y solo decide sobre las
excepciones. El canal directo se mantiene: quien tiene algo urgente escribe
al chat y el agente lo atiende de inmediato.

Hay además un efecto sobre el control. Cuando la analista escribe el número
a mano puede equivocarse, y el agente procesaría un caso real que nadie
pidió (ver sección 9, supuesto 3). Si ella responde sobre la lista que el
agente le mostró, nadie transcribe nada y ese error deja de ser posible.

**3. Que los topes y los maestros se puedan cambiar sin tocar el sistema.**
Los topes de aprobación, el maestro de proveedores y la matriz de centros de
costo hoy están dentro del proyecto (`fixtures/reto-03/maestros/`, de solo
lectura por diseño de este reto). Cambiar el tope de una persona exige que
un desarrollador modifique el sistema y lo despliegue de nuevo.

Eso no funciona en un proceso de compras. Si la junta amplía la facultad de
un directivo, el cambio tiene que estar vigente el lunes.

La solución es simple: que esos datos vivan afuera, en un archivo que el
área responsable pueda editar, con permisos de escritura limitados a quien
corresponda. El sistema lo lee cada vez que valida.

Lo único que hay que agregar es registro. Cambiar quién puede aprobar
cuánto es exactamente la decisión que la matriz existe para vigilar, así
que cada modificación debe dejar quién la hizo, cuándo y desde cuándo rige.
Y cada orden creada debe guardar contra qué versión se validó, para que una
revisión posterior pueda reconstruir con qué reglas se aprobó.

**4. Que lo pendiente quede registrado y se retome.** Hoy el agente responde
dentro de una conversación (el estado vive en memoria del proceso,
`estadosPorCaso` en `src/agente/ciclo.ts`). Si un caso queda bloqueado o
esperando una decisión, no queda anotado en ninguna parte más allá de esa
sesión: si la analista cierra el chat, o el servicio se reinicia, eso se
pierde de vista.

Hace falta que cada solicitud tenga un estado que persista: creada,
bloqueada por tal control, o esperando decisión de tal persona desde tal
fecha. Con eso el agente puede retomar sin que nadie se lo pida, y
contabilidad puede ver qué está trabado y por qué.

Ese estado es lo que habilita los dos puntos que siguen.

**5. Que el proceso siga cuando quien decide no está.** Si la persona que
confirma las excepciones se enferma o sale de vacaciones, las solicitudes
que esperan su decisión se quedan quietas. El proceso de compras no puede
detenerse por eso.

Se resuelve con el mismo archivo del punto 3: se parametriza quién
reemplaza a quién. Si Camila no está, las decisiones pendientes pasan a
Pedro. La orden registra que la confirmó Pedro (el mismo mecanismo que hoy
resuelve `USUARIO_CONFIRMADOR`, sección 9 supuesto 4 — ahí es un único
valor fijo; en producción tendría que resolver a la persona que efectivamente
confirmó, con su reemplazo vigente).

Quién reemplaza a quién es una definición de la compañía. Lo que el sistema
tiene que hacer es permitir declararla y respetarla.

**6. Qué pasa cuando algo falla.** El proceso depende de sistemas que
pueden no responder: SAP, el proveedor del modelo, la red.

La regla es que una orden nunca quede a medias. O se creó y quedó
registrada con su evidencia, o no se creó y la solicitud sigue pendiente. Lo
que no puede pasar es que quede una orden en SAP sin registro de control, o
un registro de control sin orden en SAP, porque entonces nadie sabe cuál de
los dos dice la verdad. Hoy `oc_crear` ya se acerca a esto dentro de lo que
permite un solo proceso: siempre re-deriva la validación y siempre escribe
`out/control.csv`, en ese orden, antes de terminar (`src/tools/oc.ts`); lo
que falta es que ese estado sobreviva a un reinicio del proceso, no solo a
una excepción dentro de él.

Con el estado del punto 4, la falla se maneja sola. Si SAP no responde, la
solicitud queda marcada como pendiente por falla técnica, con el motivo, y
el agente la reintenta más tarde. Si después de varios intentos sigue
fallando, se lo informa a la analista en vez de seguir reintentando en
silencio.

Eso distingue dos cosas que se ven parecidas y no lo son. Una solicitud
pendiente porque SAP está caído se resuelve sola cuando SAP vuelve. Una
solicitud pendiente porque falta una decisión humana no se resuelve nunca
sola, y hay que recordársela a alguien.

**7. Numerar órdenes cuando haya más de un sistema corriendo.** El número de
la orden se asigna en secuencia: la primera es `4500000001`, la siguiente
`4500000002`. Ese contador está en un archivo local (`out/sap/ordenes.jsonl`,
`src/sap/mock.ts`) protegido con un mutex **dentro del proceso**: dos
pedidos concurrentes contra la misma instancia del servidor ya no pueden
recibir el mismo número (verificado con 20 creaciones simultáneas para
solicitudes distintas → 20 números únicos, y 20 creaciones simultáneas para
la misma solicitud → una sola orden). Lo que el mutex no resuelve es que
haya **más de una instancia del servidor** corriendo a la vez: dos procesos
en dos servidores no comparten ese mutex en memoria, y podrían leer el mismo
último número al mismo tiempo.

Se resuelve delegando el consecutivo a la base de datos, que garantiza que
dos procesos simultáneos reciban números distintos. Es el mecanismo estándar
y no tiene complejidad. Quedó fuera porque el reto declaró la persistencia
en base de datos como no-objetivo.

**8. Qué se monitorea.** Una vez operando, el proceso necesita sus propios
indicadores:

- Cuántas solicitudes se procesan y cuántas terminan en orden creada.
- Qué proporción queda bloqueada, y por cuál control.
- Qué proporción requiere confirmación humana.
- Qué proporción es retroactiva, que es el indicador de la sección 7.

El más informativo es la proporción de confirmaciones. Si sube sin que
nadie haya cambiado las reglas, significa que las áreas empezaron a
solicitar de otra manera, y conviene enterarse por el indicador y no por
una auditoría.

**Costo y tiempo por orden.** Cada llamada al modelo informa cuántos tokens
consumió (`tokens_entrada`/`tokens_salida`, ya capturados por
`src/agente/ciclo.ts` para el tope de costo por sesión), y el agente sabe a
qué solicitud corresponde, así que el costo de cada orden se puede guardar
junto con ella — hoy `out/log.jsonl` guarda cada llamada a herramienta con
su `ts`, pero no el costo agregado por caso. Lo mismo con el tiempo entre
que la solicitud entró y la orden quedó creada.

Medirlo por orden y no por la factura mensual permite distinguir si el
total subió por mayor volumen, que es buena noticia, o porque cada caso se
volvió más caro, que hay que ir a mirar.

## 11. Uso de IA

**Qué se usó y para qué.** Claude Code fue la herramienta principal de
construcción. Se trabajó en etapas, con varios agentes en paralelo sobre
archivos separados en cada una: una etapa para los controles y las
herramientas, otra para el ciclo del agente y el servidor, y una última
para el despliegue y el módulo reutilizable. Al cierre, dos revisiones
independientes: una contra el PRD y la lista de criterios, y otra sobre el
código (`out/auditoria.txt`).

El modelo que usa el agente en ejecución es Gemini (`gemini-flash-lite-latest`),
por las razones de la sección 4. No interviene en la construcción.

**Qué se descartó de lo que el asistente propuso.**

_Subir a un modelo más capaz para resolver un problema de transcripción._
Durante las pruebas contra la API real, el agente no lograba completar la
creación de la orden: el diseño original obligaba al modelo a copiar los
datos de la solicitud de una herramienta a la siguiente, y al copiarlos
omitía los campos vacíos. Cada omisión consumía una iteración del ciclo, y
el caso más simple agotaba el presupuesto de ocho sin crear nada.

La propuesta fue cambiar a un modelo de mayor capacidad, que probablemente
copia sin error. Se descartó: el problema no era la capacidad del modelo
sino la tarea que se le estaba asignando. Un modelo de lenguaje no es un
mecanismo confiable para transportar datos, y pagar más por capacidad de
razonamiento no corrige eso, solo lo disimula hasta que el objeto vuelve a
crecer. Se movió el estado al servidor y el modelo dejó de transportar
nada. El mismo caso pasó de agotar las ocho iteraciones a consumir seis
(sección 8, decisión 2).

_Confiar la verificación al mismo asistente que escribió el código._ Durante
las pruebas, el asistente reportaba que los casos funcionaban. Esa
afirmación provenía de quien había escrito el código que se estaba
probando, y en al menos una ocasión el reporte fue impreciso sin que
hubiera intención de serlo.

Se cambió el procedimiento: en lugar de pedir un veredicto, se pide la
salida literal de los archivos que produce el proceso, y el resultado se
guarda en disco antes de mostrarse. El log de control (`out/control.csv`) y
el registro de órdenes (`out/sap/ordenes.jsonl`) son archivos que se leen
directo. A eso se suma `demo.ts`, que ejecuta los seis casos sin llamar al
modelo y produce un resultado idéntico en cada corrida (28/28 aserciones).

La verificación de esta entrega no depende de que un asistente afirme que
funciona.

## 12. Riesgos

### Riesgos técnicos de esta implementación

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
  vez de una segunda orden. Además, `crearOrden` en `src/sap/mock.ts` es
  idempotente por sí misma dentro de la misma sección crítica (protegida por
  un mutex en el proceso), así que dos pedidos concurrentes para la misma
  solicitud nunca reciben números distintos — verificado con 20 creaciones
  simultáneas para solicitudes distintas (20 números únicos y consecutivos) y
  20 para la misma solicitud (una sola orden). Sigue limitado a una sola
  instancia del servidor: con más de una, hace falta el consecutivo de base
  de datos de la sección 10.
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
  el link de prueba sea público. Mitigación: el tope de iteraciones por turno
  (`MAX_ITERACIONES`, código, `CLAUDE.md`) y los topes por sesión configurables
  por variable de entorno (`MAX_TOKENS_POR_SESION`, `MAX_COSTO_USD_POR_SESION`)
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
  está acotado arriba por `MAX_ITERACIONES` (8 por defecto), así que el peor
  caso es finito y conocido (8 llamadas al modelo, cada una con
  `maxOutputTokens` limitado), no una fuga sin límite — no hacía falta más
  precisión para el alcance de este reto. El arreglo correcto para producción sería revisar el
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

### Riesgos de operación y canal

- **La información de compras sale del perímetro.** Si el chat opera por un
  canal como WhatsApp, la conversación queda en el teléfono de la analista y
  en la infraestructura de un tercero. Ahí hay proveedores, montos, quién
  aprueba qué y en qué gasta cada área. Si el teléfono se pierde o la
  persona sale de la empresa, esa información se va con él.

  La respuesta no es prohibir el canal: una regla que la operación no puede
  cumplir se incumple, y termina usándose igual sin control. Lo que sí se
  puede hacer es limitar qué queda ahí:

  - **La conversación se borra cuando el caso se cierra.** La conversación
    existe mientras hay una decisión abierta. Cuando la orden se crea, o el
    caso queda registrado como pendiente, la conversación se borra. El
    pendiente no vive en el chat: vive en el registro del sistema, que es
    de donde el agente lo saca después para recordarlo (esto asume el
    estado persistente de la sección 10, punto 4 — hoy, sin ese estado, lo
    que existe es la sesión en memoria del proceso, que ya no sobrevive un
    reinicio, pero tampoco es un registro consultable por auditoría).
  - **El registro vive en el sistema de la compañía.** Qué se procesó, qué
    quedó bloqueado, quién confirmó qué y cuándo. Eso es lo que consultan
    contabilidad y auditoría. El chat es el canal por donde se habla, no
    donde se guarda nada.
  - **El agente muestra lo necesario para decidir.** Para confirmar una
    diferencia de monto alcanzan los dos valores y el proveedor. No hace
    falta volcar la cotización completa al chat.
  - **El acceso debería atarse a personas registradas.** No implementado en
    esta entrega — el link de prueba de la sección 10 es público y sin
    autenticación (ver el riesgo "Uso indebido de un link público sin
    autenticación" arriba). Si se implementa, el agente respondería solo a
    los números o cuentas autorizadas, y si alguien sale de la empresa se
    le retira el acceso — con ese diseño, el teléfono deja de ser un
    archivo: si se pierde, se pierde una conversación de un caso en curso,
    no el historial de compras de la compañía.

- **Riesgos evaluados que no son propios de esta solución:**
  - **Brecha en el proveedor del modelo.** Un fallo en el proveedor puede
    exponer lo que se le envía. Es el mismo riesgo que asume cualquier
    servicio alojado con un tercero, incluido SAP en la nube, y se
    administra por contrato: acuerdos sobre tratamiento de datos, retención
    y uso para entrenamiento. Aplica a toda solución con IA, no a esta en
    particular.
  - **Uso indebido de credenciales.** Si alguien comparte su acceso, otro
    puede confirmar en su nombre. Es manejo de accesos de la compañía,
    igual que con cualquier sistema.
  - **Datos maestros desactualizados.** Un proveedor no registrado bloquea
    la solicitud (RC1). El bloqueo es correcto; que ocurra seguido indica
    que el mantenimiento del maestro necesita atención. Es operación del
    proceso, no del sistema.
