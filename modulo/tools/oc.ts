// Reexporta las herramientas reales de src/tools/oc.ts sin duplicar código:
// son las mismas 6 herramientas que usa la aplicación (importables acá sin
// levantar el servidor), no una copia divergente.
export * from "../../src/tools/oc";
