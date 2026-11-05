# metabase-mcp-server

Servidor MCP (Model Context Protocol) en TypeScript que expone 80+ herramientas para
operar Metabase (dashboards, cards/preguntas, bases de datos, tablas) desde asistentes
de IA como Claude. Es un fork de madeofclay sobre el paquete open-source
`CognitionAI/metabase-mcp-server`, con un gateway OAuth agregado (`src/oauth-gateway.ts`)
para que clientes MCP remotos (ej. Claude.ai) se autentiquen contra una instancia
Metabase (por defecto `analytics.clay.cl`) sin compartir credenciales directamente.

## Qué hace

1. Al arrancar, `src/server.ts` carga configuración (`METABASE_URL` + API key o
   usuario/password) y crea un `MetabaseClient` (modo stdio) o espera credenciales
   por request (modo HTTP Stream, vía headers `x-metabase-*`).
2. Registra las herramientas MCP (`addDashboardTools`, `addDatabaseTools`,
   `addCardTools`, `addTableTools`, `addAdditionalTools`) sobre `FastMCP`, filtradas
   según el modo (`--essential` por defecto, `--all`, `--read`, `--write`).
3. Cada tool invoca `MetabaseClient` (`src/client/metabase-client.ts`), que llama a la
   REST API de Metabase (axios) usando la sesión/API key resuelta.
4. En modo HTTP Stream, el servidor escucha en `/mcp` (puerto 8011 por defecto).
5. Opcionalmente, `src/oauth-gateway.ts` corre un servidor Express separado (puerto
   8080 por defecto) que implementa Authorization Code + PKCE: muestra un formulario
   para ingresar credenciales Metabase, emite un JWT propio, y proxea las llamadas al
   servidor HTTP Stream inyectando los headers `x-metabase-*`. Las credenciales van
   **cifradas** dentro del JWT (AES-256-GCM, clave derivada de `JWT_SECRET`,
   `src/credentials.ts`): un JWT sólo va firmado y sin esto se leía la API key, la
   contraseña o la sesión decodificándolo.
6. Con `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, "Continuar con Google" pasa por el
   gateway (`/oauth/google/start` → Google → `/oauth/google/callback`,
   `src/google-sso.ts`) con el cliente OAuth de Google **del propio Metabase** y acceso
   offline. Así el gateway guarda un refresh token de Google y, en cada refresh del
   JWT, revisa la sesión de Metabase y la renueva (`/api/session/google_auth`) si tiene
   más de `METABASE_SESSION_RENEW_DAYS` (12) o Metabase ya la rechaza. Metabase vence
   cada sesión a los 14 días (`MAX_SESSION_AGE`) y antes la conexión moría ahí sin
   remedio (IAD-1210). Una sesión muerta que no se puede renovar hace fallar el
   refresh con `invalid_grant`, para que Claude pida reconectar en vez de fallar en
   cada tool. Sin esas dos variables queda el login de Google en el navegador, sin
   renovación.

## Estructura de carpetas

```
src/
  server.ts              # entrypoint MCP (stdio y HTTP Stream), registro de tools y filtrado
  oauth-gateway.ts        # gateway Express OAuth2 (Authorization Code + PKCE) para clientes como Claude.ai
  credentials.ts          # credenciales que viajan en el JWT, cifradas (AES-256-GCM)
  google-sso.ts           # login de Google en el servidor + renovación de la sesión de Metabase
  auth.ts                 # resolución de credenciales por request (headers x-metabase-*) en modo HTTP
  client/
    metabase-client.ts    # cliente HTTP hacia la REST API de Metabase (axios)
  tools/
    dashboard-tools.ts    # CRUD de dashboards, cards en dashboard, sharing/embedding
    card-tools.ts         # CRUD de cards/preguntas, ejecución de queries, pivot, public links
    database-tools.ts     # gestión de conexiones de bases de datos en Metabase, schema sync
    table-tools.ts        # metadata de tablas/campos, operaciones de datos (incl. replace CSV)
    additional-tools.ts   # colecciones, búsqueda, usuarios, actividad, playground links
    tool-filters.ts        # parseo de flags --essential/--all/--read/--write
  utils/config.ts         # carga y valida METABASE_URL / credenciales desde env vars
  types/                  # tipos de config y errores
docs/spec-google-sso-auth.md  # spec (no implementada del todo) para soportar sesión de Google SSO
Dockerfile / docker-compose.yml / docker-run.sh  # empaquetado para self-host vía Docker
smithery.yaml             # manifiesto para publicar en el registro Smithery (MCP)
.github/workflows/publish.yml  # única CI/CD: publica el paquete a npm en push a main
tests/                    # vitest (auth, config, metabase-client, oauth-gateway, tool-filters)
```

## Dependencias de infraestructura

| Recurso | Motor / detalle | Ambiente |
|---|---|---|
| Metabase (externo) | Instancia Metabase de Clay (ej. `analytics.clay.cl`), consumida vía REST API | prod y develop (según `METABASE_URL` / header `x-metabase-url`) |
| Registro npm | `@cognitionai/metabase-mcp-server` (scope del proyecto upstream, no `madeofclay`) | prod (publicación en cada push a `main`) |
| Google OAuth (externo) | Cliente OAuth del Google SSO de Metabase; el gateway lo usa con acceso offline. Necesita el redirect URI `https://data-dev.clay.cl/oauth/google/callback` autorizado en ese cliente y la pantalla de consentimiento Interna (en modo "Testing" los refresh tokens vencen a los 7 días) | develop (el único despliegue) |
| AWS Secrets Manager | `clay-data-secrets-{env}`: `METABASE_MCP_GATEWAY_SECRET` (firma y cifrado de los JWT) y `METABASE_MCP_GOOGLE_CLIENT_SECRET` (secreto del cliente de Google) | develop |
| EC2 `ai-agents-dev` (gracia-dev) | Host del servidor y del gateway (ver Deploy) | develop |

No hay bases de datos propias, colas SQS/SNS, buckets S3, tablas DynamoDB, Lambdas,
clusters EKS ni Terraform en este repo. El único estado en memoria es un `Map` de
códigos de autorización pendientes dentro de `oauth-gateway.ts` (TTL 10 minutos, se
pierde al reiniciar el proceso).

## Ejecución local

```bash
npm ci
export METABASE_URL=https://your-metabase-instance.com
export METABASE_API_KEY=your_metabase_api_key   # o METABASE_USERNAME + METABASE_PASSWORD

npm run build        # compila TS a build/ y copia a dist/
npm start            # modo stdio (proceso local)

# Modo HTTP Stream compartido:
MCP_TRANSPORT=http PORT=8011 node dist/server.js

# Gateway OAuth (proxea al HTTP Stream de arriba):
npm run start:gateway   # o: GATEWAY_PORT=8080 MCP_UPSTREAM=http://localhost:8011 node dist/oauth-gateway.js

# Tests
npm test
npm run test:watch

# Docker
docker-compose up
# o
./docker-run.sh
```

## Deploy

El único mecanismo de CI/CD real en el repo es `.github/workflows/publish.yml`:
en cada push a `main` (rama default), compila el proyecto, compara la versión de
`package.json` contra la versión publicada en npm, y si cambió, ejecuta `npm publish`
(usando el secret `COGNITION_NPM_TOKEN`) y crea un tag `vX.Y.Z`. No hay despliegue a
AWS, ECS, EKS ni Lambda gestionado desde este repo. Usar `[skip ci]` en el mensaje de
commit para saltar este workflow cuando corresponda.

**Dónde corre (manual, fuera de este repo):** EC2 `ai-agents-dev` (alias SSH
`gracia-dev`), clon en `/home/ec2-user/repos/respaldo/metabase-mcp-server`. Dos
programas de supervisord en `/etc/supervisord.conf.d/`: `dist/server.js` (HTTP Stream,
8011) y `dist/oauth-gateway.js` (8012, conf `metabase-mcp-oauth-gateway.conf`, con
`APP_ENV=development` y `CLAY_TEAM=data`). nginx publica el gateway en
`https://data-dev.clay.cl` (`/oauth/`, `/.well-known/*` y `/metabase-mcp-oauth/`).
Logs: `/var/log/metabase_mcp_oauth_gateway.err.log` (gateway) y
`/var/log/metabase_mcp_http.err.log` (errores de Metabase, con `auth_mode`).
Desplegar = `git pull` + `npm run build` en ese clon + `sudo supervisorctl restart`
de los dos programas. No hay despliegue en gracia-prod.

**Gotcha detectado (no corregido en este levantamiento):** el `CMD` del `Dockerfile`
ejecuta `node dist/index.js`, pero el build y `package.json.main` generan
`dist/server.js` — el contenedor tal como está definido probablemente falla al iniciar.
