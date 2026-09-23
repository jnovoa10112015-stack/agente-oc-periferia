/**
 * Cubre el edge case de `needs_confirmation` huérfana: una confirmación
 * pendiente (RC5, RC8, etc.) no debe reaparecer ni aplicarse a una solicitud
 * distinta si el usuario, en vez de responder "confirmo"/"cancelo", manda
 * cualquier otro mensaje. Usa las herramientas reales de `../tools/oc` contra
 * los fixtures reales (sol-004, sol-005) y un `AdaptadorLLM` de prueba
 * "guionado" para no depender de ningún proveedor de modelo.
 */

import { describe, test, expect } from "bun:test";
import { rm } from "node:fs/promises";
import type { AdaptadorLLM, RespuestaLLM, MensajeLLM } from "./llm";
import { procesarMensaje } from "./ciclo";
import type { EventoCiclo } from "./ciclo";
import type { ResultadoHerramienta } from "../tipos";

const DIRECTORY = process.cwd();

function respuestaTexto(texto: string): ResultadoHerramienta<RespuestaLLM> {
  return { ok: true, data: { texto, llamadas_herramienta: [], tokens_entrada: 5, tokens_salida: 5 } };
}

function respuestaLlamada(id: string, nombre: string, args: unknown): ResultadoHerramienta<RespuestaLLM> {
  return {
    ok: true,
    data: { texto: null, llamadas_herramienta: [{ id, nombre, args }], tokens_entrada: 5, tokens_salida: 5 },
  };
}

function huboLlamadaA(mensajes: MensajeLLM[], nombre: string): boolean {
  return mensajes.some((m) => m.rol === "assistant" && m.llamadas_herramienta.some((l) => l.nombre === nombre));
}

/** Busca, en todo el historial acumulado de la sesión, el `data` del último resultado de una herramienta por nombre. */
function resultadoDeHerramienta(mensajes: MensajeLLM[], nombre: string): unknown {
  const encontrado = [...mensajes].reverse().find((m) => m.rol === "tool" && m.nombre === nombre);
  if (!encontrado || encontrado.rol !== "tool") {
    throw new Error(`El guión del test esperaba un resultado previo de "${nombre}" y no lo encontró.`);
  }
  const parseado = JSON.parse(encontrado.contenido) as { ok: boolean; data?: unknown };
  if (!parseado.ok) throw new Error(`La herramienta "${nombre}" falló en el guión del test: ${encontrado.contenido}`);
  return parseado.data;
}

/** Adaptador de prueba: leer_paquete(caso) → validar(caso) → termina en texto (pidiendo confirmación). */
function crearLlmProcesarCaso(caso: string, textoFinal: string): AdaptadorLLM {
  return {
    async enviar(_system, mensajes) {
      if (!huboLlamadaA(mensajes, "oc_leer_paquete")) {
        return respuestaLlamada("call_leer", "oc_leer_paquete", { caso });
      }
      if (!huboLlamadaA(mensajes, "oc_validar")) {
        const paquete = resultadoDeHerramienta(mensajes, "oc_leer_paquete");
        return respuestaLlamada("call_validar", "oc_validar", { caso, paquete });
      }
      return respuestaTexto(textoFinal);
    },
  };
}

/** Igual que `crearLlmProcesarCaso`, pero completa la cadena entera hasta
 *  `oc_construir_payload` (así `estado.payload` queda poblado) antes de
 *  terminar en texto — mirror exacto de lo que pasó en vivo contra Gemini. */
function crearLlmProcesarCasoCompleto(caso: string, textoFinal: string): AdaptadorLLM {
  return {
    async enviar(_system, mensajes) {
      if (!huboLlamadaA(mensajes, "oc_leer_paquete")) {
        return respuestaLlamada("call_leer", "oc_leer_paquete", { caso });
      }
      if (!huboLlamadaA(mensajes, "oc_validar")) {
        return respuestaLlamada("call_validar", "oc_validar", { caso });
      }
      if (!huboLlamadaA(mensajes, "oc_generar_evidencia")) {
        return respuestaLlamada("call_evidencia", "oc_generar_evidencia", { caso });
      }
      if (!huboLlamadaA(mensajes, "oc_construir_payload")) {
        return respuestaLlamada("call_payload", "oc_construir_payload", { caso });
      }
      return respuestaTexto(textoFinal);
    },
  };
}

/** Reproduce el hallazgo real contra Gemini: en un solo turno, re-deriva todo
 *  desde cero (leer → validar → evidencia → payload) y encima intenta
 *  confirmar y crear, todo en el mismo turno en que la confirmación (re)nace.
 *  Usa un contador propio (no mira el historial) porque `huboLlamadaA` ya
 *  daría "true" por llamadas de turnos ANTERIORES — acá interesa forzar que
 *  esas 5 llamadas ocurran todas dentro de ESTE turno en particular. */
function crearLlmReprocesaYConfirmaEnElMismoTurno(caso: string): AdaptadorLLM {
  const pasos: Array<() => ResultadoHerramienta<RespuestaLLM>> = [
    () => respuestaLlamada("call_leer_mt", "oc_leer_paquete", { caso }),
    () => respuestaLlamada("call_validar_mt", "oc_validar", { caso }),
    () => respuestaLlamada("call_evidencia_mt", "oc_generar_evidencia", { caso }),
    () => respuestaLlamada("call_payload_mt", "oc_construir_payload", { caso }),
    () => respuestaLlamada("call_crear_mismo_turno", "oc_crear", { caso, confirmado: true }),
  ];
  let indice = 0;
  return {
    async enviar() {
      const paso = pasos[Math.min(indice, pasos.length - 1)]!;
      indice++;
      return paso();
    },
  };
}

/** Adaptador de prueba: responde con un solo texto, nunca llama herramientas. */
function crearLlmTextoSimple(texto: string): AdaptadorLLM {
  return {
    async enviar() {
      return respuestaTexto(texto);
    },
  };
}

function capturador(): { eventos: EventoCiclo[]; emitir: (e: EventoCiclo) => void } {
  const eventos: EventoCiclo[] = [];
  return { eventos, emitir: (e) => eventos.push(e) };
}

function tieneEvento(eventos: EventoCiclo[], nombre: EventoCiclo["evento"]): boolean {
  return eventos.some((e) => e.evento === nombre);
}

describe("ciclo.ts — invalidación de confirmación pendiente huérfana", () => {
  test("confirmación abandonada y luego un 'sí' tardío no la reactiva ni crea nada", async () => {
    const sessionId = `test-huerfana-si-${Date.now()}`;

    const cap1 = capturador();
    await procesarMensaje(
      crearLlmProcesarCaso("sol-004", "Hay una diferencia con la cotización (RC5). ¿Confirmás que sigo con el valor de la solicitud?"),
      DIRECTORY,
      sessionId,
      "procesa sol-004",
      cap1.emitir
    );
    expect(tieneEvento(cap1.eventos, "needs_confirmation")).toBe(true);

    // Turno intermedio: mensaje sin relación, el modelo no llama ninguna herramienta.
    const cap2 = capturador();
    await procesarMensaje(
      crearLlmTextoSimple("Claro, ¿en qué más te ayudo?"),
      DIRECTORY,
      sessionId,
      "¿qué tal el clima hoy?",
      cap2.emitir
    );
    expect(tieneEvento(cap2.eventos, "needs_confirmation")).toBe(false);

    // "sí" tardío: no es el literal "confirmo", así que no debe resucitar la
    // confirmación de sol-004 ni disparar oc_crear.
    const cap3 = capturador();
    await procesarMensaje(
      crearLlmTextoSimple("No tengo ninguna confirmación pendiente en este momento."),
      DIRECTORY,
      sessionId,
      "sí",
      cap3.emitir
    );
    expect(tieneEvento(cap3.eventos, "needs_confirmation")).toBe(false);
    expect(cap3.eventos.some((e) => e.evento === "tool_call" && e.data.name === "oc_crear")).toBe(false);
  });

  test("confirmación abandonada seguida de otra solicitud distinta no se le aplica", async () => {
    const sessionId = `test-huerfana-otra-solicitud-${Date.now()}`;

    const cap1 = capturador();
    await procesarMensaje(
      crearLlmProcesarCaso("sol-004", "Hay una diferencia con la cotización (RC5). ¿Confirmás?"),
      DIRECTORY,
      sessionId,
      "procesa sol-004",
      cap1.emitir
    );
    expect(tieneEvento(cap1.eventos, "needs_confirmation")).toBe(true);

    // El usuario cambia a otra solicitud. Este turno responde en texto plano
    // sin volver a llamar oc_validar todavía (p. ej. una aclaración
    // intermedia) — es exactamente el caso donde, sin el fix, la
    // confirmación vieja de sol-004/RC5 quedaría pegada a esta respuesta
    // sobre sol-005.
    const cap2 = capturador();
    await procesarMensaje(
      crearLlmTextoSimple("Dale, dejame revisar sol-005."),
      DIRECTORY,
      sessionId,
      "en realidad procesá sol-005",
      cap2.emitir
    );
    const confirmacionReaparecida = cap2.eventos.find((e) => e.evento === "needs_confirmation");
    expect(confirmacionReaparecida).toBeUndefined();
  });

  test("un 'sí' huérfano no puede colarse como confirmado:true para el caso viejo (hallazgo real contra Gemini)", async () => {
    // Reproduce exactamente lo que pasó en vivo contra la API real: tras
    // abandonar la confirmación de sol-004 (cambiando de tema a sol-002), el
    // modelo — por su cuenta, sin volver a llamar oc_validar — intentó
    // igual oc_crear({caso:"sol-004", confirmado:true}) en reacción a un
    // "sí" suelto. Ese intento tiene que ser rechazado por el código, no
    // confiar en que el modelo nunca lo intente.
    const sessionId = `test-confirmado-cruzado-${Date.now()}`;
    await rm(`${DIRECTORY}/out/sol-004`, { recursive: true, force: true });
    // Sin esto, una OC de SOL-2026-004 ya creada en una corrida anterior
    // haría que buscarOrdenPorReferencia devuelva idempotente:true de
    // cualquier forma, enmascarando si el gate nuevo actuó o no.
    await rm(`${DIRECTORY}/out/sap`, { recursive: true, force: true });

    const cap1 = capturador();
    await procesarMensaje(
      crearLlmProcesarCasoCompleto("sol-004", "Hay una diferencia con la cotización (RC5). ¿Confirmás?"),
      DIRECTORY,
      sessionId,
      "procesa sol-004",
      cap1.emitir
    );
    expect(tieneEvento(cap1.eventos, "needs_confirmation")).toBe(true);
    // Confirma que el payload quedó realmente construido (si esto fuera
    // false, el test siguiente pasaría por la razón equivocada: el chequeo
    // preexistente de "falta oc_construir_payload", no el de esta prueba).
    expect(cap1.eventos.some((e) => e.evento === "tool_call" && e.data.name === "oc_construir_payload")).toBe(true);

    const cap2 = capturador();
    await procesarMensaje(
      crearLlmProcesarCaso("sol-002", "Bloqueo RC1, no puedo crear la orden."),
      DIRECTORY,
      sessionId,
      "procesa sol-002",
      cap2.emitir
    );
    expect(tieneEvento(cap2.eventos, "needs_confirmation")).toBe(false);

    // El modelo (mal) intenta confirmar sol-004 directamente, sin re-validar.
    const llmIntentaColarConfirmacionVieja: AdaptadorLLM = {
      async enviar() {
        return respuestaLlamada("call_crear_malicioso", "oc_crear", { caso: "sol-004", confirmado: true });
      },
    };
    const cap3 = capturador();
    await procesarMensaje(llmIntentaColarConfirmacionVieja, DIRECTORY, sessionId, "sí", cap3.emitir);

    const resultadoCrear = cap3.eventos.find((e) => e.evento === "tool_result" && e.data.id === "call_crear_malicioso");
    expect(resultadoCrear && resultadoCrear.evento === "tool_result" ? resultadoCrear.data.ok : undefined).toBe(false);
    const mensajeError =
      resultadoCrear && resultadoCrear.evento === "tool_result" ? (resultadoCrear.data.error ?? "") : "";
    expect(mensajeError).toContain("No hay una confirmación pendiente vigente");
    // Y, crucialmente: no debe haber quedado ninguna OC creada para sol-004.
    const huboCreacionReal = cap3.eventos.some(
      (e) => e.evento === "tool_result" && e.data.id === "call_crear_malicioso" && e.data.ok === true
    );
    expect(huboCreacionReal).toBe(false);
  });

  test("re-procesar el caso desde cero DENTRO del mismo turno no puede autoconfirmarse (hallazgo real contra Gemini)", async () => {
    // Esto pasó de verdad contra la API real: el modelo, al recibir "sí"
    // después de haber abandonado la confirmación, volvió a correr
    // leer→validar→evidencia→payload para sol-004 EN EL MISMO TURNO y, al
    // llegarle una confirmación "fresca", la dio por buena y creó la orden.
    // El gate de "caso vigente" (test anterior) no alcanza para esto porque
    // la revalidación SÍ deja casoConfirmacionPendiente en el caso correcto;
    // hace falta la segunda mitad de la garantía: ninguna confirmación puede
    // resolverse en el mismo turno en que nace.
    const sessionId = `test-mismo-turno-${Date.now()}`;
    await rm(`${DIRECTORY}/out/sol-004`, { recursive: true, force: true });
    await rm(`${DIRECTORY}/out/sap`, { recursive: true, force: true });

    const cap1 = capturador();
    await procesarMensaje(
      crearLlmProcesarCasoCompleto("sol-004", "Hay una diferencia con la cotización (RC5). ¿Confirmás?"),
      DIRECTORY,
      sessionId,
      "procesa sol-004",
      cap1.emitir
    );
    expect(tieneEvento(cap1.eventos, "needs_confirmation")).toBe(true);

    const cap2 = capturador();
    await procesarMensaje(
      crearLlmProcesarCaso("sol-002", "Bloqueo RC1, no puedo crear la orden."),
      DIRECTORY,
      sessionId,
      "procesa sol-002",
      cap2.emitir
    );
    expect(tieneEvento(cap2.eventos, "needs_confirmation")).toBe(false);

    const cap3 = capturador();
    await procesarMensaje(crearLlmReprocesaYConfirmaEnElMismoTurno("sol-004"), DIRECTORY, sessionId, "sí", cap3.emitir);

    const resultadoCrear = cap3.eventos.find((e) => e.evento === "tool_result" && e.data.id === "call_crear_mismo_turno");
    expect(resultadoCrear && resultadoCrear.evento === "tool_result" ? resultadoCrear.data.ok : undefined).toBe(false);
    const mensajeError =
      resultadoCrear && resultadoCrear.evento === "tool_result" ? (resultadoCrear.data.error ?? "") : "";
    expect(mensajeError).toContain("mismo turno");
  });

  test("'confirmo' sí continúa una confirmación pendiente real (control positivo)", async () => {
    await rm(`${DIRECTORY}/out/sol-004`, { recursive: true, force: true });
    const sessionId = `test-confirmo-real-${Date.now()}`;

    const cap1 = capturador();
    await procesarMensaje(
      crearLlmProcesarCaso("sol-004", "Hay una diferencia con la cotización (RC5). ¿Confirmás?"),
      DIRECTORY,
      sessionId,
      "procesa sol-004",
      cap1.emitir
    );
    expect(tieneEvento(cap1.eventos, "needs_confirmation")).toBe(true);

    const llmConfirmar: AdaptadorLLM = {
      async enviar(_system, mensajes) {
        if (!huboLlamadaA(mensajes, "oc_generar_evidencia")) {
          return respuestaLlamada("call_evidencia", "oc_generar_evidencia", { caso: "sol-004" });
        }
        if (!huboLlamadaA(mensajes, "oc_construir_payload")) {
          const paquete = resultadoDeHerramienta(mensajes, "oc_leer_paquete");
          const validacion = resultadoDeHerramienta(mensajes, "oc_validar") as { derivados: unknown };
          const evidencia = resultadoDeHerramienta(mensajes, "oc_generar_evidencia") as { sha256: string };
          return respuestaLlamada("call_payload", "oc_construir_payload", {
            caso: "sol-004",
            paquete,
            derivados: validacion.derivados,
            validacion: resultadoDeHerramienta(mensajes, "oc_validar"),
            evidencia_sha256: evidencia.sha256,
          });
        }
        if (!huboLlamadaA(mensajes, "oc_crear")) {
          const payloadResp = resultadoDeHerramienta(mensajes, "oc_construir_payload") as { payload: unknown };
          const validacion = resultadoDeHerramienta(mensajes, "oc_validar");
          return respuestaLlamada("call_crear", "oc_crear", {
            caso: "sol-004",
            payload: payloadResp.payload,
            validacion,
            confirmado: true,
          });
        }
        return respuestaTexto("Listo, la orden quedó creada.");
      },
    };

    const cap2 = capturador();
    await procesarMensaje(llmConfirmar, DIRECTORY, sessionId, "confirmo", cap2.emitir);

    expect(tieneEvento(cap2.eventos, "needs_confirmation")).toBe(false);
    const resultadoCrear = cap2.eventos.find((e) => e.evento === "tool_result" && e.data.id === "call_crear");
    expect(resultadoCrear && resultadoCrear.evento === "tool_result" && resultadoCrear.data.ok).toBe(true);
  });
});
