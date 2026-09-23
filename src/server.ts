/**
 * Servidor Bun (PRD §6.4): expone /api/chat (SSE), /api/sessions/:id y
 * /api/health, y sirve el front estático de web/. La clave del proveedor de
 * modelo vive solo en process.env y nunca sale de este proceso: no en
 * /api/health, no en logs, no en ningún evento SSE.
 */

import { crearAdaptadorLLM } from "./agente/llm";
import { procesarMensaje, obtenerHistorialSesion } from "./agente/ciclo";
import type { EventoCiclo } from "./agente/ciclo";

const DIRECTORIO = process.cwd();
const WEB_DIR = `${DIRECTORIO}/web`;
const PUERTO = Number(process.env.PORT) || 3000;
const MODELO_DEFAULT = "gemini-flash-lite-latest";

const llm = crearAdaptadorLLM();

function formatearEventoSSE(nombre: string, data: unknown): string {
  return `event: ${nombre}\ndata: ${JSON.stringify(data)}\n\n`;
}

function esCuerpoChatValido(cuerpo: unknown): cuerpo is { sessionId: string; message: string } {
  return (
    typeof cuerpo === "object" &&
    cuerpo !== null &&
    typeof (cuerpo as Record<string, unknown>).sessionId === "string" &&
    typeof (cuerpo as Record<string, unknown>).message === "string"
  );
}

async function manejarChat(req: Request): Promise<Response> {
  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    return Response.json({ ok: false, error: "El cuerpo de la petición no es JSON válido." }, { status: 400 });
  }

  if (!esCuerpoChatValido(cuerpo)) {
    return Response.json(
      { ok: false, error: 'Se esperaba { sessionId: string, message: string }.' },
      { status: 400 }
    );
  }
  const { sessionId, message } = cuerpo;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emitir = (evento: EventoCiclo) => {
        // "Mejor esfuerzo": si el cliente ya cortó la conexión, enqueue()
        // lanza. Eso nunca debe impedir que ciclo.ts termine de registrar el
        // turno en su propio historial (historialFrontend) ni en cascada
        // disparar el catch de más abajo — la sesión del servidor tiene que
        // quedar completa y consistente aunque nadie la esté mirando en ese
        // momento (CA5: un error de transporte no es un error del ciclo).
        try {
          controller.enqueue(encoder.encode(formatearEventoSSE(evento.evento, evento.data)));
        } catch {
          // conexión del cliente ya cerrada: no hay nada más que hacer acá.
        }
      };
      try {
        await procesarMensaje(llm, DIRECTORIO, sessionId, message, emitir);
      } catch (err) {
        // Defensa final: procesarMensaje no debería lanzar (CA5), pero si algo
        // se escapa igual se avisa dentro del stream en vez de cortar en seco.
        const mensaje = err instanceof Error ? err.message : "Error inesperado en el ciclo del agente.";
        emitir({ evento: "error", data: { message: mensaje, recoverable: false } });
      } finally {
        try {
          controller.close();
        } catch {
          // ya estaba cerrado por el lado del cliente: no es un error nuestro.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function manejarSesion(sessionId: string): Response {
  const mensajes = obtenerHistorialSesion(sessionId);
  if (!mensajes) {
    return Response.json({ ok: false, error: "sesión no encontrada" }, { status: 404 });
  }
  return Response.json({ ok: true, sessionId, mensajes });
}

function manejarHealth(): Response {
  return Response.json({ ok: true, provider: "google", model: process.env.GEMINI_MODEL || MODELO_DEFAULT });
}

async function servirEstatico(pathname: string): Promise<Response> {
  const rutaRelativa = pathname === "/" ? "/index.html" : pathname;
  if (rutaRelativa.includes("..")) {
    return new Response("No encontrado", { status: 404 });
  }
  const archivo = Bun.file(`${WEB_DIR}${rutaRelativa}`);
  if (!(await archivo.exists())) {
    return new Response("No encontrado", { status: 404 });
  }
  return new Response(archivo);
}

Bun.serve({
  port: PUERTO,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/api/chat") {
      return manejarChat(req);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      return manejarSesion(sessionId);
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return manejarHealth();
    }
    if (req.method === "GET") {
      return servirEstatico(url.pathname);
    }
    return new Response("Método no soportado", { status: 405 });
  },
});

console.log(`Servidor escuchando en http://localhost:${PUERTO}`);
