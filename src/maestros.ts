/**
 * Carga y valida los 4 maestros de fixtures/reto-03/maestros/.
 *
 * Nunca lanza: un maestro ausente, ilegible, con JSON inválido o que no
 * cumple el esquema es un dato ({ ok: false, error }), no una caída de sesión.
 */

import { z } from "zod";
import {
  ProveedorSchema,
  CentroCostoSchema,
  IndicadorIvaSchema,
  CondicionPagoSchema,
  type Proveedor,
  type CentroCosto,
  type IndicadorIva,
  type CondicionPago,
  type ResultadoHerramienta,
} from "./tipos";

export type Maestros = {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: IndicadorIva[];
  condicionesPago: CondicionPago[];
};

type LecturaArchivo =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Lee y parsea un archivo JSON de maestro. Cubre los tres modos de falla
 * exigidos por el contrato: archivo ausente, archivo ilegible y JSON
 * malformado. Nunca lanza.
 */
async function leerJson(ruta: string): Promise<LecturaArchivo> {
  const archivo = Bun.file(ruta);

  const existe = await archivo.exists();
  if (!existe) {
    return { ok: false, error: `No se encontró el archivo de maestro: ${ruta}` };
  }

  let texto: string;
  try {
    texto = await archivo.text();
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No se pudo leer el archivo ${ruta}: ${mensaje}` };
  }

  try {
    return { ok: true, data: JSON.parse(texto) as unknown };
  } catch {
    return { ok: false, error: `El archivo ${ruta} no contiene JSON válido.` };
  }
}

/**
 * Lee, parsea y valida un maestro contra su esquema zod. Devuelve el mensaje
 * de error nombrando el archivo concreto que falló, nunca uno genérico.
 */
async function cargarUnMaestro<T>(
  ruta: string,
  nombre: string,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T[] } | { ok: false; error: string }> {
  const lectura = await leerJson(ruta);
  if (!lectura.ok) {
    return { ok: false, error: lectura.error };
  }
  const parseado = z.array(schema).safeParse(lectura.data);
  if (!parseado.success) {
    const detalle = parseado.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(elemento raíz)"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      error: `El maestro de ${nombre} (${ruta}) no cumple el esquema esperado: ${detalle}`,
    };
  }
  return { ok: true, data: parseado.data };
}

export async function cargarMaestros(
  directory: string
): Promise<ResultadoHerramienta<Maestros>> {
  const base = `${directory}/fixtures/reto-03/maestros`;

  const proveedores = await cargarUnMaestro(
    `${base}/proveedores.json`,
    "proveedores",
    ProveedorSchema
  );
  if (!proveedores.ok) return { ok: false, error: proveedores.error };

  const centrosCosto = await cargarUnMaestro(
    `${base}/centros-costo.json`,
    "centros de costo",
    CentroCostoSchema
  );
  if (!centrosCosto.ok) return { ok: false, error: centrosCosto.error };

  const indicadoresIva = await cargarUnMaestro(
    `${base}/indicadores-iva.json`,
    "indicadores de IVA",
    IndicadorIvaSchema
  );
  if (!indicadoresIva.ok) return { ok: false, error: indicadoresIva.error };

  const condicionesPago = await cargarUnMaestro(
    `${base}/condiciones-pago.json`,
    "condiciones de pago",
    CondicionPagoSchema
  );
  if (!condicionesPago.ok) return { ok: false, error: condicionesPago.error };

  return {
    ok: true,
    data: {
      proveedores: proveedores.data,
      centrosCosto: centrosCosto.data,
      indicadoresIva: indicadoresIva.data,
      condicionesPago: condicionesPago.data,
    },
  };
}
