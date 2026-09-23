# agente-oc-periferia

Agente conversacional que lee un paquete de compra (solicitud, cotización y
correo de aprobación), lo valida contra los maestros de Periferia y crea la
orden de compra en un SAP simulado. Cuando algo no cuadra, se detiene y
pregunta: no inventa datos para poder seguir.

Prueba técnica — Reto 03 "Agente conversacional Órdenes de Compra SAP" del
proceso de selección de Periferia IT Group. El planteamiento completo de la
solución (arquitectura, ciclo del agente, matriz de controles, decisiones y
riesgos) está en [`SOLUCION.md`](./SOLUCION.md).

## Requisitos

- [Bun](https://bun.com) instalado (`bun --version`; se desarrolló con Bun 1.4.x).
  No hace falta Node ni instalar dependencias globales adicionales.
- Una clave de API del proveedor de modelo de lenguaje configurado (ver
  `.env.example`). No se necesita clave para correr `demo.ts`.

## Levantar el proyecto (un comando)

```bash
bun install && bun run dev
```

Esto instala dependencias y levanta el backend (`src/server.ts`), que expone
la API de chat en `/api/chat` y sirve el front estático de `web/`. Al terminar
el arranque, la consola imprime la URL local (por defecto algo como
`http://localhost:3000`, configurable con `PORT` en `.env`).

Antes de levantarlo por primera vez, copiá el archivo de variables de entorno
de ejemplo y completá al menos la clave del proveedor de modelo:

```bash
cp .env.example .env
# editar .env y completar la clave del proveedor
```

Sin `.env`, el servidor de chat no puede llamar al modelo (pero `demo.ts` sí
corre, porque no depende de ningún proveedor).

## Variables de entorno

Todas las variables requeridas, sin valores reales, están en
[`.env.example`](./.env.example): la clave de Google Gemini (`GEMINI_API_KEY`)
y el modelo (`GEMINI_MODEL`, por defecto `gemini-flash-lite-latest` — el nivel
más económico de la familia Gemini), los topes de costo configurables por sesión
(`MAX_TOKENS_POR_SESION`, `MAX_COSTO_USD_POR_SESION`; ver `SOLUCION.md` §4), el
tope de **iteraciones** del ciclo del agente (`MAX_ITERACIONES`, 8 por defecto
— PRD y CLAUDE.md piden que sea configurable), quién queda registrado como
confirmador de una excepción (`USUARIO_CONFIRMADOR`, por defecto `"analista"`)
y el puerto del backend (`PORT`).

La clave del modelo se lee **solo** de variable de entorno: nunca vive en el
repositorio, en el front, en los logs ni en la respuesta de `/api/health`.

## Correr `demo.ts` (verificación sin modelo)

`demo.ts` ejecuta las 6 herramientas de `src/tools/oc.ts` directamente, sin
pasar por el modelo de lenguaje ni por el servidor HTTP, sobre los 6 casos de
`fixtures/reto-03/solicitudes/`. No requiere ninguna clave de API:

```bash
bun run demo
```

Imprime por caso si la solicitud queda `apta`, sus bloqueos y confirmaciones,
si quedó marcada `retroactiva`, y el número de OC creada (o el motivo por el
que no se creó). Corre `sol-001` dos veces para mostrar idempotencia y fuerza
una confirmación explícita en `sol-004`.

Todo lo que el agente escribe (órdenes simuladas, log de control, evidencia de
aprobación) queda en `out/`, que se regenera en cada corrida y no se sube al
repositorio.

## Estructura del repositorio

Ver el árbol completo y la explicación de cada carpeta en `CLAUDE.md` (no se
entrega junto con el repositorio) y en `referencia/PRD.md` §6.5. En resumen:
`src/tools/` son las herramientas tipadas que el modelo puede llamar,
`src/reglas/` son los controles RC1–RC10 (código puro, sin modelo),
`src/sap/` es el adaptador al SAP simulado, `src/agente/` es el ciclo del
agente y el adaptador de proveedor de modelo, y `web/` es el front de chat.

## Link de prueba

**https://agente-oc-periferia.onrender.com**

Sin clave de acceso, público. Verificado en vivo: procesa `sol-001` y crea la
OC `4500000001` correctamente (ver `SOLUCION.md` para el detalle).

La instancia corre en el free tier de Render, que **se apaga tras ~15 minutos
sin tráfico**. Si el primer pedido después de un rato de inactividad tarda
hasta un minuto en responder, es ese arranque en frío del plan gratuito, no
un error de la app — los pedidos siguientes ya responden normal.

### Cómo desplegar en Render.com (free tier, sin tarjeta)

El repo ya trae `Dockerfile` y `render.yaml` (Render Blueprint) listos. Pasos
en el dashboard de Render (no requiere CLI):

1. Creá una cuenta en [render.com](https://render.com) (con GitHub, sin
   tarjeta para el free tier).
2. **New +** → **Blueprint** → conectá este repositorio de GitHub
   (`agente-oc-periferia`). Render lee `render.yaml` solo.
3. En la pantalla de variables de entorno, completá `GEMINI_API_KEY` con tu
   clave real (el resto de las variables ya vienen con default en
   `render.yaml`). Nunca se escribe en el repo — vive solo en el dashboard de
   Render.
4. **Apply** / **Create Web Service**. El build usa el `Dockerfile` (imagen
   `oven/bun:1`), corre `bun install --frozen-lockfile` y arranca con
   `bun run src/server.ts`.
5. Cuando el estado quede en **Live**, Render te da la URL pública
   (`https://agente-oc-periferia-XXXX.onrender.com` o el nombre que hayas
   puesto). Pegala en esta sección del README.

Nota del free tier de Render: el servicio "duerme" tras ~15 min sin tráfico y
el primer pedido después tarda unos segundos en despertarlo — es normal, no
es un error de la app.

Si el link queda protegido con una clave de acceso, se documenta acá antes de
la defensa.
