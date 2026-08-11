# 🗺️ Hoja de Ruta SDK-Bot (Guía de Sesiones Futuras)

> Documento vivo. Cada sesión se elige una fase, se trabaja por tareas checkbox, se verifica arrancando brain + gateway, y se commitea con mensaje descriptivo (`feat:` / `fix:` / `refactor:` / `docs:`).
> Última actualización: 2026-08-11 (Fase 3 cerrada, Fases 5 y 6 definidas).

---

## 📋 Resumen del Diagnóstico (2026-08-09)

### Bugs críticos detectados
- **B1. Condición de carrera en de-bounce:** `messageHandler.js:363` borra el buffer ANTES de llamar a `processAIChat` (puede tardar 90s). Si el cliente escribe durante la llamada, se crea un segundo buffer del mismo chat → 2 respuestas simultáneas, fuera de orden, riesgo de baneo.
- **B2. Fuga de memoria en `messageBuffers`:** `activePresences` tiene limpieza cada 10 min, pero `messageBuffers` (Map de chat con buffers) **nunca se limpia**. Buffers huérfanos (bot pausado, handoff, caída de conexión) quedan en RAM para siempre.
- **B3. Caché de perfiles nunca expira:** `brainService.js:228` (`cachedProfiles`) queda stale para siempre → un perfil nuevo importado no aparece hasta reiniciar el gateway.
- **B4. `fetchStatus` probablemente roto:** `metadataService.js:188` usa `sock.fetchStatus(jid)` que fue eliminado en versiones recientes de Baileys. El error se traga en silencio (`catch {}`) → la Bio jamás se actualiza y nadie se entera.
- **B5. Respuestas masivas sin paginar:** `/exportar`, `/listas` y `/perfil ver` envían todo el contenido de golpe → con libretas grandes (>1000 contactos) WhatsApp rechaza el mensaje ("message too long") y solo se loguea el error sin feedback al admin.
- **B6. Sin límite de concurrencia:** N chats pueden disparar N llamadas de IA + N simulaciones de tecleo en paralelo → riesgo real de rate-limit/ban de Meta.

### Deuda técnica / refactor
- **R1. O(n²) en storage:** `upsertContactMetadata` y `bulkUpsertContactsMetadata` llaman `cleanContactsDB()` (O(n)) y luego buscan claves con `Object.keys().find()` (O(n)) por cada registro. Con `syncFullHistory: true` y 5000+ contactos, el arranque y cada mensaje son lentos. Necesita índices (Map phone→key, Map lid→key).
- **R2. `settings_db.json` sin ejemplo:** no hay `settings_db.json.example` (a diferencia de los demás).
- **R3. Archivos legacy:** `allowed_numbers.json.example`, `ignored_numbers.json.example` y las funciones/archivos de listas externas son código muerto (AGENTS.md lo confirma). Limpiar.
- **R4. `PROFILES = None` en `profiles.py:173`** — variable fantasma de la versión antigua.
- **R5. Sin tests ni lint** (`npm test` es placeholder). `AGENTS.md` lo documenta como deuda.
- **R6. Sin logs estructurados:** todo es `console.log` — imposible debuggear producción sin archivos de log rotados.
- **R7. Config hardcodeada:** `BRAIN_API_URL` y puerto 8000 fijos en `config.js`/`main.py`. Sin variables de entorno.

### Seguridad
- **S1. Brain API sin autenticación** y escuchando en `0.0.0.0:8000` → cualquiera en la red puede consumir IA (costo), leer/borrar memoria y subir perfiles. Debe bindear a `127.0.0.1` o exigir API key.
- **S2. Sin rate-limiting** en el brain ni en el gateway.

### Docs desactualizados (importante, causa confusiones)
- **D1.** README y PLAN-ARQUITECTURA dicen cascada **OpenRouter → Groq → Gemini**; el código real es **Groq → OpenRouter → Gemini** (`providers.py`). AGENTS.md ya lo nota.
- **D2.** PLAN dice modelos `openai/gpt-oss-20b:free` y `gemini-1.5-flash`; el código usa `openrouter/free` y `gemini-flash-lite-latest`.
- **D3.** README lista solo perfiles `default/lucia/mateo`; existen también `ventas/cobranzas/recepcion`.

---

## 🗂️ Fases

### ✅ Fase 0 — Bugfixes rápidos y saneamiento (sesión 1)
Objetivo: estabilizar lo que ya existe sin tocar arquitectura. **Estado: COMPLETADA (2026-08-09/10).**

- [x] **B1** — Serializar `processAIChat` por chat: `chatInFlight` (Set) impide 2 llamadas de IA simultáneas; los mensajes durante una llamada se acumulan y se reprograman al terminar (`createBufferTimeout` en `messageHandler.js`).
- [x] **B2** — Limpieza periódica de `messageBuffers` (TTL 15 min via `lastActivity`, respeta chats con IA en curso).
- [x] **B3** — TTL de 60s al caché de perfiles del gateway + invalidación inmediata tras `/update`.
- [x] **B4** — `fetchStatus` verificado en Baileys 7.0.0-rc14: **devuelve un ARRAY** `[{status,setAt,id}]`; el código leía `.status` del array → bio nunca se guardaba. Corregido (`metadataService.js`).
- [x] **B5** — `chunkAdminText()` (máx 2800 chars/msg con sufijo `(n/N)`) aplicado a todas las respuestas del admin (`commandHandler.js`).
- [x] **B6-bonus** — `brainService.js` ahora verifica `response.ok` y reporta el `detail` real de FastAPI en vez de "undefined" (los 422 de validación se diagnostican de inmediato).
- [x] **R3** — Eliminados del repo `allowed_numbers.json.example`, `ignored_numbers.json.example` e `ignored_numbers.json` (legacy, sin referencias).
- [x] **R2** — Creado `settings_db.json.example`.
- [x] **R4** — Quitado `PROFILES = None` y `global PROFILES` muertos en `profiles.py`.
- [x] **D1/D2/D3** — README.md y PLAN-ARQUITECTURA.md sincronizados: cascada real **Groq → OpenRouter → Gemini**, modelos reales (`llama-3.3-70b-versatile`, `openrouter/free`, `gemini-flash-lite-latest`), lista completa de perfiles.
- [x] **AGENTS.md** — Actualizado: nota de legacy removida, documentado B1/B2.
- [x] **F0-extra: Protección de instancia única** (pedido del admin): lock con PID en brain (`.brain.lock`) y gateway (`.gateway.lock`, gitignored). Segunda instancia → mensaje claro y exit(1). `--restart` cierra el anterior y levanta el nuevo. Locks huérfanos se auto-limpian. Detalle técnico: uvicorn re-emite la señal capturada al cerrar (`signal.raise_signal`), matando el proceso sin `finally`/`atexit`; se registró handler propio de SIGTERM/SIGINT antes de `uvicorn.run()` que limpia el lock.
- [x] **Verificación:** sintaxis JS/PY OK; brain `/chat` real vía Groq OK; `processAIChat` (código real) con payload idéntico al gateway OK; brain + gateway arrancados en vivo, conexión WhatsApp OK, admin detectado.

> 📌 Nota de la sesión: durante las pruebas apareció un `422` transitorio del brain (nunca reproducible con payload idéntico; probablemente por procesos brain duplicados durante la depuración). La mejora B6-bonus hará que cualquier 422 futuro muestre la causa exacta.

### 🟡 Fase 1 — Estabilidad y operabilidad (sesiones 2-3)
Objetivo: que el sistema sobreviva solo y sea debuggeable.

- [x] **B6 / R7** — Pool de concurrencia global (`services/aiQueue.js`): máx 3 `processAIChat` simultáneos con cola FIFO. Verificado con 10 tareas (máx 3 activas, sin cruces).
- [x] **R6** — Logger rotado por tamaño (5MB, 3 backups): gateway `logs/gateway.log` (pino + pino-roll, categorías `cat: AI/DEBOUNCE/PRESENCIA/COMANDO/ERROR/CORE/INSTANCIA/STORAGE`), brain `logs/brain.log` (`logging_setup.py`, RotatingFileHandler). `reset-session.js` sigue con console (interactivo).
- [x] **Reconnect robusto** — En `index.js`: `sock.end()` del socket viejo antes de recrear, guard `currentSocket !== sock` para ignorar eventos de sockets reemplazados, y backoff exponencial 2s→5s→15s→60s (topado) con reset en `open`.
- [x] **Watchdog** — Plantillas systemd en `deploy/` (`sdk-bot-brain.service`, `sdk-bot-gateway.service` con `Requires` del brain + `install.sh`). Pendiente de instalar en el VPS.
- [x] **R1 (parcial)** — Índices RAM en `storageService.js`: `phoneIndex`, `lidIndex`, `digitsIndex` (Mapas reconstruidos en `saveContactsDB`/`loadDataOnStartup`); `findExistingKey()` O(1) en upserts y `extractUserMetadata`, índice de dígitos + fallback scan en comandos admin.
- [x] **Retry 1x en brain** — `requestBrain()`: reintento solo en errores transitorios (red/timeout/5xx/proveedor); los 4xx (422 validación) NO se reintentan (son bugs).
- [ ] **Verificación pendiente en vivo:** matar el gateway a mitad de conversación y ver reconexión con backoff (lógica verificada por código; requiere desconexión real de WhatsApp).

### ✅ Fase 2 — Seguridad y privacidad (sesión 4)
Objetivo: no dejar expuestos costos, memoria ni escritura de archivos.

- [x] **S1** — Bind de uvicorn a `127.0.0.1` (el gateway está en la misma máquina) + `API_KEY` opcional en header `X-API-Key` verificada por middleware FastAPI. El gateway lee la key del mismo `brain/.env` (`getBrainApiKey()` en `config.js`), así que se pega UNA sola vez. `BRAIN_HOST` permite override.
- [x] **S2** — Rate-limit por `user_id` en el brain (10 llamadas/min en `/chat`, env `BRAIN_RATE_LIMIT_PER_MIN`, se puede desactivar con `BRAIN_RATE_LIMIT_ENABLED=0`) y 20 comandos/min por admin en el gateway (`services/rateLimit.js`, ventana deslizante).
- [x] **Validar nombres en `/exportar`/`/buscar`** — `sanitizeMarkdown()` en `commandHandler.js`: neutraliza caracteres de formato de WhatsApp (`* _ ` ~`) y saltos de línea antes de interpolar nombres en mensajes markdown.
- [x] **Revisar `downloadMediaMessage`** en `handleProfileUpload` (`commandHandler.js`) — en Baileys 7.0.0-rc14 la firma es `(msg: WAMessage, type, options, ctx?)`; `ctx.reuploadRequest` debe ser FUNCIÓN y `ctx.logger` un logger real (antes: booleano + undefined → TypeError si el media daba 404/410).
- [x] **Verificación:** POST /chat desde la IP LAN → conexión rechazada (bind 127.0.0.1 verificado con `ss`); `/profiles/import` sin key → 401, con key → 400 (auth OK); 11ª llamada de `/chat` → 429.
- [ ] **Pendiente en vivo:** subir un `.md` al self-chat con `/update` para confirmar la descarga real del documento (requiere WhatsApp).

### ✅ Fase 3 — Refactor estructural y calidad (sesiones 5-7)
Objetivo: deuda técnica grande, testes y CI.

- [x] **Split de `storageService.js`** — hoy hace de todo: I/O atómico, cache, estados, perfiles, agenda. Separar: `db.js` (I/O), `contactsRepository.js`, `stateService.js`.
- [x] **Split de `commandHandler.js`** (641 líneas) — mover a `commands/` con módulos por categoría (chat, listas, agenda, sistema, perfiles) + tabla de registro de comandos.
- [x] **Extraer reglas de negocio del pipeline** — el flujo del mensaje (anti-bucle, self-chat, estados, handoff, de-bounce) a un módulo `pipeline.js` testeable sin Baileys (inyectar `sock` fake).
- [x] **Tests unitarios** — `node:test` (ya incluido en Node, sin dependencias): `splitIntoHumanBubbles`, `getAdaptiveDebounceMs`, `parsePhoneOrLid`, `getCountryFromPhone`, `cleanContactsDB`, parser de `profiles.py` (pytest).
- [x] **Lint** — ESLint (gateway) + `ruff` (brain) + script `npm run lint` y `make lint`.
- [x] **CI** — GitHub Actions: `npm test` + `pytest` + lint en cada push/PR (`.github/workflows/ci.yml`: 2 jobs paralelos — gateway Node 22 + brain Python 3.12).
- [x] **JSDoc estricto (typecheck)** — opción elegida en vez de ESM: `tsc -p jsconfig.json` (`checkJs` + `strictNullChecks`) sobre los módulos núcleo con `// @ts-check`, typedefs compartidos (`ContactRecord`, `UserMetadata`, `SettingsDB`, `CommandDef`) y `errMsg()` para catches tipados `unknown`. Corrigió bugs latentes (rutas de /tmp leakadas a prod, nullability de targetKey). Script `npm run typecheck` + paso en CI.
- [x] **Verificación:** `npm test` y `pytest` verdes en CI; el bot funciona igual tras refactor (prueba de humo completa). Checkboxes marcados retroactivamente en 2026-08-11: el trabajo ya estaba hecho (módulos split, 55 tests gateway, eslint/ruff en CI).

### 🟣 Fase 4 — Features y escala (sesiones 8+, siguiente gran fase)
Objetivo: cumplir el objetivo del PLAN: **N bots, cada uno con su número, memoria aislada y perfil SOUL**.

- [x] **Memoria persistente** — `brain/memory.py` migrado a SQLite (`brain/memory.db`, gitignored, lazy init): `append_exchange` incremental, `get_history` con ventana temporal de 24h (sweep por chat + barrido global cada 50 escrituras), truncado por cantidad (15 msgs) y por tokens aproximados (chars/4, máx 2000). `/limpiar` sigue funcionando (reset-memory). Verificado en prod: el bot recordó el nombre tras reiniciar el brain.
- [x] **Memoria aislada multi-bot** — esquema `messages(bot_id, user_id, role, content, created_at)` con índice `(bot_id, user_id, created_at)`; el gateway envía `bot_id` = su propio número (`ADMIN_PHONE`/`ADMIN_LID`). Verificado: mismo `user_id` en bots distintos no comparte memoria y el reset-memory solo afecta al bot indicado.
- [x] **Salud y métricas** — brain `GET /health` (uptime, proveedores, rate-limit, stats de DB de memoria, sin API key) y gateway `services/statusServer.js`: HTTP local `127.0.0.1:3100` (env `STATUS_PORT`), `GET /status` (conexión, bot, contactos, contadores, buffers/presencias, pool de IA, rate-limiter, memoria) y `GET /health`. Para futura dashboard; nunca exponer a la red.
- [x] **Cola persistente de mensajes** — si el brain está caído (error transitorio), el mensaje del cliente se encola en disco (`gateway/queue/pending_messages.jsonl`, JSONL, límite 50 items env `SDK_MESSAGE_QUEUE_MAX`, TTL 24h) y se responde automáticamente cuando el brain vuelve. `services/messageQueue.js` (persistencia atómica tmp+rename, `attempts` máx 5 antes de descartar). El flush lo dispara un brain call exitoso (debounce 3s) + timer de red de seguridad cada 30s; respeta `chatInFlight` y el pool global. Alerta al admin con throttle de 15 min.
- [x] **Respuestas programadas / broadcast** — `/broadcast <texto>` (confirmación en 2 pasos con "si"/"cancelar") y `/programar <HH:MM> <texto>` (hoy si la hora no pasó, si no mañana). `services/broadcastService.js`: worker de 1 mensaje/tick (10s, pacing anti-ban), límite diario por contacto (env `SDK_BROADCAST_DAILY_LIMIT`, default 2), persistencia atómica en `gateway/broadcast_db.json` (env `SDK_BROADCAST_DB_PATH`) con cursor resume-safe tras reinicio, omite ignorados/handoff/no-agenda, `/broadcast cancelar` y `/broadcast estado`, notificación al admin al terminar. Métrica `broadcast` en GET /status. **Kill-switch (F4-P6): apagados por defecto, toggle `/broadcast on|off` (persistido en `broadcast_db.json`), arranque con `SDK_BROADCAST_ENABLED=1` en el service systemd, al apagar se cancelan los pendientes.** 11 tests.
- [ ] **~~Multitenant~~ (descartado, anotación)** — decisión del admin (2026-08-10): NO implementar config multi-bot en este repo. Para más de un bot se levantan instancias independientes del repo (cada una con su propio número, memoria y perfil, totalmente aisladas). NOTA PARA FUTURAS AMPLIACIONES: si este repo se clona con otro fin y se necesita multi-tenant, el diseño sería `config/<bot_id>.json` (número, perfil default, admin, debounce) + aislamiento por `bot_id` (ya existe en `brain/memory.py` y en `payload.bot_id` del gateway).

### 🟡 Fase 5 — Recordatorios y To-Do (OPCIONAL — futuro)
Objetivo: el admin gestiona sus pendientes y avisos desde el self-chat. Reusa el worker de `broadcastService.js` (tick 10s, solo con conexión) en vez de duplicar timers.
> Decisión del admin (2026-08-11): **pospuesta**. La prioridad es Fase 6 (Administración web). Se implementará si sigue siendo útil después; los checkboxes quedan como backlog.

- [ ] **Recordatorios únicos** — `/recordar <HH:MM> <texto>` (hoy si la hora no pasó, si no mañana): al llegar la hora, el gateway envía el aviso al self-chat del admin. Confirmación en 2 pasos como `/programar`, persistencia atómica (jsonl o `reminders.json`), lista `/recordar listar` y borrado `/recordar borrar <n>`.
- [ ] **Recordatorios recurrentes** — sintaxis `/recordar <HH:MM> diario|lunes,miercoles <texto>` (días de la semana): se reprograman solos al dispararse. Frecuencias: diario, días concretos, semanal.
- [ ] **To-Do list** — `/todo` (lista con checkboxes), `/todo + <texto>`, `/todo done <n>`, `/todo rm <n>`, `/todo clear`. Persistido en `settings_db.json` (sección `todos`).
- [ ] **Avisos a contactos** — opcional: `/recordar <HH:MM> <num> <texto>` (citando o con número) envía el aviso a un contacto en vez del admin (usa el envío directo de `broadcastService`, respetando el límite diario).
- [ ] **Métrica y estado** — `reminders` y `todos` en GET /status; notificación al admin si un recordatorio falla (throttle 15 min como la cola).
- [ ] **Tests** — unidad (parseo de frecuencia/días, reprogramación, persistencia, límites) + worker de recordatorios con socket fake; 8-10 tests.
- [ ] **Verificación en vivo** — programar un recordatorio para 2 minutos después y confirmar el aviso en self-chat; repetir con recurrencia diaria.

### 🟠 Fase 6 — Administración web (dashboard interactiva)
Objetivo: panel web local (HTTP en `127.0.0.1`, puerto propio) con pairing/reset, agenda, comandos admin y logs en vivo de brain + gateway.
> **Arquitectura (decisión del admin, 2026-08-11): el motor del bot NO cambia.** El panel es un módulo opcional (`services/adminWebServer.js`, montado solo con `SDK_ADMIN_WEB_ENABLED=1` mediante un hook aditivo de ~3 líneas en `index.js` con `?.` opcional) que **consume** los servicios existentes como un gateway externo: `commandHandler` (sock virtual), `contactsRepository`/`stateService`, `statusServer`, logs por archivo. Sin el env, el bot arranca y funciona byte a byte como hoy. Pairing/reset reutiliza el CLI existente (`reset-session.js`) como proceso hijo — el motor no conoce la existencia del panel.

- [ ] **Módulo opcional + API de acciones + UI básica** — `services/adminWebServer.js` (nuevo, consumidor): hook env-guarded en `index.js`; endpoint que ejecuta los comandos admin existentes (pausar/reanudar, perfil, broadcast on/off, listas, etc.) vía el dispatcher de `commandHandler` con sock virtual (la respuesta del comando va al HTTP). Front estático (HTML+JS puro, sin build) con tarjetas de estado, auto-refresh por polling 5-10s y terminal de comandos. Verificación: sin `SDK_ADMIN_WEB_ENABLED` el bot funciona idéntico.
- [ ] **Agenda de contactos** — tabla con búsqueda (reusa `findKeyByDigits`/`findExistingKey`), filtro por estado, edición de estado (permitir/ignorar) vía `stateService`, cambio de perfil por contacto, detalle (bio, LID). Todo consumiendo servicios existentes.
- [ ] **Logs en vivo (SSE)** — `GET /api/logs` con Server-Sent Events: tail de `gateway/logs/gateway.log` y `brain/logs/brain.log` (brain en la misma máquina), re-open del fd al rotar (pino-roll 5MB × 3), filtro por componente/nivel, pretty del JSON de pino client-side. El bot no se entera: el panel lee los archivos.
- [ ] **Pairing y reset desde el panel** — sin tocar el motor: el panel spawnea `reset-session.js` (CLI existente) como proceso hijo; el QR del evento `qr` se reenvía al panel por SSE (línea aditiva en el handler de `qr` solo si el módulo está cargado); opcionalmente `requestPairingCode(numero)` (código de 8 dígitos) con la misma línea aditiva. Reset = borrar `auth_info_baileys/` (respetando el lock de instancia) + relanzar el gateway.
- [ ] **Seguridad** — sigue en `127.0.0.1` (nunca expuesto); token opcional `STATUS_TOKEN` para escrituras (header `X-Status-Token`) + validación de `Origin`; acceso remoto documentado vía túnel SSH (`ssh -L <puerto>:localhost:<puerto>`).
- [ ] **Tests + docs** — API y sock virtual con `node:test` (requester contra el server local, sin WhatsApp), SSE/rotación con archivos fake, docs en AGENTS.md (env, endpoints, token, túnel). Verificación: bot sin el módulo montado pasa el `npm run check` sin cambios.

---

## 🧭 Cómo avanza cada sesión (metodología)

1. **Abrir la sesión leyendo `ROADMAP.md` + `AGENTS.md`** (siempre están actualizados al commit más reciente).
2. **Elegir la fase activa** (la primera con checkboxes pendientes). Trabajar de arriba hacia abajo dentro de la fase.
3. **Por cada tarea:**
   - Arrancar brain + gateway y reproducir el bug antes de tocar código (evidencia en logs).
   - Implementar con el estilo del repo (español, comentarios solo cuando aportan, módulos pequeños).
   - Verificar el fix en caliente y con la prueba de humo de la fase.
4. **Commit con prefijo semántico:** `fix(B1): serializar IA por chat`, `refactor(storage): índices phone/lid`, `docs: sincronizar cascada de proveedores`.
5. **Al terminar la fase:** marcar todos los checkboxes, actualizar la fecha en el header, y escribir en AGENTS.md cualquier gotcha nuevo descubierto.
6. **Al empezar la siguiente fase:** nuevo conjunto de checkboxes y sesión dedicada.

## 🔥 Orden recomendado de ataque para la PRÓXIMA sesión

> Fases 0-4 completas. Prioridad actual: **Fase 6 (Administración web)** en el orden de sus checkboxes: API de acciones + UI → agenda → logs SSE → pairing/reset → seguridad → tests. Fase 5 (Recordatorios) queda como opcional/futura (decisión del admin 2026-08-11). Pendientes transversales (verificación real, requieren WhatsApp): reconexión con backoff a mitad de conversación (Fase 1) y `/update` con `.md` real (Fase 2).
