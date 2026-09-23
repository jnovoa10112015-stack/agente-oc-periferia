/**
 * El ciclo del agente (PRD §6.3): mensaje → decidir herramienta → ejecutar →
 * observar → responder. Tope de iteraciones configurable por variable de
 * entorno (`MAX_ITERACIONES`, 8 por defecto — CLAUDE.md; no las 25 genéricas
 * del PRD — ver SOLUCION.md §3). El modelo nunca evalúa RC1–RC10: esas
 * comparaciones ya vienen resueltas en lo que devuelve oc_validar, este
 * archivo solo transporta ese resultado.
 *
 * Estado en el servidor, no en el modelo (SOLUCION.md §8): `oc_validar`,
 * `oc_generar_evidencia`, `oc_construir_payload` y `oc_crear` NO le piden al
 * modelo que le pase de vuelta el `paquete`/`validacion`/`payload` completos
 * como argumento — este archivo los guarda por sesión, indexados por `caso`,
 * apenas los produce la herramienta anterior, y los inyecta él mismo antes de
 * ejecutar. El modelo solo decide `caso` (y, en `oc_crear`, `confirmado`). El
 * contrato de cada herramienta en `src/tools/oc.ts` (su `args`/`execute`) NO
 * cambia: sigue recibiendo exactamente lo que el PRD §6.2 documenta; lo único
 * que cambia es quién le arma esos argumentos.
 */

import { readFileSync } from "node:fs";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AdaptadorLLM, DescripcionHerramienta, MensajeLLM } from "./llm";
import * as herramientasOc from "../tools/oc";
import type { Paquete, Validacion, OrdenCompra } from "../tipos";

const TOPE_ITERACIONES_DEFAULT = 8;
// El ciclo reenvía el historial completo de la sesión en cada llamada al
// modelo (no lo poda ni lo resume), así que una sesión larga con varios casos
// acumula contexto rápido. 200_000 tokens / USD 1 eran valores de arranque
// nunca validados contra ese patrón real de crecimiento; en una prueba en
// vivo de 5+ turnos se agotaron sin haber gastado ni cerca de USD 1 real. Con
// el precio real de gemini-flash-lite-latest (ver más abajo), estos nuevos
// valores siguen siendo un tope finito y significativo — no "sin límite" —
// dimensionado para una sesión de uso normal de este proyecto (procesar los
// 6 casos de fixtures/ con confirmaciones), no para tráfico arbitrario.
const MAX_TOKENS_POR_SESION_DEFAULT = 2_000_000;
const MAX_COSTO_USD_POR_SESION_DEFAULT = 5;
// Estimación simple y conservadora del costo real de gemini-flash-lite-latest
// (proveedor vigente desde la Tarea 2, ~USD 0.10/MTok entrada, ~USD 0.40/MTok
// salida — verificar contra la tabla de precios vigente de Google, no es una
// factura real). Antes de la Tarea 2 este archivo usaba las tarifas de
// Anthropic Sonnet (~15-37x más caras) y nunca se actualizaron al cambiar de
// proveedor: eso hacía que el tope de USD por defecto se agotara con sesiones
// largas mucho antes de gastar $1 real. No hace falta más precisión que esto
// para el control de tope.
const USD_POR_TOKEN_ENTRADA = 0.1 / 1_000_000;
const USD_POR_TOKEN_SALIDA = 0.4 / 1_000_000;

type Ctx = { directory: string; sessionId: string };

type ResultadoHerramientaCrudo = { ok: boolean; data?: unknown; error?: string; codigo?: string };

function parsearResultadoHerramienta(resultadoStr: string): ResultadoHerramientaCrudo {
  try {
    const parseado = JSON.parse(resultadoStr) as unknown;
    if (parseado && typeof parseado === "object" && "ok" in parseado) {
      return parseado as ResultadoHerramientaCrudo;
    }
    return { ok: false, error: "La herramienta devolvió una forma inesperada." };
  } catch {
    return { ok: false, error: "La herramienta devolvió un JSON inválido." };
  }
}

function errorResultado(mensaje: string): { resultadoStr: string; resultado: ResultadoHerramientaCrudo } {
  const resultado: ResultadoHerramientaCrudo = { ok: false, error: mensaje };
  return { resultadoStr: JSON.stringify(resultado), resultado };
}

function errorDeArgumentos(nombreHerramienta: string, error: z.ZodError): { resultadoStr: string; resultado: ResultadoHerramientaCrudo } {
  const detalle = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(raíz)"}: ${issue.message}`)
    .join("; ");
  return errorResultado(`Argumentos inválidos para ${nombreHerramienta}: ${detalle}`);
}

/** Le dice al modelo, en lenguaje claro, qué herramienta le falta llamar antes para este caso — nunca lo resuelve en silencio por su cuenta. */
function errorFaltaPaso(nombreHerramienta: string, caso: string, pasoFaltante: string): { resultadoStr: string; resultado: ResultadoHerramientaCrudo } {
  return errorResultado(
    `No se puede ejecutar ${nombreHerramienta} para "${caso}" todavía: falta llamar primero a ${pasoFaltante} en esta sesión para ese caso.`
  );
}

// ─────────────────────────────────────────────────────────────
// Esquemas de argumentos que ve el MODELO (reducidos): solo lo que es
// genuinamente una decisión suya. `caso` identifica de cuál de los estados
// que ya tiene esta sesión hay que partir; el resto (paquete, validación,
// evidencia, payload) lo carga este archivo desde su propia caché, nunca el
// modelo. Distinto del `args` de cada herramienta en `src/tools/oc.ts`
// (ese es el contrato real de `execute()`, sin cambios).
// ─────────────────────────────────────────────────────────────

const argsModeloCaso = {
  caso: z.string().describe("Nombre del caso (ej. \"sol-001\"), ya leído previamente en esta sesión con oc_leer_paquete."),
};

const argsModeloCrear = {
  caso: z.string().describe("Nombre del caso, ya validado y con el payload ya construido en esta sesión."),
  confirmado: z
    .boolean()
    .optional()
    .describe("true si el humano confirmó explícitamente, en este turno o antes, las excepciones pendientes de este caso."),
};

const DESCRIPCIONES_HERRAMIENTAS: DescripcionHerramienta[] = [
  { nombre: "oc_leer_paquete", description: herramientasOc.leer_paquete.description, parametros: herramientasOc.leer_paquete.args },
  { nombre: "oc_validar", description: herramientasOc.validar.description, parametros: argsModeloCaso },
  { nombre: "oc_generar_evidencia", description: herramientasOc.generar_evidencia.description, parametros: herramientasOc.generar_evidencia.args },
  { nombre: "oc_construir_payload", description: herramientasOc.construir_payload.description, parametros: argsModeloCaso },
  { nombre: "oc_crear", description: herramientasOc.crear.description, parametros: argsModeloCrear },
  { nombre: "oc_leer_excel", description: herramientasOc.leer_excel.description, parametros: herramientasOc.leer_excel.args },
];

// ─────────────────────────────────────────────────────────────
// Eventos emitidos al front (forma exacta según web/CONTRATO.md)
// ─────────────────────────────────────────────────────────────

export type EventoCiclo =
  | { evento: "message"; data: { text: string; final: boolean } }
  | { evento: "tool_call"; data: { id: string; name: string; args: unknown } }
  | { evento: "tool_result"; data: { id: string; ok: boolean; data?: unknown; error?: string; codigo?: string } }
  | { evento: "needs_confirmation"; data: { pregunta: string; hallazgos: unknown } }
  | { evento: "error"; data: { message: string; recoverable: boolean } }
  | { evento: "done"; data: { needsConfirmation: boolean } };

export type EmisorEvento = (evento: EventoCiclo) => void;

// ─────────────────────────────────────────────────────────────
// Historial "para el front" — misma forma que piden los items de
// GET /api/sessions/:id en web/CONTRATO.md §4.
// ─────────────────────────────────────────────────────────────

export type ItemHistorialFrontend =
  | { type: "user_message"; text: string; ts: string }
  | { type: "message"; text: string; ts: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; ts: string }
  | { type: "tool_result"; id: string; ok: boolean; data?: unknown; error?: string; codigo?: string; ts: string }
  | { type: "needs_confirmation"; pregunta: string; hallazgos: unknown; ts: string }
  | { type: "error"; message: string; ts: string };

/** Estado real de un caso dentro de una sesión: lo que antes se le pedía al modelo que reproduzca de memoria. */
type EstadoCaso = {
  paquete: Paquete | null;
  validacion: Validacion | null;
  evidenciaSha256: string | null;
  payload: OrdenCompra | null;
};

function estadoCasoVacio(): EstadoCaso {
  return { paquete: null, validacion: null, evidenciaSha256: null, payload: null };
}

type SesionAgente = {
  mensajesLlm: MensajeLLM[];
  historialFrontend: ItemHistorialFrontend[];
  tokensAcumulados: number;
  costoAcumuladoUsd: number;
  ultimaValidacion: Validacion | null;
  /** El `caso` de la última `oc_validar` exitosa de la sesión — a qué caso se
   *  le puede aplicar un `confirmado: true` sin que sea una confirmación de
   *  arrastre para un caso distinto. Se invalida con la misma regla que
   *  `ultimaValidacion` (ver el bloque al principio de `procesarMensaje`). */
  casoConfirmacionPendiente: string | null;
  estadosPorCaso: Map<string, EstadoCaso>;
};

const sesiones = new Map<string, SesionAgente>();

function obtenerOCrearSesion(sessionId: string): SesionAgente {
  let sesion = sesiones.get(sessionId);
  if (!sesion) {
    sesion = {
      mensajesLlm: [],
      historialFrontend: [],
      tokensAcumulados: 0,
      costoAcumuladoUsd: 0,
      ultimaValidacion: null,
      casoConfirmacionPendiente: null,
      estadosPorCaso: new Map(),
    };
    sesiones.set(sessionId, sesion);
  }
  return sesion;
}

function obtenerEstadoCaso(sesion: SesionAgente, caso: string): EstadoCaso {
  let estado = sesion.estadosPorCaso.get(caso);
  if (!estado) {
    estado = estadoCasoVacio();
    sesion.estadosPorCaso.set(caso, estado);
  }
  return estado;
}

/** `server.ts` la usa para `GET /api/sessions/:id`. `null` = sesión no conocida (404). */
export function obtenerHistorialSesion(sessionId: string): ItemHistorialFrontend[] | null {
  const sesion = sesiones.get(sessionId);
  return sesion ? sesion.historialFrontend : null;
}

let systemPromptCache: string | null = null;
/** Nunca lanza: una falla leyendo prompt.md se devuelve como error, no como excepción. */
function cargarSystemPrompt(directory: string): { ok: true; texto: string } | { ok: false; error: string } {
  if (systemPromptCache !== null) return { ok: true, texto: systemPromptCache };
  const ruta = path.join(directory, "src", "agente", "prompt.md");
  try {
    systemPromptCache = readFileSync(ruta, "utf-8");
    return { ok: true, texto: systemPromptCache };
  } catch (e) {
    return { ok: false, error: `No se pudo leer el system prompt (${ruta}): ${e instanceof Error ? e.message : String(e)}` };
  }
}

function ahora(): string {
  return new Date().toISOString();
}

/**
 * Anexa una línea a `out/log.jsonl`: un registro por cada llamada a
 * herramienta (SOLUCION.md §3). Es un log de auditoría, no el registro
 * transaccional (ése es `out/sap/ordenes.jsonl`), así que si falla la
 * escritura no interrumpe el turno — solo se deja constancia en stderr.
 */
async function registrarLog(directory: string, entrada: Record<string, unknown>): Promise<void> {
  try {
    const carpetaOut = path.join(directory, "out");
    await mkdir(carpetaOut, { recursive: true });
    await appendFile(path.join(carpetaOut, "log.jsonl"), `${JSON.stringify(entrada)}\n`, "utf-8");
  } catch (e) {
    console.error(`[ciclo] No se pudo escribir out/log.jsonl: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function leerTope(nombreVar: string, porDefecto: number): number {
  const valor = process.env[nombreVar];
  if (!valor) return porDefecto;
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : porDefecto;
}

// ─────────────────────────────────────────────────────────────
// Despacho de herramientas: valida el esquema REDUCIDO que ve el modelo,
// completa desde la caché de la sesión lo que la herramienta real necesita, y
// llama a su `execute()` sin cambiarle el contrato. Si falta un paso previo
// para ese caso, no se resuelve solo: se lo dice al modelo.
// ─────────────────────────────────────────────────────────────

type ResultadoDespacho = { resultadoStr: string; resultado: ResultadoHerramientaCrudo; ocCrearExitoso: boolean };

async function despacharHerramienta(
  nombreHerramienta: string,
  argsModelo: unknown,
  sesion: SesionAgente,
  ctx: Ctx,
  casosValidadosEnEsteTurno: Set<string>
): Promise<ResultadoDespacho> {
  switch (nombreHerramienta) {
    case "oc_leer_paquete": {
      const parseado = z.object(herramientasOc.leer_paquete.args).safeParse(argsModelo);
      if (!parseado.success) return { ...errorDeArgumentos(nombreHerramienta, parseado.error), ocCrearExitoso: false };
      const resultadoStr = await herramientasOc.leer_paquete.execute(parseado.data, ctx);
      const resultado = parsearResultadoHerramienta(resultadoStr);
      if (resultado.ok) {
        obtenerEstadoCaso(sesion, parseado.data.caso).paquete = resultado.data as Paquete;
      }
      return { resultadoStr, resultado, ocCrearExitoso: false };
    }

    case "oc_validar": {
      const parseado = z.object(argsModeloCaso).safeParse(argsModelo);
      if (!parseado.success) return { ...errorDeArgumentos(nombreHerramienta, parseado.error), ocCrearExitoso: false };
      const estado = obtenerEstadoCaso(sesion, parseado.data.caso);
      if (!estado.paquete) {
        return { ...errorFaltaPaso(nombreHerramienta, parseado.data.caso, "oc_leer_paquete"), ocCrearExitoso: false };
      }
      const resultadoStr = await herramientasOc.validar.execute({ caso: parseado.data.caso, paquete: estado.paquete }, ctx);
      const resultado = parsearResultadoHerramienta(resultadoStr);
      if (resultado.ok) {
        estado.validacion = resultado.data as Validacion;
        sesion.ultimaValidacion = estado.validacion;
        sesion.casoConfirmacionPendiente = parseado.data.caso;
        // Marca que la validación vigente de este caso se produjo EN ESTE
        // TURNO. Es la mitad de la garantía "el modelo no puede darse por
        // respondido a sí mismo": si vuelve a validar el caso desde cero y
        // acá mismo intenta confirmar, el gate de oc_crear (más abajo) lo
        // corta igual, aunque el caso coincida.
        casosValidadosEnEsteTurno.add(parseado.data.caso);
      }
      return { resultadoStr, resultado, ocCrearExitoso: false };
    }

    case "oc_generar_evidencia": {
      const parseado = z.object(herramientasOc.generar_evidencia.args).safeParse(argsModelo);
      if (!parseado.success) return { ...errorDeArgumentos(nombreHerramienta, parseado.error), ocCrearExitoso: false };
      const resultadoStr = await herramientasOc.generar_evidencia.execute(parseado.data, ctx);
      const resultado = parsearResultadoHerramienta(resultadoStr);
      if (resultado.ok) {
        obtenerEstadoCaso(sesion, parseado.data.caso).evidenciaSha256 = (resultado.data as { sha256: string }).sha256;
      }
      return { resultadoStr, resultado, ocCrearExitoso: false };
    }

    case "oc_construir_payload": {
      const parseado = z.object(argsModeloCaso).safeParse(argsModelo);
      if (!parseado.success) return { ...errorDeArgumentos(nombreHerramienta, parseado.error), ocCrearExitoso: false };
      const estado = obtenerEstadoCaso(sesion, parseado.data.caso);
      if (!estado.paquete) {
        return { ...errorFaltaPaso(nombreHerramienta, parseado.data.caso, "oc_leer_paquete"), ocCrearExitoso: false };
      }
      if (!estado.validacion) {
        return { ...errorFaltaPaso(nombreHerramienta, parseado.data.caso, "oc_validar"), ocCrearExitoso: false };
      }
      const resultadoStr = await herramientasOc.construir_payload.execute(
        {
          caso: parseado.data.caso,
          paquete: estado.paquete,
          derivados: estado.validacion.derivados,
          validacion: estado.validacion,
          evidencia_sha256: estado.evidenciaSha256 ?? undefined,
        },
        ctx
      );
      const resultado = parsearResultadoHerramienta(resultadoStr);
      if (resultado.ok) {
        estado.payload = (resultado.data as { payload: OrdenCompra }).payload;
      }
      return { resultadoStr, resultado, ocCrearExitoso: false };
    }

    case "oc_crear": {
      const parseado = z.object(argsModeloCrear).safeParse(argsModelo);
      if (!parseado.success) return { ...errorDeArgumentos(nombreHerramienta, parseado.error), ocCrearExitoso: false };
      const estado = obtenerEstadoCaso(sesion, parseado.data.caso);
      if (!estado.payload || !estado.validacion) {
        return { ...errorFaltaPaso(nombreHerramienta, parseado.data.caso, "oc_construir_payload"), ocCrearExitoso: false };
      }
      // Un `confirmado: true` solo vale para el caso que efectivamente tiene
      // una confirmación pendiente VIGENTE en esta sesión — nunca "de
      // arrastre" para un caso distinto solo porque el modelo lo recuerda de
      // más atrás en la conversación. Si el usuario abandonó la pregunta
      // (cambió de tema, preguntó por otro caso) el turno siguiente ya limpió
      // `casoConfirmacionPendiente`; un "sí" posterior no puede reactivarlo.
      // Esto es un control de sesión, no una regla de negocio RC1-10 — lo
      // decide el código, no el modelo, por la misma razón que el resto.
      if (estado.validacion.confirmaciones.length > 0 && parseado.data.confirmado === true) {
        if (sesion.casoConfirmacionPendiente !== parseado.data.caso) {
          return {
            ...errorResultado(
              `No hay una confirmación pendiente vigente para "${parseado.data.caso}" en esta sesión ` +
                `(la última pregunta de confirmación fue sobre ${sesion.casoConfirmacionPendiente ?? "ningún caso"}). ` +
                `Volvé a llamar a oc_validar para "${parseado.data.caso}" y replanteá la confirmación desde cero antes de crear.`
            ),
            ocCrearExitoso: false,
          };
        }
        // Segunda mitad de la garantía: una confirmación solo es válida si
        // llega como respuesta en un turno DISTINTO (posterior) a aquel en
        // que se planteó. Si el caso se (re)validó en ESTE MISMO turno —
        // aunque el caso coincida y "confirmado" venga en true — el modelo
        // se estaría dando por respondido a sí mismo dentro del mismo turno,
        // que es exactamente lo que esta regla prohíbe. Tiene que terminar
        // el turno con la pregunta y esperar el mensaje siguiente del humano.
        if (casosValidadosEnEsteTurno.has(parseado.data.caso)) {
          return {
            ...errorResultado(
              `La validación de "${parseado.data.caso}" que generó esta confirmación es de este mismo turno. ` +
                `Una confirmación solo es válida si llega en un turno posterior a aquel en que se planteó — ` +
                `no podés confirmar y crear en el mismo turno en que se (re)plantea la pregunta. ` +
                `Terminá esta respuesta pidiéndole al usuario que confirme explícitamente en su próximo mensaje; ` +
                `no vuelvas a intentar oc_crear en este turno.`
            ),
            ocCrearExitoso: false,
          };
        }
      }
      // `validacion` NO se pasa: oc_crear la re-deriva ella misma desde el
      // caso (Tarea 2 de la auditoría) — la garantía vive en la herramienta,
      // no en este despacho.
      const resultadoStr = await herramientasOc.crear.execute(
        { caso: parseado.data.caso, payload: estado.payload, confirmado: parseado.data.confirmado },
        ctx
      );
      const resultado = parsearResultadoHerramienta(resultadoStr);
      if (resultado.ok) {
        sesion.ultimaValidacion = null;
        sesion.casoConfirmacionPendiente = null;
      }
      return { resultadoStr, resultado, ocCrearExitoso: resultado.ok };
    }

    case "oc_leer_excel": {
      const parseado = z.object(herramientasOc.leer_excel.args).safeParse(argsModelo);
      if (!parseado.success) return { ...errorDeArgumentos(nombreHerramienta, parseado.error), ocCrearExitoso: false };
      const resultadoStr = await herramientasOc.leer_excel.execute(parseado.data, ctx);
      return { resultadoStr, resultado: parsearResultadoHerramienta(resultadoStr), ocCrearExitoso: false };
    }

    default:
      return { ...errorResultado(`Herramienta desconocida: "${nombreHerramienta}".`), ocCrearExitoso: false };
  }
}

/**
 * Procesa un mensaje de usuario para una sesión dada, emitiendo eventos a
 * medida que ocurren (nunca bufferiza el turno completo). Nunca lanza: un
 * error del adaptador LLM o de una herramienta se traduce a un evento y la
 * sesión queda disponible para el próximo mensaje (CA5).
 */
export async function procesarMensaje(
  llm: AdaptadorLLM,
  directory: string,
  sessionId: string,
  mensajeUsuario: string,
  emitir: EmisorEvento
): Promise<void> {
  const sesion = obtenerOCrearSesion(sessionId);
  const ctx: Ctx = { directory, sessionId };
  // Turno-local: qué casos se (re)validaron durante ESTE turno. Ver el gate
  // de oc_crear en despacharHerramienta — nunca persiste entre turnos.
  const casosValidadosEnEsteTurno = new Set<string>();

  // Invalidar una confirmación pendiente huérfana: la única respuesta que
  // continúa esa confirmación es el literal "confirmo" que manda el botón
  // dedicado del front (web/CONTRATO.md §2.4: "cancelo" también, cualquier
  // otro texto no es una respuesta a la pregunta). Cualquier otro mensaje —
  // un tema distinto, otra solicitud, o un "sí" suelto tipeado a mano en vez
  // de tocar el botón — abandona la confirmación anterior antes de que este
  // turno arranque. Si el usuario "confirma" después de eso, no hay nada que
  // aceptar: el agente tiene que volver a plantear la pregunta desde cero
  // (nunca asumir una confirmación vieja para un caso que ya no está en foco).
  if (sesion.ultimaValidacion !== null && mensajeUsuario.trim().toLowerCase() !== "confirmo") {
    sesion.ultimaValidacion = null;
    sesion.casoConfirmacionPendiente = null;
  }

  sesion.mensajesLlm.push({ rol: "user", texto: mensajeUsuario });
  sesion.historialFrontend.push({ type: "user_message", text: mensajeUsuario, ts: ahora() });

  const topeTokens = leerTope("MAX_TOKENS_POR_SESION", MAX_TOKENS_POR_SESION_DEFAULT);
  const topeCostoUsd = leerTope("MAX_COSTO_USD_POR_SESION", MAX_COSTO_USD_POR_SESION_DEFAULT);
  const topeIteraciones = leerTope("MAX_ITERACIONES", TOPE_ITERACIONES_DEFAULT);

  console.log(
    `[ciclo] sesión ${sessionId}: tokens acumulados=${sesion.tokensAcumulados}/${topeTokens}, costo acumulado=$${sesion.costoAcumuladoUsd.toFixed(4)}/$${topeCostoUsd}`
  );
  if (sesion.tokensAcumulados >= topeTokens || sesion.costoAcumuladoUsd >= topeCostoUsd) {
    const mensaje =
      "Se alcanzó el tope de costo o de tokens configurado para esta sesión. No puedo seguir procesando en esta sesión.";
    emitir({ evento: "error", data: { message: mensaje, recoverable: false } });
    sesion.historialFrontend.push({ type: "error", message: mensaje, ts: ahora() });
    return;
  }

  const promptCargado = cargarSystemPrompt(directory);
  if (!promptCargado.ok) {
    emitir({ evento: "error", data: { message: promptCargado.error, recoverable: false } });
    sesion.historialFrontend.push({ type: "error", message: promptCargado.error, ts: ahora() });
    return;
  }
  const systemPrompt = promptCargado.texto;
  let seEjecutoOcCrearConExito = false;

  for (let iteracion = 0; iteracion < topeIteraciones; iteracion++) {
    console.log(`[ciclo] sesión ${sessionId}: iteración ${iteracion + 1}/${topeIteraciones}`);
    const respuesta = await llm.enviar(systemPrompt, sesion.mensajesLlm, DESCRIPCIONES_HERRAMIENTAS);

    if (!respuesta.ok) {
      emitir({ evento: "error", data: { message: respuesta.error, recoverable: true } });
      sesion.historialFrontend.push({ type: "error", message: respuesta.error, ts: ahora() });
      emitir({ evento: "done", data: { needsConfirmation: false } });
      return;
    }

    const { texto, llamadas_herramienta, tokens_entrada, tokens_salida } = respuesta.data;
    sesion.tokensAcumulados += tokens_entrada + tokens_salida;
    sesion.costoAcumuladoUsd += tokens_entrada * USD_POR_TOKEN_ENTRADA + tokens_salida * USD_POR_TOKEN_SALIDA;
    sesion.mensajesLlm.push({ rol: "assistant", texto, llamadas_herramienta });

    if (llamadas_herramienta.length === 0) {
      const textoFinal = texto ?? "";
      const debeConfirmar =
        !seEjecutoOcCrearConExito &&
        sesion.ultimaValidacion !== null &&
        sesion.ultimaValidacion.confirmaciones.length > 0;

      if (debeConfirmar && sesion.ultimaValidacion) {
        const hallazgos = {
          confirmaciones: sesion.ultimaValidacion.confirmaciones,
          derivados: sesion.ultimaValidacion.derivados,
          retroactiva: sesion.ultimaValidacion.retroactiva,
        };
        emitir({ evento: "needs_confirmation", data: { pregunta: textoFinal, hallazgos } });
        sesion.historialFrontend.push({ type: "needs_confirmation", pregunta: textoFinal, hallazgos, ts: ahora() });
      } else {
        emitir({ evento: "message", data: { text: textoFinal, final: true } });
        sesion.historialFrontend.push({ type: "message", text: textoFinal, ts: ahora() });
      }

      emitir({ evento: "done", data: { needsConfirmation: debeConfirmar } });
      return;
    }

    // Texto parcial antes de pedir herramientas (poco común, pero el
    // contrato SSE lo permite como burbuja de mensaje intermedia).
    if (texto) {
      emitir({ evento: "message", data: { text: texto, final: true } });
      sesion.historialFrontend.push({ type: "message", text: texto, ts: ahora() });
    }

    for (const llamada of llamadas_herramienta) {
      const nombreHerramienta = llamada.nombre;

      emitir({ evento: "tool_call", data: { id: llamada.id, name: nombreHerramienta, args: llamada.args } });
      sesion.historialFrontend.push({
        type: "tool_call",
        id: llamada.id,
        name: nombreHerramienta,
        args: llamada.args,
        ts: ahora(),
      });

      const despacho = await despacharHerramienta(nombreHerramienta, llamada.args, sesion, ctx, casosValidadosEnEsteTurno);
      if (despacho.ocCrearExitoso) seEjecutoOcCrearConExito = true;

      await registrarLog(directory, {
        ts: ahora(),
        sessionId,
        herramienta: nombreHerramienta,
        args: llamada.args,
        resultado: despacho.resultado,
      });

      sesion.mensajesLlm.push({
        rol: "tool",
        id_llamada: llamada.id,
        nombre: nombreHerramienta,
        contenido: despacho.resultadoStr,
      });
      emitir({ evento: "tool_result", data: { id: llamada.id, ...despacho.resultado } });
      sesion.historialFrontend.push({ type: "tool_result", id: llamada.id, ...despacho.resultado, ts: ahora() });
    }
  }

  // Tope de iteraciones alcanzado sin terminar (CLAUDE.md): se corta, se dice
  // explícitamente, no se reintenta en bucle.
  const mensajeTope =
    `Llegué al tope de iteraciones (${topeIteraciones}) sin terminar de procesar el caso. Puedo seguir si me pedís que continúe.`;
  emitir({ evento: "message", data: { text: mensajeTope, final: true } });
  sesion.historialFrontend.push({ type: "message", text: mensajeTope, ts: ahora() });
  emitir({ evento: "done", data: { needsConfirmation: false } });
}
