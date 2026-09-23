/**
 * Implementación simulada de SapAdapter sobre archivos en out/sap/.
 *
 * Todas las rutas se resuelven desde `directory` (raíz del proyecto), nunca
 * absolutas. Este módulo es infraestructura de bajo nivel: si algo falla de
 * forma irrecuperable en disco (permisos, JSON corrupto de un archivo que
 * nosotros mismos escribimos, etc.) se deja propagar como excepción real —
 * la capa que nunca debe lanzar es `src/tools/oc.ts`.
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

  // Devuelve las líneas no vacías de ordenes.jsonl, o null si el archivo
  // todavía no existe (primer uso: no es un error, es "sin órdenes aún").
  async function leerLineasOrdenes(): Promise<string[] | null> {
    let contenido: string;
    try {
      contenido = await readFile(rutaOrdenes, "utf-8");
    } catch (err) {
      if (esArchivoInexistente(err)) return null;
      throw err;
    }
    return contenido.split("\n").filter((linea) => linea.trim().length > 0);
  }

  return {
    async consultarProveedor(nit) {
      const contenido = await readFile(rutaProveedores, "utf-8");
      const proveedores = z.array(ProveedorSchema).parse(JSON.parse(contenido));
      const buscado = normalizarNit(nit);
      const encontrado = proveedores.find((p) => normalizarNit(p.nit) === buscado);
      if (!encontrado) return null;
      return { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo };
    },

    async crearOrden(orden) {
      await mkdir(dirSap, { recursive: true });
      const lineas = (await leerLineasOrdenes()) ?? [];

      let siguiente = PRIMER_NUMERO_OC;
      if (lineas.length > 0) {
        const numeros = lineas.map((linea) => {
          const registro = JSON.parse(linea) as RegistroOrdenAlmacenado;
          return Number(registro.numero_oc);
        });
        siguiente = Math.max(...numeros) + 1;
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
    },

    async buscarOrdenPorReferencia(solicitud_id) {
      const lineas = await leerLineasOrdenes();
      if (lineas === null) return null;
      for (const linea of lineas) {
        const registro = JSON.parse(linea) as RegistroOrdenAlmacenado;
        if (registro.solicitud_id === solicitud_id) {
          return { numero_oc: registro.numero_oc };
        }
      }
      return null;
    },
  };
}
