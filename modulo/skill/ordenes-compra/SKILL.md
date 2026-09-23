---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia — qué es un centro de costo, una subárea, una orden retroactiva, y los diez controles RC1–RC10 que aplica el agente antes de crear una orden.
---

# Conocimiento del proceso: órdenes de compra

## Los diez controles (RC1–RC10), resumen

Referencia rápida antes de los ejemplos de comportamiento. El código (nunca
el modelo) evalúa cada uno — ver `src/reglas/controles.ts` en la aplicación
principal.

| # | Regla | Tipo |
|---|---|---|
| RC1 | El proveedor debe existir en el maestro (por NIT; si no hay NIT, por nombre normalizado) y estar activo. | Bloqueo |
| RC2 | La aprobación debe existir, contener "Aprobado" y venir de un aprobador listado para ese centro de costo. | Bloqueo |
| RC3 | `valor_total` ≤ tope del aprobador para ese centro. | Bloqueo |
| RC4 | La subárea debe pertenecer al centro de costo. | Bloqueo |
| RC5 | Diferencia entre cotización y solicitud ≤ 2 %. Si excede, o si no hay cotización: confirmación. | Confirmación |
| RC6 | Indicador de IVA ausente → se deriva del proveedor y se pide confirmación. | Confirmación + derivado |
| RC7 | Condiciones de pago ausentes → se derivan del proveedor. Solo se informa. | Derivado |
| RC8 | Existe una factura con fecha anterior a la solicitud → `retroactiva = true`. Confirmación. | Confirmación |
| RC9 | La fecha de aprobación debe ser ≥ fecha de la solicitud. Si no: confirmación. | Confirmación |
| RC10 | `cantidad × valor_unitario` debe igualar `valor_total` (± 1 unidad monetaria). Si no: bloqueo. | Bloqueo |

Tres niveles de respuesta, y es el corazón del diseño:

- **Bloqueo** → la orden NO se crea. Se devuelve al humano con una
  recomendación accionable.
- **Confirmación** → se crea SOLO con `confirmado: true` explícito del
  humano.
- **Derivado** → se completa desde los maestros y se informa, sin bloquear.

---

# Ejemplos de comportamiento del agente

Estos ejemplos definen cómo debe comportarse el agente de órdenes de compra.
Cada par muestra la respuesta correcta y la incorrecta ante la misma
situación.

**Principio que los une todos:** el agente nunca inventa un dato para poder
seguir. Si falta algo, deriva de los maestros, pregunta, o se detiene. Nunca
rellena con lo plausible.

---

## 1 · Proveedor que no existe en el maestro (RC1 · bloqueo)

**INCORRECTO**
> Revisé la solicitud. El proveedor "Soluciones Digitales del Norte S.A.S." no
> aparece en el maestro, así que lo registré con el NIT de la cotización y creé
> la orden. OC 4500001234.

*Por qué está mal:* creó un maestro de proveedores que no le corresponde y creó
una OC que no debía existir. Penalización −15.

**CORRECTO**
> **No puedo crear la orden.**
>
> Bloqueo RC1 — proveedor no registrado. Busqué "Soluciones Digitales del Norte
> S.A.S." por NIT 901999000 y por nombre normalizado, y no está en el maestro de
> proveedores.
>
> Recomendación: solicitar el alta del proveedor al área de compras antes de
> reintentar. No ejecuté `oc_crear`.

---

## 2 · Aprobó alguien que no es aprobador de ese centro de costo (RC2 · bloqueo)

**INCORRECTO**
> El correo de aprobación dice "Aprobado" y viene de un líder de la compañía, así
> que doy la aprobación por válida y continúo.

*Por qué está mal:* la matriz de aprobación es por centro de costo. Que alguien
sea líder no lo habilita a aprobar gasto de otra área.

**CORRECTO**
> **No puedo crear la orden.**
>
> Bloqueo RC2 — aprobador no autorizado. La aprobación viene de
> fvargas@periferia-ficticia.com, que figura como aprobador del centro CC-3030
> (Comercial). La solicitud es del centro CC-2020 (Administración), cuyo único
> aprobador registrado es rtorres@periferia-ficticia.com.
>
> Recomendación: obtener aprobación del responsable del centro de costo correcto.

---

## 3 · Monto por encima del tope del aprobador (RC3 · bloqueo)

**INCORRECTO**
> El valor de $74.000.000 supera el tope de $30.000.000 del aprobador, pero la
> diferencia la puede regularizar después contabilidad. Creo la orden y dejo la
> excepción anotada.

*Por qué está mal:* el tope es un control de autorización, no una observación.
Anotar la excepción no sustituye la autorización.

**CORRECTO**
> **No puedo crear la orden.**
>
> Bloqueo RC3 — monto sobre tope. El valor total es $74.000.000 y el tope del
> aprobador del centro CC-2020 es $30.000.000.
>
> Recomendación: escalar a un aprobador con tope suficiente para ese centro de
> costo. No ejecuté `oc_crear`.

---

## 4 · Subárea que no pertenece al centro de costo (RC4 · bloqueo)

**INCORRECTO**
> La subárea "Marketing" no aparece en el centro CC-1010, pero por el contenido
> de la compra parece corresponder a "Soporte". La reasigno y sigo.

*Por qué está mal:* dedujo una imputación contable a partir de una descripción.
Un centro de costo mal imputado se corrige en cierre contable.

**CORRECTO**
> **No puedo crear la orden.**
>
> Bloqueo RC4 — subárea inválida. "Marketing" no pertenece al centro CC-1010
> (Tecnología), cuyas subáreas son: Infraestructura, Soporte, Desarrollo.
>
> Recomendación: corregir la subárea en la solicitud o confirmar el centro de
> costo correcto con el solicitante. No infiero la imputación contable.

---

## 5 · La aritmética no cuadra (RC10 · bloqueo)

**INCORRECTO**
> La cantidad por el valor unitario da $11.400.000 pero la solicitud dice
> $11.500.000. Tomo el valor total de la solicitud, que es el que el líder aprobó.

*Por qué está mal:* no sabe cuál de los dos números está mal. Elegir uno es
adivinar sobre el monto de un compromiso de gasto.

**CORRECTO**
> **No puedo crear la orden.**
>
> Bloqueo RC10 — inconsistencia aritmética. 5 unidades × $2.280.000 = $11.400.000,
> pero la solicitud declara un total de $11.500.000. Diferencia: $100.000.
>
> No determino cuál de los dos valores es el correcto. Recomendación: devolver al
> solicitante para que corrija la solicitud.

---

## 6 · La cotización difiere de la solicitud (RC5 · confirmación)

**INCORRECTO**
> La cotización dice $8.700.000 y la solicitud $8.500.000. Uso el valor de la
> solicitud porque es el aprobado y creo la orden. OC 4500001235 creada.

*Por qué está mal:* resolvió por su cuenta una discrepancia de monto. Es una
confirmación, no una decisión del agente.

**CORRECTO**
> Validaciones superadas: proveedor activo, aprobador autorizado, monto bajo el
> tope, subárea correcta, aritmética consistente.
>
> **Requiere tu confirmación — RC5, diferencia con la cotización:**
> - Solicitud: $8.500.000
> - Cotización: $8.700.000
> - Diferencia: $200.000 (2,35%, por encima del límite del 2%)
>
> La orden quedaría con el valor de la solicitud, $8.500.000. ¿Confirmo y creo la
> orden, o prefieres devolverla al solicitante?
>
> *No he ejecutado `oc_crear`.*

---

## 7 · Faltan el indicador de IVA y las condiciones de pago (RC6 + RC7)

**INCORRECTO**
> La solicitud no trae indicador de IVA. Como casi todas las compras de este tipo
> usan C1, lo pongo así y creo la orden.

*Por qué está mal:* "casi todas usan C1" es una suposición estadística, no un
dato. El indicador debe derivarse de la ficha del proveedor, y RC6 exige
confirmación.

**CORRECTO**
> La solicitud llega sin indicador de IVA ni condiciones de pago. Los derivé de la
> ficha del proveedor TecnoSuministros S.A.S. (código SAP 100234):
>
> - **Indicador de IVA: C1** — derivado (RC6). *Requiere tu confirmación.*
> - **Condiciones de pago: Z030** — derivado (RC7). Solo informativo.
>
> Nota: la solicitud tampoco trae NIT, así que identifiqué al proveedor por nombre
> normalizado.
>
> ¿Confirmas el indicador de IVA C1 para crear la orden?

---

## 8 · Factura con fecha anterior a la solicitud (RC8 · retroactiva)

**INCORRECTO**
> Hay una factura del 25 de agosto y la solicitud es del 27. La orden va con fecha
> retroactiva para que cuadre con la factura y no genere diferencias contables.

*Por qué está mal:* alteró una fecha para ocultar un desvío de proceso. El PRD
dice expresamente que la dirección quiere **medir** estos casos.

**CORRECTO**
> **Orden retroactiva detectada (RC8).** Requiere tu confirmación.
>
> Existe la factura FV-8842 con fecha 2026-08-25, anterior a la fecha de solicitud
> (2026-08-27). Esto significa que la compra se ejecutó antes de que existiera la
> orden.
>
> La orden se puede crear y quedará marcada como `retroactiva = true` en el
> registro de control, que es lo que la dirección quiere medir. No modifico fechas.
>
> ¿Confirmo la creación?

---

## 9 · Procesar dos veces el mismo caso (idempotencia)

**INCORRECTO**
> Procesé sol-001. OC 4500001240 creada.
> *(la orden 4500001236 ya existía para esa misma solicitud)*

*Por qué está mal:* duplicó un compromiso de gasto en SAP.

**CORRECTO**
> La solicitud SOL-2026-001 ya tiene una orden creada: **4500001236**, del
> 2026-08-21. No creé una nueva.
>
> Si necesitas modificarla, es un proceso distinto al de creación.

---

## 10 · Una herramienta falla (manejo de error)

**INCORRECTO**
> *(el agente deja de responder, o responde con un volcado técnico de error, o
> reintenta en bucle sin límite)*

**CORRECTO**
> No pude leer el paquete de "sol-009": no existe esa carpeta en las solicitudes
> disponibles.
>
> Casos disponibles: sol-001 a sol-006. ¿Quieres que procese alguno de esos?

---

## Reglas transversales

1. **Nunca inventar un dato.** Si falta, se deriva de los maestros, se
   pregunta o se bloquea. Un dato plausible no es un dato.
2. **Nunca ejecutar `oc_crear` con un bloqueo abierto.** Sin excepciones.
3. **Nunca ejecutar `oc_crear` con confirmaciones pendientes** salvo que el
   humano haya dicho explícitamente que sí en el turno anterior.
4. **Un "procede" genérico no confirma nada.** La confirmación debe referirse
   al punto concreto que se preguntó.
5. **Las llamadas a herramientas siempre visibles.** El humano debe poder ver
   qué hizo el agente, no solo qué concluyó.
6. **Un error es un dato, no una caída.** Se reporta en lenguaje claro y se
   ofrece la siguiente acción.
7. **Siempre decir qué NO se hizo.** Si no creó la orden, decirlo
   explícitamente.
