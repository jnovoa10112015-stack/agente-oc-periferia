/**
 * RC1–RC10, sección 7.3 del PRD. Función pura: entra Paquete + Maestros, sale
 * Validacion. Cero llamadas a modelo de lenguaje — son comparaciones contra
 * tablas. Se evalúan TODOS los controles siempre (no se corta en el primer
 * bloqueo): bloqueos y confirmaciones pueden traer varias entradas a la vez.
 */

import type {
  Paquete,
  Validacion,
  Hallazgo,
  Solicitud,
  Proveedor,
  CentroCosto,
  Aprobador,
} from "../tipos";
import type { Maestros } from "../maestros";

/** minúsculas, sin tildes, sin puntuación, sin sufijo societario al final, espacios colapsados. */
function normalizarNombre(nombre: string): string {
  const sinTildes = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const sinPuntuacion = sinTildes.replace(/[^a-z0-9\s]/g, " ");
  const colapsado = sinPuntuacion.replace(/\s+/g, " ").trim();
  // Sufijos societarios SOLO al final: "s.a.s"/"sas" y "s.a"/"sa" quedan
  // idénticos tras quitar la puntuación ("sas" y "sa" respectivamente), y se
  // suman "ltda" y "limitada".
  return colapsado.replace(/\s(sas|sa|ltda|limitada)$/, "").trim();
}

/** Comparación de NIT solo por dígitos: ignora puntos, guiones y cualquier otro formato. */
function normalizarNit(nit: string): string {
  return nit.replace(/\D/g, "");
}

function buscarProveedor(solicitud: Solicitud, maestros: Maestros): Proveedor | null {
  // Si hay NIT, la búsqueda es exclusivamente por NIT normalizado: no se cae a
  // buscar por nombre cuando el NIT no matchea. Solo se busca por nombre
  // cuando la solicitud no trae NIT en absoluto.
  if (solicitud.proveedor_nit) {
    const nitBuscado = normalizarNit(solicitud.proveedor_nit);
    return (
      maestros.proveedores.find((p) => normalizarNit(p.nit) === nitBuscado) ?? null
    );
  }
  const nombreBuscado = normalizarNombre(solicitud.proveedor_nombre);
  return (
    maestros.proveedores.find((p) => normalizarNombre(p.nombre) === nombreBuscado) ?? null
  );
}

function buscarCentroCosto(centroCostoId: string, maestros: Maestros): CentroCosto | null {
  return maestros.centrosCosto.find((c) => c.centro_costo === centroCostoId) ?? null;
}

function soloFecha(fechaIso: string): string {
  return fechaIso.slice(0, 10);
}

function formatoMoneda(valor: number): string {
  return valor.toLocaleString("es-CO");
}

function nombreCentro(centroCosto: CentroCosto): string {
  return centroCosto.nombre ? ` (${centroCosto.nombre})` : "";
}

export function validar(paquete: Paquete, maestros: Maestros): Validacion {
  const { solicitud } = paquete;
  const bloqueos: Hallazgo[] = [];
  const confirmaciones: Hallazgo[] = [];
  let retroactiva = false;
  let indicadorIvaDerivado: string | null = null;
  let condicionesPagoDerivado: string | null = null;
  let proveedorCodigoSap: string | null = null;

  const proveedor = buscarProveedor(solicitud, maestros);
  const centroCosto = buscarCentroCosto(solicitud.centro_costo, maestros);

  // ───────────────────────── RC1 — proveedor existe y activo ─────────────
  if (!proveedor) {
    const nombreNormalizado = normalizarNombre(solicitud.proveedor_nombre);
    const busqueda = solicitud.proveedor_nit
      ? `por NIT (normalizado a "${normalizarNit(solicitud.proveedor_nit)}"); no se buscó por nombre porque la solicitud sí trae NIT`
      : `por nombre normalizado ("${nombreNormalizado}"), porque la solicitud no trae NIT`;
    bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor "${solicitud.proveedor_nombre}"${
        solicitud.proveedor_nit ? ` (NIT ${solicitud.proveedor_nit})` : ""
      } no está registrado en el maestro de proveedores. Búsqueda realizada ${busqueda}.`,
      recomendacion: "Solicitar el alta del proveedor al área de compras antes de reintentar.",
    });
  } else if (!proveedor.activo) {
    bloqueos.push({
      codigo: "RC1",
      detalle: `El proveedor "${proveedor.nombre}" (NIT ${proveedor.nit}) está registrado pero marcado como inactivo.`,
      recomendacion: "Verificar con compras el estado del proveedor antes de reintentar.",
    });
  } else {
    proveedorCodigoSap = proveedor.codigo_sap;
  }

  // Proveedor "válido" para derivar datos (RC6/RC7): debe existir Y estar
  // activo. Uno encontrado pero inactivo ya es bloqueo RC1 y no se usa como
  // fuente de valores por defecto.
  const proveedorValido = proveedor && proveedor.activo ? proveedor : null;

  // ───────────────────────── RC2 — aprobación válida y autorizada ────────
  if (!paquete.aprobacion) {
    bloqueos.push({
      codigo: "RC2",
      detalle: "No existe correo de aprobación en el paquete.",
      recomendacion: "Solicitar la aprobación explícita del líder del centro de costo.",
    });
  } else {
    const aprobacion = paquete.aprobacion;
    if (aprobacion.aprobado !== true) {
      bloqueos.push({
        codigo: "RC2",
        detalle: `El correo de aprobación de ${aprobacion.de} no contiene una aprobación explícita ("Aprobado").`,
        recomendacion: "Solicitar la aprobación explícita del líder del centro de costo.",
      });
    } else if (!centroCosto) {
      bloqueos.push({
        codigo: "RC2",
        detalle: `No se puede verificar si ${aprobacion.de} está autorizado para aprobar, porque el centro de costo "${solicitud.centro_costo}" no existe en el maestro de centros de costo.`,
        recomendacion: "Corregir el centro de costo de la solicitud antes de validar la aprobación.",
      });
    } else if (!centroCosto.aprobadores.some((a) => a.email === aprobacion.de)) {
      const listado =
        centroCosto.aprobadores.map((a) => a.email).join(", ") || "(sin aprobadores registrados)";
      const centroDelAprobador = maestros.centrosCosto.find((c) =>
        c.aprobadores.some((a) => a.email === aprobacion.de)
      );
      const detalle = [
        `La aprobación viene de ${aprobacion.de}, que no figura como aprobador del centro ${centroCosto.centro_costo}${nombreCentro(centroCosto)}.`,
        centroDelAprobador
          ? `${aprobacion.de} sí figura como aprobador del centro ${centroDelAprobador.centro_costo}${nombreCentro(centroDelAprobador)}.`
          : `${aprobacion.de} no figura como aprobador de ningún centro de costo del maestro.`,
        `El centro de la solicitud es ${centroCosto.centro_costo}${nombreCentro(centroCosto)}, cuyo(s) aprobador(es) registrado(s) es/son: ${listado}.`,
      ].join(" ");
      bloqueos.push({
        codigo: "RC2",
        detalle,
        recomendacion: "Obtener aprobación del responsable del centro de costo correcto.",
      });
    }
  }

  // ───────────────────────── RC3 — monto dentro del tope ─────────────────
  // Independiente de RC2 a propósito: un aprobador sin autoridad sobre este
  // centro (RC2) y un monto que ni siquiera el aprobador con mayor tope de
  // ese centro podría autorizar (RC3) son dos hallazgos distintos y pueden
  // dispararse a la vez.
  {
    const emailAprobador = paquete.aprobacion?.de ?? null;
    let techo = 0;
    let aprobadorCoincide: Aprobador | null = null;

    if (centroCosto) {
      const coincide = emailAprobador
        ? centroCosto.aprobadores.find((a) => a.email === emailAprobador)
        : undefined;
      if (coincide) {
        techo = coincide.tope;
        aprobadorCoincide = coincide;
      } else if (centroCosto.aprobadores.length > 0) {
        techo = Math.max(...centroCosto.aprobadores.map((a) => a.tope));
      }
    }

    if (solicitud.valor_total > techo) {
      let detalle: string;
      if (aprobadorCoincide && centroCosto) {
        detalle = `El valor total es $${formatoMoneda(solicitud.valor_total)} y el tope del aprobador ${aprobadorCoincide.email} para el centro ${centroCosto.centro_costo}${nombreCentro(centroCosto)} es $${formatoMoneda(aprobadorCoincide.tope)}.`;
      } else if (centroCosto && centroCosto.aprobadores.length > 0) {
        detalle = `El valor total es $${formatoMoneda(solicitud.valor_total)}, que supera el tope más alto registrado para el centro ${centroCosto.centro_costo}${nombreCentro(centroCosto)}: $${formatoMoneda(techo)}. ${
          emailAprobador
            ? `${emailAprobador} no es aprobador de este centro (ver RC2).`
            : "No hay una aprobación registrada contra la cual verificar (ver RC2)."
        } Ningún aprobador de ese centro tiene autoridad para este monto.`;
      } else if (centroCosto) {
        detalle = `El centro ${centroCosto.centro_costo}${nombreCentro(centroCosto)} no tiene aprobadores registrados en el maestro, por lo que no hay tope autorizado (techo $0) para un valor total de $${formatoMoneda(solicitud.valor_total)}.`;
      } else {
        detalle = `El centro de costo "${solicitud.centro_costo}" no existe en el maestro, por lo que no hay tope autorizado (techo $0) contra el cual validar el valor total de $${formatoMoneda(solicitud.valor_total)}.`;
      }
      bloqueos.push({
        codigo: "RC3",
        detalle,
        recomendacion: "Escalar a un aprobador con tope suficiente para ese centro de costo.",
      });
    }
  }

  // ───────────────────────── RC4 — subárea pertenece al centro ───────────
  if (!centroCosto) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `El centro de costo "${solicitud.centro_costo}" no existe en el maestro de centros de costo.`,
      recomendacion: "Corregir el centro de costo en la solicitud.",
    });
  } else if (!centroCosto.subareas.includes(solicitud.subarea)) {
    bloqueos.push({
      codigo: "RC4",
      detalle: `"${solicitud.subarea}" no pertenece al centro ${centroCosto.centro_costo}${nombreCentro(centroCosto)}, cuyas subáreas son: ${centroCosto.subareas.join(", ")}.`,
      recomendacion: "Corregir la subárea en la solicitud o confirmar el centro de costo correcto con el solicitante.",
    });
  }

  // ───────────────────────── RC5 — cotización vs. solicitud (±2%) ────────
  if (!paquete.cotizacion) {
    confirmaciones.push({
      codigo: "RC5",
      detalle: "No hay cotización adjunta en el paquete para contrastar contra el valor de la solicitud.",
      recomendacion: "Confirmar que el valor de la solicitud es correcto sin cotización de respaldo.",
    });
  } else {
    const diferencia = Math.abs(paquete.cotizacion.total - solicitud.valor_total);
    const proporcion = diferencia / solicitud.valor_total;
    if (proporcion > 0.02) {
      confirmaciones.push({
        codigo: "RC5",
        detalle: `Solicitud: $${formatoMoneda(solicitud.valor_total)}. Cotización: $${formatoMoneda(paquete.cotizacion.total)}. Diferencia: $${formatoMoneda(diferencia)} (${(proporcion * 100).toFixed(2)}%, por encima del límite del 2%).`,
        recomendacion: "Confirmar si se crea la orden con el valor de la solicitud o se devuelve al solicitante.",
      });
    }
  }

  // ───────────────────────── RC6 — indicador de IVA derivado ─────────────
  if (!solicitud.indicador_iva) {
    if (proveedorValido) {
      indicadorIvaDerivado = proveedorValido.indicador_iva_default;
      confirmaciones.push({
        codigo: "RC6",
        detalle: `La solicitud no trae indicador de IVA. Se derivó "${proveedorValido.indicador_iva_default}" de la ficha del proveedor ${proveedorValido.nombre} (código SAP ${proveedorValido.codigo_sap}).`,
        recomendacion: "Confirmar el indicador de IVA derivado antes de crear la orden.",
      });
    } else {
      confirmaciones.push({
        codigo: "RC6",
        detalle: "La solicitud no trae indicador de IVA y no se pudo derivar de la ficha del proveedor porque el proveedor no está resuelto (ver RC1).",
        recomendacion: "Resolver primero la identificación del proveedor; luego confirmar el indicador de IVA.",
      });
    }
  }

  // ───────────────────────── RC7 — condiciones de pago derivadas ─────────
  // Igual que RC6 pero puramente informativo: no agrega ningún hallazgo.
  if (!solicitud.condiciones_pago && proveedorValido) {
    condicionesPagoDerivado = proveedorValido.condiciones_pago_default;
  }

  // ───────────────────────── RC8 — factura retroactiva ────────────────────
  // Comparación de string ISO directa (sin truncar): alcanza porque las
  // fechas de factura y de solicitud son fechas simples "YYYY-MM-DD".
  if (paquete.factura && paquete.factura.fecha < solicitud.fecha_solicitud) {
    retroactiva = true;
    confirmaciones.push({
      codigo: "RC8",
      detalle: `Existe la factura ${paquete.factura.numero} con fecha ${paquete.factura.fecha}, anterior a la fecha de la solicitud (${solicitud.fecha_solicitud}).`,
      recomendacion: "Confirmar la creación de la orden; quedará marcada como retroactiva en el registro de control.",
    });
  }

  // ───────────────────────── RC9 — fecha de aprobación ────────────────────
  // aprobacion.fecha trae hora y zona horaria: se compara solo la parte de
  // fecha (primeros 10 caracteres, YYYY-MM-DD) contra fecha_solicitud.
  if (paquete.aprobacion && soloFecha(paquete.aprobacion.fecha) < soloFecha(solicitud.fecha_solicitud)) {
    confirmaciones.push({
      codigo: "RC9",
      detalle: `La fecha de aprobación (${soloFecha(paquete.aprobacion.fecha)}) es anterior a la fecha de la solicitud (${soloFecha(solicitud.fecha_solicitud)}).`,
      recomendacion: "Confirmar con el aprobador que la aprobación corresponde a esta solicitud.",
    });
  }

  // ───────────────────────── RC10 — aritmética consistente ───────────────
  const calculado = solicitud.cantidad * solicitud.valor_unitario;
  const diferenciaAritmetica = Math.abs(calculado - solicitud.valor_total);
  if (diferenciaAritmetica > 1) {
    bloqueos.push({
      codigo: "RC10",
      detalle: `${solicitud.cantidad} unidades × $${formatoMoneda(solicitud.valor_unitario)} = $${formatoMoneda(calculado)}, pero la solicitud declara un total de $${formatoMoneda(solicitud.valor_total)}. Diferencia: $${formatoMoneda(diferenciaAritmetica)}.`,
      recomendacion: "No se determina cuál valor es correcto: devolver al solicitante para que corrija la solicitud.",
    });
  }

  return {
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados: {
      indicador_iva: indicadorIvaDerivado,
      condiciones_pago: condicionesPagoDerivado,
      proveedor_codigo_sap: proveedorCodigoSap,
    },
    retroactiva,
  };
}
