/**
 * Interfaz del adaptador SAP — PRD 7.4.
 *
 * La forma exacta de `SapAdapter` ya está definida en `src/tipos.ts` (vocabulario
 * compartido, no se modifica). Este archivo solo la re-exporta para que
 * `src/sap/mock.ts` y cualquier futura implementación real la importen desde
 * `src/sap/adapter.ts`, tal como pide la estructura del repositorio.
 */

export type { SapAdapter } from "../tipos";
