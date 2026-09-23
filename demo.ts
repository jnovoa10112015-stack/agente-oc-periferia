/**
 * Verificación sin modelo (PRD §6.6): corre las 6 herramientas de
 * src/tools/oc.ts directo, sobre los 6 casos de fixtures/reto-03/solicitudes/,
 * y afirma los resultados exactos de referencia/resultados-exactos.md.
 *
 * `bun run demo.ts` — no requiere ninguna clave de proveedor de modelo.
 */

import { rm, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  PaqueteSchema,
  ValidacionSchema,
  OrdenCompraSchema,
  type Paquete,
  type Validacion,
  type OrdenCompra,
} from "./src/tipos";
import {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
} from "./src/tools/oc";

const ctx = { directory: process.cwd(), sessionId: "demo" };

// ─────────────────────────────────────────────────────────────
// Deserialización tipada de las respuestas de herramienta (siempre un string
// JSON con { ok, data } o { ok, error }, nunca `any`: se parsea a `unknown` y
// se valida con los esquemas zod ya definidos en tipos.ts, o con esquemas
// locales mínimos para las formas que no viven en tipos.ts.
// ─────────────────────────────────────────────────────────────

type Envelope = { ok: true; data: unknown } | { ok: false; error: string; codigo?: string };

function parsear(json: string): Envelope {
  const valor: unknown = JSON.parse(json);
  if (typeof valor === "object" && valor !== null && "ok" in valor) {
    return valor as Envelope;
  }
  throw new Error(`Respuesta de herramienta con forma inesperada: ${json}`);
}

const EvidenciaSchema = z.object({ ruta: z.string(), sha256: z.string() });
const ConstruirPayloadSchema = z.object({
  payload: OrdenCompraSchema,
  trazabilidad_ruta: z.string(),
});
const CrearDataSchema = z.object({
  numero_oc: z.string(),
  fecha: z.string(),
  idempotente: z.boolean(),
});

type ResultadoSimple<T> = { ok: true; data: T } | { ok: false; error: string };

async function leerPaquete(caso: string): Promise<ResultadoSimple<Paquete>> {
  const crudo = parsear(await leer_paquete.execute({ caso }, ctx));
  if (!crudo.ok) return { ok: false, error: crudo.error };
  return { ok: true, data: PaqueteSchema.parse(crudo.data) };
}

async function validarCaso(caso: string, paquete: Paquete): Promise<ResultadoSimple<Validacion>> {
  const crudo = parsear(await validar.execute({ caso, paquete }, ctx));
  if (!crudo.ok) return { ok: false, error: crudo.error };
  return { ok: true, data: ValidacionSchema.parse(crudo.data) };
}

async function generarEvidencia(caso: string): Promise<ResultadoSimple<{ ruta: string; sha256: string }>> {
  const crudo = parsear(await generar_evidencia.execute({ caso }, ctx));
  if (!crudo.ok) return { ok: false, error: crudo.error };
  return { ok: true, data: EvidenciaSchema.parse(crudo.data) };
}

async function construirPayload(
  caso: string,
  paquete: Paquete,
  validacion: Validacion,
  evidencia_sha256: string
): Promise<ResultadoSimple<{ payload: OrdenCompra; trazabilidad_ruta: string }>> {
  const crudo = parsear(
    await construir_payload.execute(
      { caso, paquete, derivados: validacion.derivados, validacion, evidencia_sha256 },
      ctx
    )
  );
  if (!crudo.ok) return { ok: false, error: crudo.error };
  return { ok: true, data: ConstruirPayloadSchema.parse(crudo.data) };
}

type ResultadoCrear =
  | { ok: true; numero_oc: string; fecha: string; idempotente: boolean }
  | { ok: false; error: string };

async function crearOC(
  caso: string,
  payload: OrdenCompra,
  validacion: Validacion,
  confirmado: boolean
): Promise<ResultadoCrear> {
  const crudo = parsear(await crear.execute({ caso, payload, validacion, confirmado }, ctx));
  if (!crudo.ok) return { ok: false, error: crudo.error };
  const data = CrearDataSchema.parse(crudo.data);
  return { ok: true, ...data };
}

// ─────────────────────────────────────────────────────────────
// Corrida completa de un caso: lee, valida, genera evidencia, construye el
// payload y llama a oc_crear. No corta en el primer bloqueo (a diferencia del
// agente conversacional real): acá el objetivo es ejercitar y loguear los 6
// casos completos, no simular la conversación.
// ─────────────────────────────────────────────────────────────

type CorridaCaso = {
  paquete: Paquete | null;
  validacion: Validacion | null;
  evidenciaSha256: string | null;
  payload: OrdenCompra | null;
  crear: ResultadoCrear | null;
  errorEn: string | null;
};

async function correrCaso(caso: string, confirmado: boolean): Promise<CorridaCaso> {
  const resultado: CorridaCaso = {
    paquete: null,
    validacion: null,
    evidenciaSha256: null,
    payload: null,
    crear: null,
    errorEn: null,
  };

  const paqueteResp = await leerPaquete(caso);
  if (!paqueteResp.ok) {
    resultado.errorEn = `oc_leer_paquete: ${paqueteResp.error}`;
    return resultado;
  }
  resultado.paquete = paqueteResp.data;

  const validacionResp = await validarCaso(caso, paqueteResp.data);
  if (!validacionResp.ok) {
    resultado.errorEn = `oc_validar: ${validacionResp.error}`;
    return resultado;
  }
  resultado.validacion = validacionResp.data;

  const evidenciaResp = await generarEvidencia(caso);
  if (!evidenciaResp.ok) {
    resultado.errorEn = `oc_generar_evidencia: ${evidenciaResp.error}`;
    return resultado;
  }
  resultado.evidenciaSha256 = evidenciaResp.data.sha256;

  const payloadResp = await construirPayload(
    caso,
    paqueteResp.data,
    validacionResp.data,
    evidenciaResp.data.sha256
  );
  if (!payloadResp.ok) {
    resultado.errorEn = `oc_construir_payload: ${payloadResp.error}`;
    return resultado;
  }
  resultado.payload = payloadResp.data.payload;

  resultado.crear = await crearOC(caso, payloadResp.data.payload, validacionResp.data, confirmado);
  return resultado;
}

// ─────────────────────────────────────────────────────────────
// Arnés de aserciones
// ─────────────────────────────────────────────────────────────

type Afirmacion = { descripcion: string; ok: boolean; detalle?: string };
const afirmaciones: Afirmacion[] = [];

function afirmar(descripcion: string, ok: boolean, detalle?: string): void {
  afirmaciones.push({ descripcion, ok, detalle: ok ? undefined : detalle });
}

function tieneCodigo(hallazgos: { codigo: string }[] | undefined, codigo: string): boolean {
  return (hallazgos ?? []).some((h) => h.codigo === codigo);
}

async function main(): Promise<void> {
  const dirOut = `${ctx.directory}/out`;
  // Determinismo (PRD §8): out/ se limpia al inicio de cada corrida.
  await rm(dirOut, { recursive: true, force: true });

  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"];
  const corridas = new Map<string, CorridaCaso>();
  for (const caso of casos) {
    corridas.set(caso, await correrCaso(caso, false));
  }

  const sol001Segunda = await correrCaso("sol-001", false);
  const sol004Segunda = await correrCaso("sol-004", true);

  // ---- sol-001: caso limpio, crea 4500000001 ----
  const c001 = corridas.get("sol-001") as CorridaCaso;
  afirmar(
    "sol-001: apta, sin bloqueos",
    c001.validacion?.apta === true && c001.validacion?.bloqueos.length === 0,
    JSON.stringify(c001.validacion?.bloqueos)
  );
  if (c001.crear && c001.crear.ok) {
    afirmar(
      "sol-001: crea OC 4500000001, idempotente=false",
      c001.crear.numero_oc === "4500000001" && c001.crear.idempotente === false,
      JSON.stringify(c001.crear)
    );
  } else {
    afirmar("sol-001: crea OC 4500000001, idempotente=false", false, JSON.stringify(c001.crear ?? c001.errorEn));
  }

  // ---- sol-002: bloqueo RC1, no crea ----
  const c002 = corridas.get("sol-002") as CorridaCaso;
  afirmar("sol-002: bloqueo RC1", tieneCodigo(c002.validacion?.bloqueos, "RC1"), JSON.stringify(c002.validacion?.bloqueos));
  afirmar("sol-002: no crea OC", c002.crear?.ok === false, JSON.stringify(c002.crear));

  // ---- sol-003: bloqueos RC2 y RC3, no crea ----
  const c003 = corridas.get("sol-003") as CorridaCaso;
  afirmar(
    "sol-003: bloqueos RC2 y RC3",
    tieneCodigo(c003.validacion?.bloqueos, "RC2") && tieneCodigo(c003.validacion?.bloqueos, "RC3"),
    JSON.stringify(c003.validacion?.bloqueos)
  );
  afirmar("sol-003: no crea OC", c003.crear?.ok === false, JSON.stringify(c003.crear));

  // ---- sol-004: confirmación RC5 (25.000.000 vs 26.500.000), requiere confirmado:true ----
  const c004 = corridas.get("sol-004") as CorridaCaso;
  const rc5 = (c004.validacion?.confirmaciones ?? []).find((h) => h.codigo === "RC5") ?? null;
  afirmar(
    "sol-004: confirmación RC5 con ambos valores (25.000.000 vs 26.500.000, verificado contra el fixture real)",
    rc5 !== null && rc5.detalle.includes("25.000.000") && rc5.detalle.includes("26.500.000"),
    rc5?.detalle
  );
  afirmar("sol-004: no crea sin confirmado:true", c004.crear?.ok === false, JSON.stringify(c004.crear));
  afirmar(
    "sol-004: crea con confirmado:true en la segunda pasada",
    sol004Segunda.crear?.ok === true,
    JSON.stringify(sol004Segunda.crear ?? sol004Segunda.errorEn)
  );

  // ---- sol-005: confirmación RC8, retroactiva=true ----
  const c005 = corridas.get("sol-005") as CorridaCaso;
  afirmar("sol-005: confirmación RC8", tieneCodigo(c005.validacion?.confirmaciones, "RC8"), JSON.stringify(c005.validacion?.confirmaciones));
  afirmar("sol-005: retroactiva=true", c005.validacion?.retroactiva === true);

  // ---- sol-006: sin NIT, proveedor por nombre, deriva C1 (RC6) y Z030 (RC7) ----
  const c006 = corridas.get("sol-006") as CorridaCaso;
  afirmar(
    "sol-006: proveedor resuelto por nombre (sin NIT en la solicitud)",
    c006.paquete?.solicitud.proveedor_nit == null && c006.validacion?.derivados.proveedor_codigo_sap !== null,
    String(c006.validacion?.derivados.proveedor_codigo_sap)
  );
  afirmar(
    "sol-006: deriva indicador_iva=C1 con confirmación RC6",
    c006.validacion?.derivados.indicador_iva === "C1" && tieneCodigo(c006.validacion?.confirmaciones, "RC6"),
    JSON.stringify(c006.validacion?.derivados)
  );
  afirmar(
    "sol-006: deriva condiciones_pago=Z030 (RC7, informativo, sin hallazgo)",
    c006.validacion?.derivados.condiciones_pago === "Z030" && !tieneCodigo(c006.validacion?.confirmaciones, "RC7"),
    JSON.stringify(c006.validacion?.derivados)
  );

  // ---- Idempotencia ----
  if (sol001Segunda.crear && sol001Segunda.crear.ok && c001.crear && c001.crear.ok) {
    afirmar(
      "idempotencia: sol-001 repetido devuelve el mismo numero_oc, idempotente=true",
      sol001Segunda.crear.idempotente === true && sol001Segunda.crear.numero_oc === c001.crear.numero_oc,
      JSON.stringify(sol001Segunda.crear)
    );
  } else {
    afirmar(
      "idempotencia: sol-001 repetido devuelve el mismo numero_oc, idempotente=true",
      false,
      JSON.stringify(sol001Segunda.crear ?? sol001Segunda.errorEn)
    );
  }

  // ---- Evidencia: out/<caso>/aprobacion.txt + sha256 ----
  for (const caso of casos) {
    const corrida = corridas.get(caso) as CorridaCaso;
    const rutaEvidencia = `${dirOut}/${caso}/aprobacion.txt`;
    const existe = await Bun.file(rutaEvidencia).exists();
    afirmar(`${caso}: existe out/${caso}/aprobacion.txt`, existe);
    const sha = corrida.evidenciaSha256 ?? "";
    afirmar(`${caso}: sha256 con forma válida (64 hex)`, /^[0-9a-f]{64}$/.test(sha), sha);
  }

  // ---- Control: out/control.csv con exactamente 8 filas de datos ----
  const controlTexto = await readFile(`${dirOut}/control.csv`, "utf-8").catch(() => "");
  const lineas = controlTexto.split("\n").filter((l) => l.trim().length > 0);
  const filasDatos = lineas.length > 0 ? lineas.length - 1 : 0;
  afirmar(
    "out/control.csv: existe con exactamente 8 filas de datos (6 intentos + sol-001 repetido + sol-004 confirmado)",
    filasDatos === 8,
    `filas reales: ${filasDatos}`
  );

  // ---- Reporte ----
  console.log("\n=== demo.ts — verificación sin modelo (6 casos, sin herramientas de LLM) ===\n");
  for (const a of afirmaciones) {
    const marca = a.ok ? "✓" : "✗";
    const linea = a.detalle ? `${marca} ${a.descripcion} — ${a.detalle}` : `${marca} ${a.descripcion}`;
    console.log(linea);
  }

  const fallidas = afirmaciones.filter((a) => !a.ok);
  console.log(`\n${afirmaciones.length - fallidas.length}/${afirmaciones.length} aserciones OK.`);
  if (fallidas.length > 0) {
    console.log(`\n${fallidas.length} aserciones fallaron:`);
    for (const f of fallidas) {
      console.log(`  ✗ ${f.descripcion}${f.detalle ? ` — ${f.detalle}` : ""}`);
    }
  }

  process.exit(fallidas.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`Error inesperado corriendo demo.ts: ${mensaje}`);
  process.exit(1);
});
