/**
 * Implementación simulada de SapAdapter sobre archivos en out/sap/.
 *
 * Todas las rutas se resuelven desde `directory` (raíz del proyecto), nunca
 * absolutas. Cada método de la interfaz SapAdapter nunca lanza: una falla de
 * I/O o un JSON corrupto se trata como el caso más seguro posible para cada
 * método (ver comentarios puntuales), nunca como una excepción que suba
 * hasta `src/tools/oc.ts` — esa es la capa que la auditoría externa marcó
 * como incumplida y que este archivo tiene que sostener.
 *
 * Concurrencia: `crearOrden` y `buscarOrdenPorReferencia` comparten una sola
 * cola de promesas (`conMutex`) para que dos llamadas simultáneas nunca lean
 * y escriban `ordenes.jsonl` entrelazadas. Además, `crearOrden` es
 * idempotente por sí misma (no solo por el chequeo previo que hace
 * `src/tools/oc.ts`): si dos pedidos concurrentes para el mismo
 * `solicitud_id` llegan igual a `crearOrden`, la segunda encuentra la
 * primera dentro de la misma sección crítica y devuelve esa, nunca crea un
 * número duplicado.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProveedorSchema, type OrdenCompra, type SapAdapter } from "../tipos";

type RegistroOrdenAlmacenado = {
  numero_oc: string;
  fecha: string;
  solicitud_id: string;
  orden: OrdenCompra;
};

const PRIMER_NUMERO_OC = 4500000001;

function normalizarNit(nit: string): string {
  return nit.replace(/[^\d]/g, "");
}

function esArchivoInexistente(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Parsea una línea de `ordenes.jsonl` de forma segura: una línea corrupta
 * (JSON inválido, o `numero_oc` que no es un número) se descarta en vez de
 * tirar la lectura completa abajo. No se puede reconstruir un registro
 * dañado sin inventar datos, así que la única opción segura es ignorarlo.
 */
function parsearLineaOrdenSegura(linea: string): RegistroOrdenAlmacenado | null {
  try {
    const registro = JSON.parse(linea) as RegistroOrdenAlmacenado;
    if (
      typeof registro?.numero_oc !== "string" ||
      typeof registro?.solicitud_id !== "string" ||
      !Number.isFinite(Number(registro.numero_oc))
    ) {
      return null;
    }
    return registro;
  } catch {
    return null;
  }
}

/**
 * Crea un SapAdapter simulado cuyo estado vive en `${directory}/out/sap/`.
 */
export function crearSapMock(directory: string): SapAdapter {
  const rutaProveedores = path.join(
    directory,
    "fixtures",
    "reto-03",
    "maestros",
    "proveedores.json"
  );
  const dirSap = path.join(directory, "out", "sap");
  const rutaOrdenes = path.join(dirSap, "ordenes.jsonl");

  // Mutex a nivel de módulo: serializa toda lectura+escritura de
  // ordenes.jsonl entre llamadas concurrentes a crearOrden/buscarOrdenPorReferencia
  // de esta misma instancia (una por `directory`, cacheada en oc.ts).
  let cola: Promise<unknown> = Promise.resolve();
  function conMutex<T>(tarea: () => Promise<T>): Promise<T> {
    const resultado = cola.then(tarea, tarea);
    // Si `tarea` rechaza, la cola tiene que seguir viva para la próxima
    // llamada — de lo contrario un solo fallo dejaría la cola envenenada.
    cola = resultado.then(
      () => undefined,
      () => undefined
    );
    return resultado;
  }

  // Devuelve los registros válidos de ordenes.jsonl, o [] si el archivo
  // todavía no existe (primer uso: no es un error, es "sin órdenes aún").
  // Nunca lanza: una falla de lectura real (no "no existe") se trata igual
  // que "sin órdenes" — es la opción más segura dado que SapAdapter no tiene
  // una variante de error en su interfaz para este dato.
  async function leerRegistrosOrdenes(): Promise<RegistroOrdenAlmacenado[]> {
    let contenido: string;
    try {
      contenido = await readFile(rutaOrdenes, "utf-8");
    } catch (err) {
      if (esArchivoInexistente(err)) return [];
      return [];
    }
    return contenido
      .split("\n")
      .filter((linea) => linea.trim().length > 0)
      .map(parsearLineaOrdenSegura)
      .filter((registro): registro is RegistroOrdenAlmacenado => registro !== null);
  }

  return {
    async consultarProveedor(nit) {
      try {
        const contenido = await readFile(rutaProveedores, "utf-8");
        const proveedores = z.array(ProveedorSchema).parse(JSON.parse(contenido));
        const buscado = normalizarNit(nit);
        const encontrado = proveedores.find((p) => normalizarNit(p.nit) === buscado);
        if (!encontrado) return null;
        return { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo };
      } catch {
        // La interfaz SapAdapter no tiene una variante de error para este
        // método (solo `{codigo_sap, activo} | null`): una falla de lectura
        // o de esquema del maestro se trata como "no encontrado" — falla
        // cerrado (dispara RC1 en vez de afirmar un proveedor inexistente),
        // y nunca lanza hacia quien la llama.
        return null;
      }
    },

    async crearOrden(orden) {
      return conMutex(async () => {
        await mkdir(dirSap, { recursive: true });
        const registros = await leerRegistrosOrdenes();

        // Idempotencia real, dentro de la misma sección crítica: si dos
        // llamadas concurrentes llegan para el mismo solicitud_id, la
        // segunda encuentra acá el registro que acaba de escribir la
        // primera y devuelve ese — nunca asigna un número nuevo. Esto es
        // además de (no en lugar de) el chequeo previo que ya hace
        // `oc_crear` en src/tools/oc.ts vía `buscarOrdenPorReferencia`.
        const existente = registros.find((r) => r.solicitud_id === orden.referencia.solicitud_id);
        if (existente) {
          return { numero_oc: existente.numero_oc, fecha: existente.fecha };
        }

        let siguiente = PRIMER_NUMERO_OC;
        if (registros.length > 0) {
          siguiente = Math.max(...registros.map((r) => Number(r.numero_oc))) + 1;
        }

        const numero_oc = String(siguiente);
        const fecha = new Date().toISOString();
        const registro: RegistroOrdenAlmacenado = {
          numero_oc,
          fecha,
          solicitud_id: orden.referencia.solicitud_id,
          orden,
        };
        await appendFile(rutaOrdenes, `${JSON.stringify(registro)}\n`, "utf-8");

        return { numero_oc, fecha };
      });
    },

    async buscarOrdenPorReferencia(solicitud_id) {
      return conMutex(async () => {
        const registros = await leerRegistrosOrdenes();
        const encontrado = registros.find((r) => r.solicitud_id === solicitud_id);
        return encontrado ? { numero_oc: encontrado.numero_oc } : null;
      });
    },
  };
}
