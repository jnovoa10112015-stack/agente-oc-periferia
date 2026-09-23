/**
 * Las 6 herramientas del agente (PRD 6.2). Cada export es una herramienta:
 * el nombre que ve el modelo es "oc_<export>" (ej. `crear` → `oc_crear`).
 *
 * Reglas de CLAUDE.md que gobiernan este archivo:
 * - Nunca lanzan excepción hacia el agente: cualquier I/O va envuelto y un
 *   error se convierte en `{ ok: false, error }`.
 * - Devuelven un string (JSON.stringify de un ResultadoHerramienta<T>).
 * - Las rutas se resuelven siempre desde ctx.directory, nunca hardcodeadas.
 * - RC1–RC10 no se evalúan acá: viven en src/reglas/controles.ts. Este
 *   archivo solo orquesta lectura, maestros, controles, payload y SAP.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PaqueteSchema,
  SolicitudSchema,
  CorreoSchema,
  OrdenCompraSchema,
  ValidacionSchema,
  type Paquete,
  type Validacion,
  type OrdenCompra,
  type ResultadoHerramienta,
  type ResultadoCrearOC,
} from "../tipos";
import { cargarMaestros } from "../maestros";
import { validar as validarControles } from "../reglas/controles";
import { crearSapMock } from "../sap/mock";
import type { SapAdapter } from "../sap/adapter";

// ─────────────────────────────────────────────────────────────
// Infraestructura común a las 6 herramientas
// ─────────────────────────────────────────────────────────────

type Ctx = { directory: string; sessionId: string };

/** Convierte el mapa de schemas de `args` en el tipo que recibe `execute`. */
type InferirArgs<A extends Record<string, z.ZodType>> = {
  [K in keyof A]: z.infer<A[K]>;
};

function ok<T>(data: T): ResultadoHerramienta<T> {
  return { ok: true, data };
}

function err(error: string, codigo?: string): ResultadoHerramienta<never> {
  return codigo ? { ok: false, error, codigo } : { ok: false, error };
}

function responder<T>(resultado: ResultadoHerramienta<T>): string {
  return JSON.stringify(resultado);
}

/**
 * Único adaptador SAP mock del proceso. Se cachea por `directory` (en la
 * práctica siempre el mismo, la raíz del proyecto) para que las 6
 * herramientas compartan una sola instancia sin hardcodear la ruta.
 */
let sapCache: { directory: string; adaptador: SapAdapter } | null = null;

function obtenerSap(directory: string): SapAdapter {
  if (!sapCache || sapCache.directory !== directory) {
    sapCache = { directory, adaptador: crearSapMock(directory) };
  }
  return sapCache.adaptador;
}

function rutaCaso(directory: string, caso: string): string {
  return `${directory}/fixtures/reto-03/solicitudes/${caso}`;
}

async function existeDirectorio(ruta: string): Promise<boolean> {
  try {
    const info = await stat(ruta);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function listarCasosDisponibles(directory: string): Promise<string[]> {
  const base = `${directory}/fixtures/reto-03/solicitudes`;
  try {
    const entradas = await readdir(base, { withFileTypes: true });
    return entradas
      .filter((entrada) => entrada.isDirectory())
      .map((entrada) => entrada.name)
      .sort();
  } catch {
    return [];
  }
}

type LecturaJson =
  | { existe: true; ok: true; datos: unknown }
  | { existe: true; ok: false; error: string }
  | { existe: false };

async function leerJsonOpcional(ruta: string): Promise<LecturaJson> {
  const archivo = Bun.file(ruta);
  const existe = await archivo.exists();
  if (!existe) return { existe: false };
  const texto = await archivo.text();
  try {
    return { existe: true, ok: true, datos: JSON.parse(texto) as unknown };
  } catch {
    return { existe: true, ok: false, error: `El archivo ${ruta} no contiene JSON válido.` };
  }
}

async function leerTextoOpcional(ruta: string): Promise<string | null> {
  const archivo = Bun.file(ruta);
  const existe = await archivo.exists();
  if (!existe) return null;
  return archivo.text();
}

/** Extrae el primer grupo de captura de `patron` en `texto`, o `null`. */
function extraerLinea(texto: string, patron: RegExp): string | null {
  const valor = texto.match(patron)?.[1];
  return valor ? valor.trim() : null;
}

/**
 * Parseo determinístico (regex sobre texto plano, nunca modelo de lenguaje)
 * de una línea "TOTAL..." tipo "TOTAL (IVA incluido): COP 11.400.000" o
 * "TOTAL: COP 3.200.000" → { moneda: "COP", total: 11400000 }.
 */
function parseLineaTotal(texto: string, prefijo: string): { moneda: string; total: number } | null {
  const linea = texto.split(/\r?\n/).find((l) => l.trim().startsWith(prefijo));
  if (!linea) return null;
  const match = linea.match(/([A-Z]{3})\s+([\d.,]+)/);
  const moneda = match?.[1];
  const montoTexto = match?.[2];
  if (!moneda || !montoTexto) return null;
  const total = Number(montoTexto.replace(/\./g, "").replace(/,/g, ""));
  if (!Number.isFinite(total)) return null;
  return { moneda, total };
}

/** "Validez de la oferta: 30 días" → null. "... hasta 2026-09-30" → "2026-09-30". */
function extraerValidezHasta(texto: string): string | null {
  const valor = extraerLinea(texto, /^Validez de la oferta:\s*(.+)$/m);
  if (!valor) return null;
  return valor.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

/** "COTIZACIÓN COT-TS-2026-0451" (primera línea) → "COT-TS-2026-0451". */
function extraerCotizacionRef(texto: string): string | null {
  return extraerLinea(texto, /COTIZACI[ÓO]N\s+(\S+)/);
}

/** Forma cruda de aprobacion.json (PRD 7.1). No vive en tipos.ts porque no es
 * el paquete normalizado: es el archivo tal como llega, con "para"/"cc" que
 * el paquete no conserva. */
const AprobacionArchivoSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  cc: z.array(z.string()).optional(),
  fecha: z.string(),
  asunto: z.string().optional(),
  cuerpo: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────
// 1. oc_leer_paquete
// ─────────────────────────────────────────────────────────────

const leerPaqueteArgs = {
  caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, ej. \"sol-001\"."),
};

export const leer_paquete = {
  description:
    "Lee correo, solicitud, cotización, aprobación y factura (si existen) de un caso y devuelve el paquete normalizado.",
  args: leerPaqueteArgs,
  async execute(args: InferirArgs<typeof leerPaqueteArgs>, ctx: Ctx): Promise<string> {
    const base = rutaCaso(ctx.directory, args.caso);

    if (!(await existeDirectorio(base))) {
      const disponibles = await listarCasosDisponibles(ctx.directory);
      return responder(
        err(
          `El caso "${args.caso}" no existe en fixtures/reto-03/solicitudes/. Casos disponibles: ${
            disponibles.length > 0 ? disponibles.join(", ") : "(no se encontró ninguno)"
          }.`
        )
      );
    }

    // correo.json — obligatorio.
    const correoLectura = await leerJsonOpcional(`${base}/correo.json`);
    if (!correoLectura.existe) {
      return responder(err(`Falta correo.json en el caso "${args.caso}".`));
    }
    if (!correoLectura.ok) return responder(err(correoLectura.error));
    const correoParsed = CorreoSchema.safeParse(correoLectura.datos);
    if (!correoParsed.success) {
      return responder(err(`correo.json del caso "${args.caso}" no cumple el esquema esperado: ${correoParsed.error.message}`));
    }

    // solicitud.json — obligatorio.
    const solicitudLectura = await leerJsonOpcional(`${base}/solicitud.json`);
    if (!solicitudLectura.existe) {
      return responder(err(`Falta solicitud.json en el caso "${args.caso}".`));
    }
    if (!solicitudLectura.ok) return responder(err(solicitudLectura.error));
    const solicitudParsed = SolicitudSchema.safeParse(solicitudLectura.datos);
    if (!solicitudParsed.success) {
      return responder(
        err(`solicitud.json del caso "${args.caso}" no cumple el esquema esperado: ${solicitudParsed.error.message}`)
      );
    }

    // aprobacion.json — opcional. `aprobado` se calcula con un string.includes
    // simple, nunca con el modelo de lenguaje.
    const aprobacionLectura = await leerJsonOpcional(`${base}/aprobacion.json`);
    let aprobacion: Paquete["aprobacion"] = null;
    if (aprobacionLectura.existe) {
      if (!aprobacionLectura.ok) return responder(err(aprobacionLectura.error));
      const aprobacionParsed = AprobacionArchivoSchema.safeParse(aprobacionLectura.datos);
      if (!aprobacionParsed.success) {
        return responder(
          err(`aprobacion.json del caso "${args.caso}" no cumple el esquema esperado: ${aprobacionParsed.error.message}`)
        );
      }
      const cuerpo = aprobacionParsed.data.cuerpo ?? "";
      aprobacion = {
        de: aprobacionParsed.data.de,
        fecha: aprobacionParsed.data.fecha,
        aprobado: cuerpo.includes("Aprobado"),
        texto: cuerpo,
      };
    }

    // cotizacion.txt — opcional, parseo por texto plano.
    const cotizacionTexto = await leerTextoOpcional(`${base}/cotizacion.txt`);
    let cotizacion: Paquete["cotizacion"] = null;
    if (cotizacionTexto !== null) {
      const proveedor = extraerLinea(cotizacionTexto, /^Proveedor:\s*(.+)$/m);
      const totalInfo = parseLineaTotal(cotizacionTexto, "TOTAL");
      if (!proveedor || !totalInfo) {
        return responder(
          err(`cotizacion.txt del caso "${args.caso}" no tiene el formato esperado (falta "Proveedor:" o una línea "TOTAL").`)
        );
      }
      cotizacion = {
        proveedor,
        nit: extraerLinea(cotizacionTexto, /^NIT:\s*(.+)$/m),
        total: totalInfo.total,
        moneda: totalInfo.moneda,
        validez_hasta: extraerValidezHasta(cotizacionTexto),
        texto: cotizacionTexto,
      };
    }

    // factura.txt — opcional, solo en el caso retroactivo.
    const facturaTexto = await leerTextoOpcional(`${base}/factura.txt`);
    let factura: Paquete["factura"] = null;
    if (facturaTexto !== null) {
      const numero = extraerLinea(facturaTexto, /No\.\s*(\S+)/);
      const fecha = extraerLinea(facturaTexto, /^Fecha de emisión:\s*(.+)$/m);
      const totalInfo = parseLineaTotal(facturaTexto, "TOTAL");
      if (!numero || !fecha || !totalInfo) {
        return responder(err(`factura.txt del caso "${args.caso}" no tiene el formato esperado.`));
      }
      factura = { numero, fecha, total: totalInfo.total };
    }

    const paqueteValidado = PaqueteSchema.safeParse({
      correo: {
        id: correoParsed.data.id,
        de: correoParsed.data.de,
        asunto: correoParsed.data.asunto,
        fecha: correoParsed.data.fecha,
      },
      solicitud: solicitudParsed.data,
      cotizacion,
      aprobacion,
      factura,
    });
    if (!paqueteValidado.success) {
      return responder(err(`El paquete del caso "${args.caso}" no cumple PaqueteSchema: ${paqueteValidado.error.message}`));
    }
    return responder(ok(paqueteValidado.data));
  },
};

// ─────────────────────────────────────────────────────────────
// 2. oc_validar
// ─────────────────────────────────────────────────────────────

const validarArgs = {
  caso: z.string().describe("Nombre del caso, solo para trazabilidad del llamado."),
  paquete: PaqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete."),
};

export const validar = {
  description: "Aplica los controles RC1–RC10 contra los maestros y devuelve bloqueos, confirmaciones y valores derivados.",
  args: validarArgs,
  async execute(args: InferirArgs<typeof validarArgs>, ctx: Ctx): Promise<string> {
    const maestros = await cargarMaestros(ctx.directory);
    if (!maestros.ok) return responder(maestros);
    const resultado = validarControles(args.paquete, maestros.data);
    return responder(ok(resultado));
  },
};

// ─────────────────────────────────────────────────────────────
// 3. oc_construir_payload
// ─────────────────────────────────────────────────────────────

const construirPayloadArgs = {
  caso: z.string().describe("Nombre del caso; determina dónde se guarda la trazabilidad (out/<caso>/trazabilidad.json)."),
  paquete: PaqueteSchema.describe("Paquete normalizado devuelto por oc_leer_paquete."),
  derivados: ValidacionSchema.shape.derivados.describe("derivados de la Validacion devuelta por oc_validar."),
  validacion: ValidacionSchema.describe("Validacion completa devuelta por oc_validar (se usa para armar las excepciones)."),
  evidencia_sha256: z
    .string()
    .optional()
    .describe(
      "sha256 de la evidencia de aprobación, si ya se generó con oc_generar_evidencia. Si se omite, el payload se " +
        "construye con evidencia_sha256 en blanco (\"\") como marcador de 'pendiente'; oc_crear no depende de este valor."
    ),
};

type ResultadoConstruirPayload = { payload: OrdenCompra; trazabilidad_ruta: string };

export const construir_payload = {
  description: "Construye y valida el payload de la OC (PRD 7.4) a partir del paquete y los derivados de oc_validar.",
  args: construirPayloadArgs,
  async execute(args: InferirArgs<typeof construirPayloadArgs>, ctx: Ctx): Promise<string> {
    const { paquete, derivados, validacion } = args;

    // Si RC1 no resolvió el proveedor (bloqueo), no hay código SAP real que
    // poner: se usa "" como marcador explícito de "sin resolver", nunca un
    // valor inventado. El payload igual se construye porque oc_crear lo
    // necesita para registrar el intento bloqueado en out/control.csv (HU-5:
    // "cada intento, exitoso, bloqueado o pendiente, agrega una fila") — este
    // payload con bloqueos abiertos nunca llega a sap.crearOrden(), oc_crear
    // corta antes por `validacion.bloqueos.length > 0`.
    const codigoSapProveedor = derivados.proveedor_codigo_sap ?? "";

    if (paquete.solicitud.moneda !== "COP" && paquete.solicitud.moneda !== "USD") {
      return responder(err(`Moneda "${paquete.solicitud.moneda}" no soportada: solo se acepta "COP" o "USD".`));
    }
    const moneda: "COP" | "USD" = paquete.solicitud.moneda;

    const condicionesPago = paquete.solicitud.condiciones_pago ?? derivados.condiciones_pago;
    if (!condicionesPago) {
      return responder(err("No hay condiciones de pago ni en la solicitud ni derivadas del proveedor."));
    }

    const indicadorIva = paquete.solicitud.indicador_iva ?? derivados.indicador_iva;
    if (!indicadorIva) {
      return responder(err("No hay indicador de IVA ni en la solicitud ni derivado del proveedor."));
    }

    // El NIT del proveedor no está en `derivados`: se toma de la solicitud y,
    // si falta, de la cotización. Si ninguna lo trae, no se inventa: se detiene.
    const nitProveedorFuente = paquete.solicitud.proveedor_nit ?? paquete.cotizacion?.nit ?? null;
    if (!nitProveedorFuente) {
      return responder(err("No hay NIT del proveedor ni en la solicitud ni en la cotización; no se puede construir el payload."));
    }

    if (!paquete.aprobacion) {
      return responder(err("No hay correo de aprobación en el paquete; no se puede construir el payload sin inventar el aprobador."));
    }

    const cotizacionRef = paquete.cotizacion ? extraerCotizacionRef(paquete.cotizacion.texto) : null;

    const excepciones = [...validacion.bloqueos, ...validacion.confirmaciones].map((hallazgo) => ({
      codigo: hallazgo.codigo,
      detalle: hallazgo.detalle,
      confirmado_por: null,
    }));

    const candidato = {
      referencia: {
        solicitud_id: paquete.solicitud.solicitud_id,
        correo_id: paquete.correo.id,
        cotizacion_ref: cotizacionRef,
      },
      sociedad: "1000",
      organizacion_compras: "1000",
      proveedor: {
        codigo_sap: codigoSapProveedor,
        nit: nitProveedorFuente,
        nombre: paquete.solicitud.proveedor_nombre,
      },
      moneda,
      condiciones_pago: condicionesPago,
      aprobador: {
        email: paquete.aprobacion.de,
        fecha_aprobacion: paquete.aprobacion.fecha,
        // Todavía no existe: se genera en oc_generar_evidencia. "" es el
        // marcador explícito de "pendiente" documentado arriba; el llamador
        // puede pasar evidencia_sha256 si ya la tiene.
        evidencia_sha256: args.evidencia_sha256 ?? "",
      },
      posiciones: [
        {
          numero: 10,
          descripcion: paquete.solicitud.descripcion.slice(0, 40),
          cantidad: paquete.solicitud.cantidad,
          unidad: "UN" as const,
          precio_unitario: paquete.solicitud.valor_unitario,
          centro_costo: paquete.solicitud.centro_costo,
          subarea: paquete.solicitud.subarea,
          indicador_iva: indicadorIva,
        },
      ],
      excepciones,
    };

    const payloadValidado = OrdenCompraSchema.safeParse(candidato);
    if (!payloadValidado.success) {
      return responder(err(`El payload construido no cumple OrdenCompraSchema: ${payloadValidado.error.message}`));
    }
    const payload = payloadValidado.data;

    const carpetaCaso = `${ctx.directory}/out/${args.caso}`;
    await mkdir(carpetaCaso, { recursive: true });
    const trazabilidad = {
      "referencia.solicitud_id": "solicitud",
      "referencia.correo_id": "correo",
      "referencia.cotizacion_ref": cotizacionRef ? "cotizacion" : "sin_cotizacion",
      sociedad: "constante_prd",
      organizacion_compras: "constante_prd",
      "proveedor.codigo_sap": derivados.proveedor_codigo_sap ? "maestro.proveedores" : "sin_resolver (RC1)",
      "proveedor.nit": paquete.solicitud.proveedor_nit ? "solicitud" : "cotizacion",
      "proveedor.nombre": "solicitud",
      moneda: "solicitud",
      condiciones_pago: paquete.solicitud.condiciones_pago ? "solicitud" : "derivado",
      "aprobador.email": "aprobacion",
      "aprobador.fecha_aprobacion": "aprobacion",
      "aprobador.evidencia_sha256": args.evidencia_sha256 ? "oc_generar_evidencia" : "pendiente (oc_generar_evidencia)",
      "posiciones[0].descripcion": "solicitud",
      "posiciones[0].cantidad": "solicitud",
      "posiciones[0].precio_unitario": "solicitud",
      "posiciones[0].unidad": "valor_por_defecto",
      "posiciones[0].centro_costo": "solicitud",
      "posiciones[0].subarea": "solicitud",
      "posiciones[0].indicador_iva": paquete.solicitud.indicador_iva ? "solicitud" : "derivado",
      excepciones: "validacion",
    };
    const trazabilidadRutaRelativa = `out/${args.caso}/trazabilidad.json`;
    await Bun.write(`${carpetaCaso}/trazabilidad.json`, JSON.stringify(trazabilidad, null, 2));

    const resultado: ResultadoConstruirPayload = { payload, trazabilidad_ruta: trazabilidadRutaRelativa };
    return responder(ok(resultado));
  },
};

// ─────────────────────────────────────────────────────────────
// 4. oc_generar_evidencia
// ─────────────────────────────────────────────────────────────

const generarEvidenciaArgs = {
  caso: z.string().describe("Nombre del caso cuyo aprobacion.json se convierte en evidencia de texto."),
};

export const generar_evidencia = {
  description: "Relee aprobacion.json, escribe out/<caso>/aprobacion.txt como evidencia y devuelve su ruta y sha256.",
  args: generarEvidenciaArgs,
  async execute(args: InferirArgs<typeof generarEvidenciaArgs>, ctx: Ctx): Promise<string> {
    const base = rutaCaso(ctx.directory, args.caso);
    const lectura = await leerJsonOpcional(`${base}/aprobacion.json`);
    if (!lectura.existe) {
      return responder(err(`Falta aprobacion.json en el caso "${args.caso}"; no hay evidencia que generar.`));
    }
    if (!lectura.ok) return responder(err(lectura.error));

    const parseado = AprobacionArchivoSchema.safeParse(lectura.datos);
    if (!parseado.success) {
      return responder(err(`aprobacion.json del caso "${args.caso}" no cumple el esquema esperado: ${parseado.error.message}`));
    }
    const datos = parseado.data;

    const encabezados = [
      `De: ${datos.de}`,
      `Para: ${datos.para ?? "(no informado)"}`,
      `Fecha: ${datos.fecha}`,
      `Asunto: ${datos.asunto ?? "(no informado)"}`,
    ];
    const contenido = `${encabezados.join("\n")}\n\n${datos.cuerpo ?? ""}\n`;

    const carpetaCaso = `${ctx.directory}/out/${args.caso}`;
    await mkdir(carpetaCaso, { recursive: true });
    const rutaRelativa = `out/${args.caso}/aprobacion.txt`;
    await Bun.write(`${carpetaCaso}/aprobacion.txt`, contenido);

    const sha256 = createHash("sha256").update(contenido).digest("hex");
    return responder(ok({ ruta: rutaRelativa, sha256 }));
  },
};

// ─────────────────────────────────────────────────────────────
// 5. oc_crear
// ─────────────────────────────────────────────────────────────

const crearArgs = {
  caso: z.string().describe("Nombre del caso; identifica la fila que se agrega a out/control.csv."),
  payload: OrdenCompraSchema.describe("OrdenCompra devuelta por oc_construir_payload."),
  validacion: ValidacionSchema.describe("Validacion completa devuelta por oc_validar (bloqueos, confirmaciones, retroactiva)."),
  confirmado: z.boolean().optional().describe("true si el humano confirmó explícitamente las excepciones pendientes."),
};

async function registrarControl(
  directory: string,
  fila: { solicitud_id: string; resultado: string; numero_oc: string; retroactiva: boolean; bloqueos: string; confirmaciones: string }
): Promise<void> {
  const carpetaOut = `${directory}/out`;
  await mkdir(carpetaOut, { recursive: true });
  const ruta = `${carpetaOut}/control.csv`;
  const archivo = Bun.file(ruta);
  const existe = await archivo.exists();
  const encabezado = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n";
  const escapar = (valor: string): string => `"${valor.replace(/"/g, '""')}"`;
  const linea =
    [fila.solicitud_id, fila.resultado, fila.numero_oc, String(fila.retroactiva), fila.bloqueos, fila.confirmaciones, new Date().toISOString()]
      .map(escapar)
      .join(",") + "\n";
  const previo = existe ? await archivo.text() : encabezado;
  await Bun.write(ruta, previo + linea);
}

export const crear = {
  description: "Crea la OC en el SAP simulado si no hay bloqueos y las confirmaciones pendientes fueron confirmadas; siempre registra el intento en out/control.csv.",
  args: crearArgs,
  async execute(args: InferirArgs<typeof crearArgs>, ctx: Ctx): Promise<string> {
    const { payload, validacion } = args;
    const codigosBloqueos = validacion.bloqueos.map((h) => h.codigo).join(";");
    const codigosConfirmaciones = validacion.confirmaciones.map((h) => h.codigo).join(";");

    if (validacion.bloqueos.length > 0) {
      await registrarControl(ctx.directory, {
        solicitud_id: payload.referencia.solicitud_id,
        resultado: "bloqueada",
        numero_oc: "",
        retroactiva: validacion.retroactiva,
        bloqueos: codigosBloqueos,
        confirmaciones: codigosConfirmaciones,
      });
      const resultado: ResultadoCrearOC = {
        ok: false,
        error: `No se crea la OC: hay bloqueos sin resolver (${codigosBloqueos}). Corregir con el solicitante antes de reintentar.`,
      };
      return responder(resultado);
    }

    if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
      await registrarControl(ctx.directory, {
        solicitud_id: payload.referencia.solicitud_id,
        resultado: "pendiente_confirmacion",
        numero_oc: "",
        retroactiva: validacion.retroactiva,
        bloqueos: codigosBloqueos,
        confirmaciones: codigosConfirmaciones,
      });
      const resultado: ResultadoCrearOC = {
        ok: false,
        error: `Requiere confirmación explícita del humano antes de crear la OC. Códigos pendientes: ${codigosConfirmaciones}. Reintentar con confirmado: true.`,
      };
      return responder(resultado);
    }

    const sap = obtenerSap(ctx.directory);
    const existente = await sap.buscarOrdenPorReferencia(payload.referencia.solicitud_id);
    if (existente) {
      await registrarControl(ctx.directory, {
        solicitud_id: payload.referencia.solicitud_id,
        resultado: "idempotente",
        numero_oc: existente.numero_oc,
        retroactiva: validacion.retroactiva,
        bloqueos: codigosBloqueos,
        confirmaciones: codigosConfirmaciones,
      });
      const resultado: ResultadoCrearOC = {
        ok: true,
        data: { numero_oc: existente.numero_oc, fecha: "", idempotente: true },
      };
      return responder(resultado);
    }

    const creada = await sap.crearOrden(payload);
    await registrarControl(ctx.directory, {
      solicitud_id: payload.referencia.solicitud_id,
      resultado: "creada",
      numero_oc: creada.numero_oc,
      retroactiva: validacion.retroactiva,
      bloqueos: codigosBloqueos,
      confirmaciones: codigosConfirmaciones,
    });
    const resultado: ResultadoCrearOC = {
      ok: true,
      data: { numero_oc: creada.numero_oc, fecha: creada.fecha, idempotente: false },
    };
    return responder(resultado);
  },
};

// ─────────────────────────────────────────────────────────────
// 6. oc_leer_excel — stub P1 (PRD 6.2: prioridad opcional)
// ─────────────────────────────────────────────────────────────

const leerExcelArgs = {
  ruta: z.string().describe("Ruta relativa (desde ctx.directory) al archivo .xlsx a leer."),
};

export const leer_excel = {
  description: "Lee un archivo Excel de solicitud y devuelve sus filas. No implementado: P1 opcional del PRD.",
  args: leerExcelArgs,
  async execute(args: InferirArgs<typeof leerExcelArgs>, ctx: Ctx): Promise<string> {
    return responder(err("no implementado (P1)"));
  },
};
