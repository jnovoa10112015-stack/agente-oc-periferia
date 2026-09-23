/**
 * VOCABULARIO DEL PROYECTO
 *
 * Este archivo define qué es cada cosa en el sistema: una solicitud, un paquete,
 * una orden de compra. Todo lo demás se construye encima de esto.
 *
 * Esquemas tomados literalmente de las secciones 7.1, 7.2 y 7.4 del PRD.
 * NO modificar sin revisar el PRD: el evaluador compara contra estos campos.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// MAESTROS (fixtures/reto-03/maestros/) — PRD 7.1
// ─────────────────────────────────────────────────────────────

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});

export const AprobadorSchema = z.object({
  email: z.string(),
  nombre: z.string().optional(),
  tope: z.number(),
});

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(AprobadorSchema),
});

export const IndicadorIvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(),
});

export const CondicionPagoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number(),
});

export type Proveedor = z.infer<typeof ProveedorSchema>;
export type Aprobador = z.infer<typeof AprobadorSchema>;
export type CentroCosto = z.infer<typeof CentroCostoSchema>;
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>;
export type CondicionPago = z.infer<typeof CondicionPagoSchema>;

// ─────────────────────────────────────────────────────────────
// ENTRADA (fixtures/reto-03/solicitudes/<caso>/) — PRD 7.1
// Los campos con .optional() PUEDEN FALTAR. Nunca inventarlos.
// ─────────────────────────────────────────────────────────────

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().nullish(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number(),
  valor_unitario: z.number(),
  valor_total: z.number(),
  moneda: z.string(),
  indicador_iva: z.string().nullish(),
  condiciones_pago: z.string().nullish(),
  fecha_solicitud: z.string(),
});

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
});

export type Solicitud = z.infer<typeof SolicitudSchema>;
export type Correo = z.infer<typeof CorreoSchema>;

// ─────────────────────────────────────────────────────────────
// PAQUETE NORMALIZADO — PRD 7.2
// Lo que devuelve oc_leer_paquete. Es la vista unificada del caso.
// ─────────────────────────────────────────────────────────────

export const PaqueteSchema = z.object({
  correo: z.object({
    id: z.string(),
    de: z.string(),
    asunto: z.string(),
    fecha: z.string(),
  }),
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: z.string().nullable(),
      texto: z.string(),
    })
    .nullable(),
  aprobacion: z
    .object({
      de: z.string(),
      fecha: z.string(),
      aprobado: z.boolean(),
      texto: z.string(),
    })
    .nullable(),
  factura: z
    .object({
      numero: z.string(),
      fecha: z.string(),
      total: z.number(),
    })
    .nullable(),
});

export type Paquete = z.infer<typeof PaqueteSchema>;

// ─────────────────────────────────────────────────────────────
// RESULTADO DE VALIDACIÓN — salida de oc_validar
//
// Tres niveles, y esta distinción es el corazón del producto:
//   bloqueo       → NO se crea la OC. Se devuelve al humano con recomendación.
//   confirmacion  → Se crea SOLO con confirmado = true explícito.
//   derivado      → Se completó un dato desde los maestros. Solo se informa.
// ─────────────────────────────────────────────────────────────

export const CodigoControlSchema = z.enum([
  "RC1", "RC2", "RC3", "RC4", "RC5",
  "RC6", "RC7", "RC8", "RC9", "RC10",
]);

export const HallazgoSchema = z.object({
  codigo: CodigoControlSchema,
  detalle: z.string(),
  recomendacion: z.string().optional(),
});

export const ValidacionSchema = z.object({
  apta: z.boolean(),
  bloqueos: z.array(HallazgoSchema),
  confirmaciones: z.array(HallazgoSchema),
  derivados: z.object({
    indicador_iva: z.string().nullable(),
    condiciones_pago: z.string().nullable(),
    proveedor_codigo_sap: z.string().nullable(),
  }),
  retroactiva: z.boolean(),
});

export type Hallazgo = z.infer<typeof HallazgoSchema>;
export type Validacion = z.infer<typeof ValidacionSchema>;

// ─────────────────────────────────────────────────────────────
// ORDEN DE COMPRA — PRD 7.4
// Los literales ("1000", "COP"|"USD") están fijados por el PRD.
// descripcion: máximo 40 caracteres, límite de SAP en texto breve.
// ─────────────────────────────────────────────────────────────

export const PosicionSchema = z.object({
  numero: z.number(),
  descripcion: z.string().max(40),
  cantidad: z.number(),
  unidad: z.enum(["UN", "H", "MES"]),
  precio_unitario: z.number(),
  centro_costo: z.string(),
  subarea: z.string(),
  indicador_iva: z.string(),
});

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z.array(PosicionSchema),
  excepciones: z.array(
    z.object({
      codigo: z.string(),
      detalle: z.string(),
      confirmado_por: z.string().nullable(),
    })
  ),
});

export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;
export type Posicion = z.infer<typeof PosicionSchema>;

// ─────────────────────────────────────────────────────────────
// ADAPTADOR SAP — PRD 7.4 (interfaz obligatoria en src/sap/adapter.ts)
// ─────────────────────────────────────────────────────────────

export interface SapAdapter {
  consultarProveedor(
    nit: string
  ): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(
    solicitud_id: string
  ): Promise<{ numero_oc: string } | null>;
}

// ─────────────────────────────────────────────────────────────
// RESULTADOS DE HERRAMIENTAS
// Toda herramienta devuelve esta forma. Nunca lanza excepción hacia el agente:
// un error es un dato, no una caída de la sesión.
// ─────────────────────────────────────────────────────────────

export type ResultadoHerramienta<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; codigo?: string };

export type ResultadoCrearOC =
  | { ok: true; data: { numero_oc: string; fecha: string; idempotente: boolean } }
  | { ok: false; error: string };
