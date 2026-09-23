/**
 * Adaptador del proveedor de modelo (PRD §6.1): interfaz propia para que
 * `ciclo.ts` nunca sepa qué proveedor hay detrás. Cambiar de proveedor debe
 * tocar solo este archivo. La clave se lee de GEMINI_API_KEY (variable de
 * entorno) y nunca se loguea ni se incluye en un mensaje de error.
 *
 * Proveedor: Google Gemini (Generative Language API), function calling.
 * Modelo por defecto: `gemini-flash-lite-latest` — el alias oficial del nivel
 * "lite" (el más económico de la familia Gemini), verificado contra el
 * listado real de `/v1beta/models` con la clave configurada, no supuesto de
 * memoria. Configurable con GEMINI_MODEL si se prefiere fijar una versión
 * puntual en vez del alias "latest".
 */

import { z } from "zod";
import type { ResultadoHerramienta } from "../tipos";

export type LlamadaHerramienta = { id: string; nombre: string; args: unknown };

export type MensajeLLM =
  | { rol: "user"; texto: string }
  | { rol: "assistant"; texto: string | null; llamadas_herramienta: LlamadaHerramienta[] }
  | { rol: "tool"; id_llamada: string; nombre: string; contenido: string };

export type DescripcionHerramienta = {
  nombre: string;
  description: string;
  parametros: Record<string, z.ZodTypeAny>;
};

export type RespuestaLLM = {
  texto: string | null;
  llamadas_herramienta: LlamadaHerramienta[];
  tokens_entrada: number;
  tokens_salida: number;
};

export interface AdaptadorLLM {
  enviar(
    systemPrompt: string,
    mensajes: MensajeLLM[],
    herramientas: DescripcionHerramienta[]
  ): Promise<ResultadoHerramienta<RespuestaLLM>>;
}

// ─────────────────────────────────────────────────────────────
// Implementación Gemini (Generative Language API, sin SDK, con fetch nativo)
// ─────────────────────────────────────────────────────────────

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 30_000;
const MAX_TOKENS_RESPUESTA = 4096;
const MODELO_DEFAULT = "gemini-flash-lite-latest";

type ParteGemini =
  | { text: string }
  | { functionCall: { name: string; args: unknown }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { content: unknown } } };

type ContenidoGemini = { role: "user" | "model"; parts: ParteGemini[] };

type ParteRespuestaGemini = {
  text?: string;
  functionCall?: { name?: string; args?: unknown; id?: string };
  thoughtSignature?: string;
};

type RespuestaGeminiCruda = {
  candidates?: Array<{
    content?: { parts?: ParteRespuestaGemini[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

/**
 * Convierte el JSON Schema que produce `z.toJSONSchema` (draft 2020-12) al
 * subconjunto que acepta Gemini (parecido a OpenAPI 3.0), confirmado contra
 * la API real con los 6 schemas de `src/tools/oc.ts`:
 * - `additionalProperties` no existe como campo — Gemini lo rechaza (400).
 * - `type` tiene que ser un string, nunca un array: un `["string","null"]`
 *   (lo que zod genera para `.nullish()`) se convierte en `type: "string"` +
 *   `nullable: true`.
 * - `anyOf: [X, {type:"null"}]` (lo que zod genera para un objeto/array
 *   nullable) se colapsa a `X` + `nullable: true` — Gemini no soporta anyOf
 *   en `function_declarations[].parameters`.
 * - `const` (de `z.literal(...)`) no existe: se traduce a `enum` de un solo
 *   valor.
 * Recursivo: entra a `properties`, `items` y las ramas de `anyOf`.
 */
function limpiarSchemaGemini(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(limpiarSchemaGemini);
  if (nodo === null || typeof nodo !== "object") return nodo;
  const obj = nodo as Record<string, unknown>;

  if (Array.isArray(obj.anyOf)) {
    const ramas = obj.anyOf as Record<string, unknown>[];
    const ramaNull = ramas.find((r) => r.type === "null");
    const ramasReales = ramas.filter((r) => r.type !== "null");
    if (ramaNull && ramasReales.length === 1) {
      return { ...(limpiarSchemaGemini(ramasReales[0]) as Record<string, unknown>), nullable: true };
    }
    // Patrón no contemplado (anyOf con más de una rama real): nos quedamos
    // con la primera como aproximación razonable en vez de fallar.
    return limpiarSchemaGemini(ramasReales[0] ?? ramas[0]);
  }

  const limpio: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(obj)) {
    if (clave === "additionalProperties" || clave === "$schema") continue;
    if (clave === "type" && Array.isArray(valor)) {
      const tipos = valor as string[];
      limpio.type = tipos.find((t) => t !== "null") ?? tipos[0];
      if (tipos.includes("null")) limpio.nullable = true;
      continue;
    }
    if (clave === "const") {
      limpio.enum = [valor];
      continue;
    }
    limpio[clave] = limpiarSchemaGemini(valor);
  }
  return limpio;
}

export function crearAdaptadorLLM(): AdaptadorLLM {
  // Gemini exige recibir de vuelta, tal cual, un `thoughtSignature` opaco
  // cuando se reproduce en el historial una llamada a herramienta anterior
  // (si falta, la API responde 400 "missing thought_signature" — confirmado
  // contra la API real). La interfaz neutra `LlamadaHerramienta` no tiene un
  // campo para eso (y no hace falta agregarle uno): se cachea acá adentro,
  // indexado por el `id` único que Gemini ya genera para cada llamada. Es un
  // detalle 100% interno de este adaptador — `ciclo.ts` no cambia.
  const thoughtSignaturePorId = new Map<string, string>();

  function mensajesAContenidoGemini(mensajes: MensajeLLM[]): ContenidoGemini[] {
    const resultado: ContenidoGemini[] = [];
    for (const m of mensajes) {
      if (m.rol === "user") {
        resultado.push({ role: "user", parts: [{ text: m.texto }] });
        continue;
      }
      if (m.rol === "assistant") {
        const partes: ParteGemini[] = [];
        if (m.texto) partes.push({ text: m.texto });
        for (const llamada of m.llamadas_herramienta) {
          const parte: ParteGemini = { functionCall: { name: llamada.nombre, args: llamada.args } };
          const firma = thoughtSignaturePorId.get(llamada.id);
          if (firma) parte.thoughtSignature = firma;
          partes.push(parte);
        }
        resultado.push({ role: "model", parts: partes });
        continue;
      }
      // rol "tool": Gemini no tiene un rol "function" propio — confirmado
      // contra la API real, que rechaza ese rol con 400 ("Role 'function' is
      // not supported"). La respuesta de la herramienta viaja como mensaje
      // "user" con una parte `functionResponse`.
      let contenidoParseado: unknown;
      try {
        contenidoParseado = JSON.parse(m.contenido);
      } catch {
        contenidoParseado = m.contenido;
      }
      resultado.push({
        role: "user",
        parts: [{ functionResponse: { name: m.nombre, response: { content: contenidoParseado } } }],
      });
    }
    return resultado;
  }

  return {
    async enviar(systemPrompt, mensajes, herramientas) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return { ok: false, error: "GEMINI_API_KEY no está configurada en el entorno del backend." };
      }
      const modelo = process.env.GEMINI_MODEL || MODELO_DEFAULT;

      const function_declarations = herramientas.map((h) => ({
        name: h.nombre,
        description: h.description,
        parameters: limpiarSchemaGemini(z.toJSONSchema(z.object(h.parametros))),
      }));

      const cuerpo = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: mensajesAContenidoGemini(mensajes),
        tools: [{ function_declarations }],
        generationConfig: { maxOutputTokens: MAX_TOKENS_RESPUESTA },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(`${GEMINI_API_BASE}/${modelo}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify(cuerpo),
          signal: controller.signal,
        });
      } catch (err) {
        const esAbort = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          error: esAbort
            ? `El proveedor del modelo no respondió a tiempo (${TIMEOUT_MS} ms).`
            : "No se pudo contactar al proveedor del modelo.",
        };
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        let detalle = `HTTP ${res.status}`;
        try {
          const cuerpoError = (await res.json()) as { error?: { message?: string } };
          if (cuerpoError?.error?.message) detalle = cuerpoError.error.message;
        } catch {
          // Sin cuerpo JSON legible: nos quedamos con el detalle genérico ya asignado.
        }
        return { ok: false, error: `El proveedor del modelo respondió con un error: ${detalle}` };
      }

      let json: RespuestaGeminiCruda;
      try {
        json = (await res.json()) as RespuestaGeminiCruda;
      } catch {
        return { ok: false, error: "La respuesta del proveedor del modelo no es JSON válido." };
      }

      if (json.promptFeedback?.blockReason) {
        return {
          ok: false,
          error: `El proveedor del modelo bloqueó la respuesta (motivo: ${json.promptFeedback.blockReason}).`,
        };
      }

      const candidato = json.candidates?.[0];
      if (!candidato) {
        return { ok: false, error: "El proveedor del modelo no devolvió ningún candidato de respuesta." };
      }

      const partes = candidato.content?.parts ?? [];
      const llamadas_herramienta: LlamadaHerramienta[] = [];
      let texto: string | null = null;
      let contadorSinId = 0;

      for (const parte of partes) {
        if (typeof parte.text === "string") {
          texto = (texto ?? "") + parte.text;
          continue;
        }
        if (parte.functionCall && typeof parte.functionCall.name === "string") {
          const id = parte.functionCall.id ?? `gemini_${Date.now()}_${contadorSinId++}`;
          if (typeof parte.thoughtSignature === "string") {
            thoughtSignaturePorId.set(id, parte.thoughtSignature);
          }
          llamadas_herramienta.push({ id, nombre: parte.functionCall.name, args: parte.functionCall.args });
        }
      }

      return {
        ok: true,
        data: {
          texto,
          llamadas_herramienta,
          tokens_entrada: json.usageMetadata?.promptTokenCount ?? 0,
          tokens_salida: json.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}
