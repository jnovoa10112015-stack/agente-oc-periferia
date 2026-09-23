/**
 * Cubre el hallazgo de auditoría externa sobre concurrencia en `crearOrden`:
 * sin serialización, dos pedidos simultáneos podían leer el mismo "último
 * número" y crear dos órdenes con el mismo `numero_oc`. `crearSapMock` ahora
 * serializa lectura+escritura de `ordenes.jsonl` con un mutex y hace
 * `crearOrden` idempotente dentro de esa misma sección crítica.
 */

import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crearSapMock } from "./mock";
import type { OrdenCompra } from "../tipos";

function ordenFake(solicitudId: string): OrdenCompra {
  return {
    referencia: { solicitud_id: solicitudId, correo_id: "c-1", cotizacion_ref: null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: "P1", nit: "900", nombre: "Prov" },
    moneda: "COP",
    condiciones_pago: "Z030",
    aprobador: { email: "a@a.com", fecha_aprobacion: "2026-01-01", evidencia_sha256: "x" },
    posiciones: [
      {
        numero: 10,
        descripcion: "d",
        cantidad: 1,
        unidad: "UN",
        precio_unitario: 100,
        centro_costo: "cc1",
        subarea: "sa1",
        indicador_iva: "C1",
      },
    ],
    excepciones: [],
  };
}

async function conDirectorioTemporal(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "sap-mock-test-"));
  try {
    await Bun.write(path.join(dir, "fixtures", "reto-03", "maestros", "proveedores.json"), "[]");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("crearSapMock — concurrencia en la numeración de órdenes", () => {
  test("20 solicitudes distintas creadas en paralelo reciben 20 numero_oc únicos y consecutivos", async () => {
    await conDirectorioTemporal(async (dir) => {
      const sap = crearSapMock(dir);
      const resultados = await Promise.all(
        Array.from({ length: 20 }, (_, i) => sap.crearOrden(ordenFake(`sol-conc-${i}`)))
      );
      const numeros = resultados.map((r) => Number(r.numero_oc)).sort((a, b) => a - b);
      expect(new Set(numeros).size).toBe(20);
      for (let i = 1; i < numeros.length; i++) {
        expect(numeros[i]).toBe((numeros[i - 1] as number) + 1);
      }
    });
  });

  test("20 llamadas concurrentes para la MISMA solicitud crean una sola orden (idempotencia bajo carrera)", async () => {
    await conDirectorioTemporal(async (dir) => {
      const sap = crearSapMock(dir);
      const resultados = await Promise.all(
        Array.from({ length: 20 }, () => sap.crearOrden(ordenFake("sol-conc-misma")))
      );
      const numeros = new Set(resultados.map((r) => r.numero_oc));
      expect(numeros.size).toBe(1);

      const contenido = await readFile(path.join(dir, "out", "sap", "ordenes.jsonl"), "utf-8");
      const lineas = contenido.split("\n").filter((l) => l.trim().length > 0);
      expect(lineas.length).toBe(1);
    });
  });
});
