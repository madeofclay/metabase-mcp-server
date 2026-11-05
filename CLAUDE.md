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
   según el modo (`--essential` por defecto, `--all`, `--read`, `--write`). Sin flag,
   el modo sale de `METABASE_MCP_TOOLS` (`essential|all|read|write`); el flag gana.
   En gracia-dev basta con poner esa variable en el `environment` del programa de
   supervisord del HTTP Stream (`dist/server.js`, puerto 8011) y reiniciarlo.
3. Cada tool invoca `MetabaseClient` (`src/client/metabase-client.ts`), que llama a la
   REST API de Metabase (axios) usando la sesión/API key resuelta. En bases MongoDB,
   `execute_query` y `create_card` reciben el pipeline como JSON en `query` y la
   `collection` aparte: Metabase rechaza una query nativa de Mongo sin ella.
4. En modo HTTP Stream, el servidor escucha en `/mcp` (puerto 8011 por defecto).
5. Opcionalmente, `src/oauth-gateway.ts` corre un servidor Express separado (puerto
   8080 por defecto) que implementa Authorization Code + PKCE (obligatorio, S256):
   muestra un formulario para ingresar credenciales Metabase y proxea las llamadas al
   servidor HTTP Stream inyectando los headers `x-metabase-*`. Cada conexión es un
   **grant** guardado en el servidor (`src/grant-store.ts`, archivo JSON 0600 en
   `GRANT_STORE_PATH`): las credenciales van ahí cifradas (AES-256-GCM, clave
   derivada de `JWT_SECRET`, ligadas al id del grant, `src/credentials.ts`) y los
   JWT sólo llevan el id del grant, firmados HS256 con emisor fijo. Así un token
   filtrado no revela nada y revocar corta todos los tokens del grant al instante,
   porque `/mcp` revisa el grant en cada llamada. Plazos: acceso 1 h, refresh 14 días
   sin uso, grant 30 días absolutos. El refresh rota en cada uso y el almacén sólo
   guarda un HMAC de su `jti`: si vuelve un refresh ya reemplazado (pasados 30 s de
   gracia para reintentos), se revoca el grant entero. `POST /oauth/revoke`
   (RFC 7009) revoca el grant, cierra su sesión de Metabase y revoca el permiso de
   Google. Los códigos sólo se envían a `ALLOWED_REDIRECT_HOSTS` (por defecto
   `claude.ai`, `claude.com`) o a loopback; si no, un link armado podía llevarse el
   código de otra persona. Los tokens anteriores a los grants (credenciales dentro
   del JWT) ya no sirven: al desplegar, cada usuario reconecta una vez.
6. Con `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, "Continuar con Google" pasa por el
   gateway (`/oauth/google/start` → Google → `/oauth/google/callback`,
   `src/google-sso.ts`) con el cliente OAuth de Google **del propio Metabase** y acceso
   offline. Así el gateway guarda un refresh token de Google y, en cada refresh del
   JWT, revisa la sesión de Metabase y la renueva (`/api/session/google_auth`) si tiene
   más de `METABASE_SESSION_RENEW_DAYS` (1) o Metabase ya la rechaza, y **cierra la
   anterior** (`DELETE /api/session`): una sesión vale sus 14 días aunque se reemplace,
   así que sin cerrarla renovar seguido no acortaría nada. Metabase vence
   cada sesión a los 14 días (`MAX_SESSION_AGE`) y antes la conexión moría ahí sin
   remedio (IAD-1210). Una sesión muerta que no se puede renovar hace fallar el
   refresh con `invalid_grant` y revoca el grant, para que Claude pida reconectar en
   vez de fallar en cada tool. Sin esas dos variables queda el login de Google en el navegador, sin
   renovación.
7. Para armar dashboards completos (pestañas, layout, filtros conectados a variables
   SQL y verificación) están `put_dashboard_layout`, `manage_dashboard_tabs`,
   `set_dashboard_filters`, `run_dashcards` y `test_native_query`. Toda escritura del
   layout pasa por `MetabaseClient.putDashboardSafe`, que conserva las pestañas, manda
   sólo los campos que acepta el PUT, valida antes de escribir y devuelve
   `previous_revision_id` para `revert_dashboard`.

## Grupos de tools

Cada tool declara anotaciones MCP (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) según su grupo en `src/utils/tool-annotations.ts`: **lectura** (sólo
lee o corre queries), **escritura** (crea o edita sin perder nada) o **destructiva**
(borra, reemplaza o revierte, incluidas las conexiones de BD). `server.ts` las agrega al
registrar cada tool. Claude.ai usa esos grupos para que la organización o cada usuario
permita, pida confirmación o bloquee cada grupo; sin anotaciones todas caen en «Otras
herramientas». Una tool nueva tiene que entrar en un grupo: `tests/tool-annotations.test.ts`
falla si falta. `validate_database` no guarda nada, pero conecta a un host que elige quien
llama, así que va en escritura y no en lectura.

## Gotchas de Metabase 0.63

Verificados contra analytics.clay.cl (dashboard 621 y su copia de prueba 622):

- `PUT /api/dashboard/:id` aplica un diff: un dashcard que no viene en `dashcards` se
  **borra**, uno con id negativo se crea. Las pestañas funcionan igual, y mandar
  `dashcards` sin `tabs` **borra todas las pestañas**. Si hay pestañas, todo dashcard
  necesita `dashboard_tab_id`.
- En un mismo PUT se pueden crear pestañas con id negativo y apuntar dashcards a ellas
  (`dashboard_tab_id: -1`), incluidos textos con `card_id: null` e ids de dashcard
  negativos: Metabase asigna los ids reales y deja cada tarjeta en su pestaña.
- El PUT acepta en cada dashcard sólo `id, card_id, dashboard_tab_id, row, col, size_x,
  size_y, series, action_id, inline_parameters, parameter_mappings,
  visualization_settings`: el `card` anidado del GET hay que quitarlo. Grilla de 24
  columnas.
- Mapping de un filtro a una variable SQL: `target: ["variable", ["template-tag", "x"]]`
  **sin** tercer elemento; con `{"stage-number": 0}` responde «invalid tuple size».
- `GET /api/card/:id` devuelve MBQL 5: `dataset_query.stages[0].native` y
  `stages[0]["template-tags"]` como **lista**. Para cambiar el SQL se hace PUT de ese
  mismo `dataset_query` editado. El formato legacy usa `native.query` y
  `template-tags` como objeto.
- Una query nativa de MongoDB necesita `native.collection`; sin ella falla.
- Un filtro `date/month-year` con valor `2026-09` llega a una variable `date` como
  `'2026-09-01'`. `string/=` (lista fija: `values_source_type: "static-list"`,
  `values_source_config: {values: [...]}`) funciona con una variable `text`; su valor
  va como lista.
- Correr una tarjeta como la corre el dashboard:
  `POST /api/dashboard/:did/dashcard/:dcid/card/:cid/query` con `{parameters}`.
- Revisiones: `GET /api/revision/dashboard/:id`; revertir:
  `POST /api/revision/revert {entity: "dashboard", id, revision_id}`.

## Estructura de carpetas

```
src/
  server.ts              # entrypoint MCP (stdio y HTTP Stream), registro de tools y filtrado
  oauth-gateway.ts        # gateway Express OAuth2 (Authorization Code + PKCE) para clientes como Claude.ai
  credentials.ts          # credenciales de una conexión y su cifrado (AES-256-GCM)
  grant-store.ts          # grants en servidor: credenciales cifradas, rotación y revocación
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
  utils/
    config.ts             # carga y valida METABASE_URL / credenciales desde env vars
    tool-filters.ts       # modo de tools: flags --essential/--all/--read/--write o METABASE_MCP_TOOLS
    template-tags.ts      # {{variables}} del SQL nativo -> template tags (MBQL 5 y legacy)
    tool-annotations.ts   # grupo de cada tool (lectura, escritura, destructiva) -> anotaciones MCP
  types/                  # tipos de config y errores
docs/spec-google-sso-auth.md  # spec (no implementada del todo) para soportar sesión de Google SSO
Dockerfile / docker-compose.yml / docker-run.sh  # empaquetado para self-host vía Docker
smithery.yaml             # manifiesto para publicar en el registro Smithery (MCP)
.github/workflows/publish.yml  # única CI/CD: publica el paquete a npm en push a main
tests/                    # vitest (auth, config, metabase-client, oauth-gateway, google-sso,
                          #   grant-store, tool-filters, mongo-native-query, dashboard-safe-put,
                          #   dashboard-tabs, dashboard-layout, template-tags-filters, verification)
```

## Dependencias de infraestructura

| Recurso | Motor / detalle | Ambiente |
|---|---|---|
| Metabase (externo) | Instancia Metabase de Clay (ej. `analytics.clay.cl`), consumida vía REST API | prod y develop (según `METABASE_URL` / header `x-metabase-url`) |
| Registro npm | `@cognitionai/metabase-mcp-server` (scope del proyecto upstream, no `madeofclay`) | prod (publicación en cada push a `main`) |
| Google OAuth (externo) | Cliente OAuth del Google SSO de Metabase; el gateway lo usa con acceso offline. Necesita el redirect URI `https://data-dev.clay.cl/oauth/google/callback` autorizado en ese cliente y la pantalla de consentimiento Interna (en modo "Testing" los refresh tokens vencen a los 7 días) | develop (el único despliegue) |
| AWS Secrets Manager | `clay-data-secrets-{env}`: `METABASE_MCP_GATEWAY_SECRET` (firma y cifrado de los JWT) y `METABASE_GOOGLE_CLIENT_SECRET` (secreto del cliente OAuth de Google del proyecto Metabase; es el mismo para cualquier subdominio, así que no lleva el prefijo del MCP) | develop |
| EC2 `ai-agents-dev` (gracia-dev) | Host del servidor y del gateway (ver Deploy) | develop |

No hay bases de datos propias, colas SQS/SNS, buckets S3, tablas DynamoDB, Lambdas,
clusters EKS ni Terraform en este repo. El estado del gateway es: los grants en un
archivo local (`GRANT_STORE_PATH`, por defecto `./data/grants.json`, fuera de git;
sobrevive reinicios, y si se borra todos reconectan) y un `Map` en memoria de
códigos de autorización pendientes (TTL 10 minutos).

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
de los dos programas. El gateway necesita `GRANT_STORE_PATH` en un directorio
escribible por su usuario (el archivo lleva credenciales cifradas: no copiarlo ni
respaldarlo junto con `JWT_SECRET`). Rotar `METABASE_MCP_GATEWAY_SECRET` invalida
todos los grants y obliga a reconectar. No hay despliegue en gracia-prod.

El programa del HTTP Stream (`dist/server.js`, puerto 8011) puede cargar todas las
tools con `METABASE_MCP_TOOLS=all` en su `environment`; por defecto carga las `essential`.

**Gotcha detectado (no corregido en este levantamiento):** el `CMD` del `Dockerfile`
ejecuta `node dist/index.js`, pero el build y `package.json.main` generan
`dist/server.js` — el contenedor tal como está definido probablemente falla al iniciar.
