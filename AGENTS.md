# SDK-Bot: instrucciones para OpenCode

## Estructura

- `gateway/` es el proceso Node.js/Baileys; su entrada es `gateway/index.js`.
- `brain/` es el proceso Python/FastAPI; su entrada es `brain/main.py`.
- `gateway/panel/` es un tercer proceso independiente. Sirve `gateway/admin-web/` y proxifica `/api/*` al bus HTTP interno del gateway. Corre en `0.0.0.0:5201` (accesible por LAN/Tailscale en dev). **OAuth solo en producción:** el login Google se activa únicamente si `NODE_ENV=production` (o `PANEL_REQUIRE_AUTH=***, además de definir `PANEL_GOOGLE_CLIENT_ID`/`PANEL_GOOGLE_CLIENT_SECRET`. En desarrollo el panel queda **ABIERTO** (sin login) aunque haya credenciales; las rutas `/auth/*` solo existen con OAuth habilitado. La cookie de sesión se firma con HMAC-SHA256 (HttpOnly, Secure tras proxy, 12 h). `index.js` carga `gateway/panel/.env` automáticamente al arrancar. En dev el panel NO se expone vía el dominio público `panel.zer0x.org` (reservado para prod con Docker).
- En ejecución local arranca primero el brain (`:5100`), luego el gateway; el panel opcional usa `:5201`, el bus del gateway `:5400` y el status server `:5300`.
- `brain/.env`, `gateway/auth_info_baileys/`, las DB JSON, `brain/memory.db`, `gateway/queue/`, logs y locks contienen estado local o secretos; no los versionar ni usarlos como fixtures.
- `.env.tuning` sí está versionado y es leído por ambos componentes; las API keys deben permanecer en `brain/.env`.

## Instalación Y Verificación

- Primera instalación: ejecuta `cd brain && python3 -m venv venv && venv/bin/pip install -r requirements-dev.txt` y luego `cd gateway && npm ci`.
- Gateway: `cd gateway && npm run check` ejecuta exactamente `lint`, `typecheck` y luego `node --test`.
- Brain: `cd brain && venv/bin/ruff check . && venv/bin/python -m pytest tests/ -q`.
- CI usa Node 22 y Python 3.12; además de las comprobaciones anteriores ejecuta `bash ../deploy/linux/tests/install-smoke.sh` desde `gateway/`.
- Tests enfocados: `cd gateway && node --test tests/pipeline.test.js`; `cd brain && venv/bin/python -m pytest tests/test_memory.py -q`.
- Los tests del gateway redirigen sus DB con `SDK_CONTACTS_DB_PATH` y `SDK_SETTINGS_DB_PATH`; los tests del brain usan `BRAIN_MEMORY_DB`. Mantén ese aislamiento y nunca cambies rutas de producción en código fuente.

## Desarrollo Y Despliegue

- Desarrollo Linux: `bash deploy/linux/dev.sh manual todos` imprime los lanzamientos para terminales separadas; `manual brain`, `manual gateway` y `manual panel` ejecutan cada proceso en foreground.
- Producción Linux: `docker compose -f deploy/docker/compose.yml build && docker compose -f deploy/docker/compose.yml up -d`; verifica con `docker compose -f deploy/docker/compose.yml ps` y logs con `docker compose -f deploy/docker/compose.yml logs -f gateway`.
- `NODE_ENV=development`/`production` identifica el launcher, pero no es un interruptor funcional; el supervisor y las variables específicas (`BRAIN_API_BASE`, rutas de estado, hosts y puertos) distinguen ambos entornos.
- Los archivos `deploy/linux/sdk-bot-*.service` y `install.sh` quedan como alternativa systemd legacy; no son el camino de producción documentado.
- No ejecutes manualmente y mediante Docker/systemd el mismo componente: los locks de instancia única bloquean la segunda instancia y protegen la sesión de WhatsApp.
- `cd gateway && npm run reset` renueva la sesión/QR en desarrollo. `npm run clean` es un reset de fábrica destructivo manual: borra sesión, agenda, configuración, colas, memoria y logs, pero conserva `brain/profiles/`; en Docker usa `docker compose ... down -v` solo si realmente quieres borrar los volúmenes.

## Límites De Arquitectura

- Las decisiones de flujo de mensajes son puras y viven en `gateway/services/pipeline.js`; los efectos secundarios, buffers y serialización por chat viven en `gateway/handlers/messageHandler.js`.
- Los comandos admin se registran por módulos en `gateway/handlers/commands/` y se agregan al registro de `commandHandler.js`; no recrees un switch monolítico.
- Los errores de sintaxis de comandos deben usar `syntaxError()`/`COMMAND_USAGE`; texto de usuario interpolado en Markdown debe pasar por `sanitizeMarkdown()`.
- La persistencia de contactos y settings se maneja mediante `gateway/services/db.js` y sus rutas configurables; conserva el guardado diferido/atómico y el bloqueo de instancia.
- El router real del brain es Groq → OpenRouter → Gemini en `brain/providers.py`; si la documentación difiere, sigue el código y la configuración ejecutables.
- Los perfiles SOUL son Markdown en `brain/profiles/`; `default` es el fallback y no debe depender de DBs o archivos de runtime.
- En un despliegue nuevo el modo global seguro es `ignored_all`: un admin debe permitir contactos antes de que el bot responda.
