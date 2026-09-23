/**
 * Cubre tres hallazgos de auditoría externa sobre src/tools/oc.ts:
 * - RC2: `cuerpo.includes("Aprobado")` da un falso positivo con "No Aprobado,
 *   revisar presupuesto" (la subcadena "Aprobado" está igual presente).
 *   `estaAprobado` tiene que exigir la palabra completa y descartar la
 *   oración cuando aparece negada.
 * - Identificador de caso: viaja directo a rutas de archivo sin validar
 *   formato, lo que permitía un intento de path traversal (ej. "../../..").
 * - `oc_crear` confiaba en la `validacion` que recibía como argumento: un
 *   payload de un caso combinado con la validación (o solo el payload) de
 *   otro caso creaba una OC saltándose bloqueos/confirmaciones reales.
 */

import { describe, test, expect } from "bun:test";
import { rm } from "node:fs/promises";
import { estaAprobado, leer_paquete, generar_evidencia, construir_payload, validar, crear } from "./oc";
import type { Paquete, Validacion, OrdenCompra } from "../tipos";

const ctx = { directory: process.cwd(), sessionId: "test-oc" };

function parsear<T>(resultadoStr: string): { ok: true; data: T } | { ok: false; error: string } {
  return JSON.parse(resultadoStr) as { ok: true; data: T } | { ok: false; error: string };
}

describe("estaAprobado (RC2 — detección de aprobación en el correo)", () => {
  test("rechaza 'No Aprobado, revisar presupuesto' (el bug reportado: antes daba true por subcadena)", () => {
    expect(estaAprobado("No Aprobado, revisar presupuesto.")).toBe(false);
  });

  test("rechaza variantes de negación: 'sin aprobar', 'rechazado'", () => {
    expect(estaAprobado("Sin aprobar todavía, falta el visto bueno de finanzas.")).toBe(false);
    expect(estaAprobado("Rechazado. No procede la compra en estos términos.")).toBe(false);
  });

  test("acepta los cuerpos reales de los fixtures (sol-001/002/003)", () => {
    expect(estaAprobado("Aprobado, proceder con la orden de compra.\n\nMariana López\nGerente de Tecnología")).toBe(true);
    expect(estaAprobado("Aprobado.\n\nMariana López")).toBe(true);
    expect(
      estaAprobado(
        "Aprobado desde comercial, es para el equipo de preventa que se muda a la nueva sede.\n\nFelipe Vargas"
      )
    ).toBe(true);
  });

  test("acepta una negación que no toca la aprobación misma ('aprobado, sin objeciones')", () => {
    expect(estaAprobado("Aprobado, sin objeciones de mi parte.")).toBe(true);
  });

  test("es insensible a mayúsculas y a tildes", () => {
    expect(estaAprobado("APROBADA la compra.")).toBe(true);
    expect(estaAprobado("NO APROBADA, falta justificación.")).toBe(false);
  });
});

describe("validación de formato del identificador de caso (path traversal)", () => {
  test("oc_leer_paquete rechaza un caso con '../' antes de tocar cualquier ruta", async () => {
    const resultadoStr = await leer_paquete.execute({ caso: "../../../etc" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean; error?: string };
    expect(resultado.ok).toBe(false);
    expect(resultado.error).toContain("../../../etc");
  });

  test("oc_leer_paquete rechaza un caso con separador de ruta absoluta", async () => {
    const resultadoStr = await leer_paquete.execute({ caso: "sol-001/../../secrets" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean };
    expect(resultado.ok).toBe(false);
  });

  test("oc_generar_evidencia rechaza el mismo formato inválido antes de escribir en out/", async () => {
    const resultadoStr = await generar_evidencia.execute({ caso: "../fuera-de-out" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean };
    expect(resultado.ok).toBe(false);
  });

  test("un identificador de caso válido (real) no se ve afectado por la validación de formato", async () => {
    const resultadoStr = await leer_paquete.execute({ caso: "sol-001" }, ctx);
    const resultado = JSON.parse(resultadoStr) as { ok: boolean };
    expect(resultado.ok).toBe(true);
  });
});

describe("oc_crear re-deriva la validación desde el caso (no confía en la del llamador)", () => {
  test("rechaza un payload cuya solicitud_id no corresponde al caso indicado", async () => {
    await rm(`${ctx.directory}/out/sap`, { recursive: true, force: true });

    const paqueteResp = parsear<Paquete>(await leer_paquete.execute({ caso: "sol-001" }, ctx));
    if (!paqueteResp.ok) throw new Error(`no se pudo leer sol-001: ${paqueteResp.error}`);
    const validacionResp = parsear<Validacion>(
      await validar.execute({ caso: "sol-001", paquete: paqueteResp.data }, ctx)
    );
    if (!validacionResp.ok) throw new Error(`no se pudo validar sol-001: ${validacionResp.error}`);
    const payloadResp = parsear<{ payload: OrdenCompra }>(
      await construir_payload.execute(
        {
          caso: "sol-001",
          paquete: paqueteResp.data,
          derivados: validacionResp.data.derivados,
          validacion: validacionResp.data,
          evidencia_sha256: undefined,
        },
        ctx
      )
    );
    if (!payloadResp.ok) throw new Error(`no se pudo construir el payload de sol-001: ${payloadResp.error}`);

    // El payload es legítimo para sol-001, pero se le adultera la
    // referencia para que apunte a una solicitud que no es la del caso
    // "sol-001" que se le va a pasar a oc_crear.
    const payloadAdulterado: OrdenCompra = {
      ...payloadResp.data.payload,
      referencia: { ...payloadResp.data.payload.referencia, solicitud_id: "SOL-9999-INEXISTENTE" },
    };

    const crearResp = parsear<{ numero_oc: string }>(
      await crear.execute({ caso: "sol-001", payload: payloadAdulterado, confirmado: true }, ctx)
    );
    expect(crearResp.ok).toBe(false);
    if (!crearResp.ok) {
      expect(crearResp.error).toContain("no coinciden");
    }
  });

  test("un payload legítimo para el caso correcto sigue creando la OC (la re-derivación no rompe el flujo normal)", async () => {
    await rm(`${ctx.directory}/out/sap`, { recursive: true, force: true });

    const paqueteResp = parsear<Paquete>(await leer_paquete.execute({ caso: "sol-001" }, ctx));
    if (!paqueteResp.ok) throw new Error(`no se pudo leer sol-001: ${paqueteResp.error}`);
    const validacionResp = parsear<Validacion>(
      await validar.execute({ caso: "sol-001", paquete: paqueteResp.data }, ctx)
    );
    if (!validacionResp.ok) throw new Error(`no se pudo validar sol-001: ${validacionResp.error}`);
    const payloadResp = parsear<{ payload: OrdenCompra }>(
      await construir_payload.execute(
        {
          caso: "sol-001",
          paquete: paqueteResp.data,
          derivados: validacionResp.data.derivados,
          validacion: validacionResp.data,
          evidencia_sha256: undefined,
        },
        ctx
      )
    );
    if (!payloadResp.ok) throw new Error(`no se pudo construir el payload de sol-001: ${payloadResp.error}`);

    const crearResp = parsear<{ numero_oc: string; idempotente: boolean }>(
      await crear.execute({ caso: "sol-001", payload: payloadResp.data.payload, confirmado: true }, ctx)
    );
    expect(crearResp.ok).toBe(true);
    if (crearResp.ok) {
      expect(crearResp.data.numero_oc).toBe("4500000001");
      expect(crearResp.data.idempotente).toBe(false);
    }
  });
});
