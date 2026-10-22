# 🤖 SDK-Bot

**Plataforma Multi-Canal (WhatsApp & Telegram) 100% Custom, Smart Sync & Automated Handoff** — Gateway de mensajería modular con arquitectura Adapter Hub en Node.js + Cerebro IA en Python FastAPI con router multi-proveedor (Groq → OpenRouter → Gemini).

## Bandeja de conversaciones

La bandeja nueva está implementada como una aplicación React/TypeScript en
`apps/panel/web`. Se abre en `/inbox`, lee conversaciones e historial desde la
API autenticada y recibe actualizaciones en vivo. También permite tomar control,
responder como operador y devolverlo a la IA con selección explícita de mensajes
pendientes. El panel anterior se conserva en `/`; la nueva bandeja está apagada
por defecto y requiere `PANEL_CONVERSATIONS_UI_ENABLED=true`. La aceptación F6.4
sigue parcial: se ejercitaron takeover, respuesta humana, entrada durante `human`
y release en WhatsApp; quedan pendientes la verificación live del contexto, la
revisión de teclado y móvil, y el smoke de Telegram
([F6.1](docs/F6.1-ENVIO-HUMANO.md), [F6.2](docs/F6.2-REANUDACION-PENDIENTES.md),
[F6.3](docs/F6.3-FLUJO-CONVERSACION.md), [F6.4](docs/F6.4-SMOKE-CANAL.md)).

### Compilar y ejecutar localmente

Usa Node.js 22.13.0 o superior. Desde la raíz del repositorio:

```bash
# Instala por separado los paquetes del gateway y del panel si faltan o cambió un lockfile
(cd apps/gateway && npm ci)
(cd apps/panel && npm ci)

# Recompila después de cambiar la interfaz; el launcher no hace el build
(cd apps/panel && npm run build)

# Arranca el stack local con /inbox habilitada
PANEL_CONVERSATIONS_UI_ENABLED=true bash deploy/linux/dev.sh up all
```

El proceso existente del panel sirve el artefacto en
<http://localhost:5201/inbox/>; no hace falta levantar un servidor Vite aparte.
`up all` detiene y vuelve a iniciar los servicios locales. Para consultar su
estado o detenerlos:

```bash
bash deploy/linux/dev.sh status
bash deploy/linux/dev.sh down
```

Docker compila la interfaz durante el build de la imagen. La activación por
Compose y el estado funcional de la bandeja están descritos en
[README de Docker](deploy/docker/README.md), [F4.2: lectura HTTP](docs/F4.2-LECTURA-HTTP-REAL.md)
y [F4.3: actualización en vivo](docs/F4.3-STREAM-INBOX.md).

- [Contratos v1 y comandos del workspace](packages/contracts/README.md)
- [Sesión y frontera autenticada v1](docs/FRONTERA-AUTENTICADA-V1.md)
- [Arquitectura y contratos de destino](docs/ARCHITECTURE.md)
- [Decisión arquitectónica ADR-005](docs/adr/005-plataforma-conversaciones.md)
- [Hoja de ruta por entregas](docs/ROADMAP.md)
- [Estado y próxima tarea](docs/SESSION-STATE.md)
- [Backlog de bugs y política de reparación](docs/BACKLOG.md)
- [Archivo SQLite con worker y evidencia F2A](docs/ARCHIVO-CONVERSACIONES-F2A.md)
- [Captura base WA live/history y límites F2B.2](docs/CAPTURA-WHATSAPP-F2B2.md)
- [Transcripciones durables y multimedia F2B.3](docs/MULTIMEDIA-WHATSAPP-F2B3.md)
- [Dueño único y descubrimiento Telegram F2C.1](docs/TELEGRAM-DUENO-UNICO-F2C1.md)
- [Captura Telegram y cursor durable F2C.2](docs/TELEGRAM-CAPTURA-F2C2.md)
- [Experimento SQLite probado y compatibilidad](docs/SQLITE-SPIKE.md)
- [Especificación operativa v1](docs/SPEC-OPERATIVA-V1.md) y [criterios de validación](docs/VALIDACION-V1.md)
- [Prompt para continuar en otra sesión](docs/PROMPT-CONTINUIDAD.md)

---

## 🎯 Características Principales

- **🔌 Arquitectura Adapter Hub Multi-Canal:** Conexión simultánea a múltiples redes de mensajería (**WhatsApp** vía Baileys y **Telegram** vía Bot API Polling) normalizadas mediante `StandardMessage` e IDs compuestas (`whatsapp:<jid>`, `telegram:<chat_id>`).
- **🤝 Derivación a Humano (Single-User Handoff):** Si un cliente pide *"hablar con un asesor"*, la IA se pausa **únicamente para ese cliente** y notifica al Admin en Self-Chat (`/auto <num>` o `/a` para reactivar, `/handoff <num>` o `/h` para pausar).
- **🧠 De-bounce Queue Adaptativo Estocástico:** Acumula mensajes consecutivos con temporizador estocástico adaptativo (5s-7s en mensajes cortos, 7.5s-12s en textos largos/múltiples, con capas estocásticas de ocupación/distracción de 1-2 min al 12% y 3-4 min al 5%). Si el usuario escribe despacio (`composing`), los temporizadores se renuevan continuamente sin cortar la idea del cliente.
- **⏱️ Auto-Expiración de Escritura (5.0s):** Si el cliente se arrepiente y borra lo que escribía sin enviar evento de pausa, el estado expira automáticamente a los 5.0s (`TYPING_TTL_MS`) y arranca el temporizador de silencio.
- **🧠 Memoria de Conversación Persistente (2 etapas, web-like):** El cerebro guarda el historial en SQLite (aislado por canal+usuario, ventana de 7 días / sin tope de cantidad / ~5000 tokens). Al detectar que el cliente **empieza a escribir** (`composing`), el gateway **precarga el contexto de ese chat** (señal de intervención igual al cliente web: "abre el chat y ya sabe de qué va") con una ventana reciente acotada (25 mensajes por defecto, `GATEWAY_PRELOAD_*` en `.env.tuning`). Cuando el mensaje **llega**, la respuesta usa el contexto **COMPLETO** (7d / 5000 tok) del cerebro. La precarga es solo señal y NO se inyecta en la respuesta. Tunable vía `.env.tuning`.
- **🛡️ Simulación Humana Ultra-Realista (Multi-Bubble & Jitter Rate Limiter):** 
  - Simula tiempo de **lectura/pensamiento** inicial (800ms - 3.3s) antes de encender el teclado.
  - Velocidad de tecleo natural a ritmo humano (7 a 10 char/s, 100ms - 135ms por carácter) con **varianza aleatoria estocástica (jitter)** para evadir algoritmos de detección de Meta (1.5s a 16s máximo por globo).
  - Fragmenta respuestas largas en **varios globos de chat secuenciales (Multi-Bubble)** de ~220 caracteres con micro-pausas interactivas de 1.0s a 2.2s.
- **🔀 Extracción Automática por Cita (Reply/Quote Extraction):**
  - Al responder (citar) cualquier mensaje de alerta o de un cliente en Self-Chat con un comando (ej: `/a`, `/h`, `/c`, `/n Pedro`), el sistema extrae automáticamente el teléfono o LID del texto citado.
- **⚡ Cascada Multi-Proveedor & Timeout de 90s:**
  - Cascada automatizada con 90s de timeout HTTP global: **Groq** (`llama-3.3-70b-versatile`, 25s) → **OpenRouter** (`openrouter/free`, 25s) → **Google Gemini** (`gemini-flash-lite-latest`, 40s).
- **🌎 Detección Automática de País e Idioma Nativo:**
  - Cobertura completa de prefijos telefónicos de toda América (Sur, Centro, Norte y Caribe) y Europa.
  - Inyección automática del **idioma del cliente** (Portugués, Inglés, Francés, Alemán, Italiano, Neerlandés, etc.) al prompt de la IA para ofrecer atención en su idioma nativo si es diferente al español.
- **🚨 Alertas Silenciosas de Error al Self-Chat / Telegram Admin:** 
  - Los errores técnicos o caídas de la IA **nunca se envían al cliente**. 
  - En su lugar, el sistema notifica en privado al canal de administración con el diagnóstico explícito y comandos rápidos.
- **🗂️ Motor de Estados Centralizado (`contacts_db.json` & `settings_db.json`):**
  - Persistencia de `savedName` (Agenda), `pushName` (Público), `phone`, `lid`, `country`, `language`, `profilePicUrl` HD, `bio`, `isBusiness`, config de Telegram y `estado` (`permitido`, `ignorado`, `handoff`, `neutro`).
  - Refresco inteligente TTL de 24 horas para foto y biografía.
  - Inserciones masivas ultra-rápidas en lote (`bulkUpsertContactsMetadata`).
- **🚀 Re-Sincronización Automatizada (`npm run reset`):** Script `reset-session.js` para limpiar sesión de WhatsApp y escanear un QR nuevo con descarga masiva de libreta.

---

## 📁 Estructura del Proyecto

```
SDK-Bot/
├── apps/gateway/                 # Código del Gateway y su bus interno
│   ├── index.js                  # Orquestador del Hub (adapters, pipeline, bus interno :5400)
│   ├── core/                     # Interfaces abstractas (ChannelAdapter, StandardMessage)
│   ├── adapters/                 # Adaptadores de red (whatsappAdapter, telegramAdapter)
│   ├── reset-session.js          # Script de re-sincronización de libreta (npm run reset)
│   ├── reset-clean.js            # Reset limpio de fábrica F7 (npm run clean)
│   ├── config.js                 # Estado global, URLs y registro anti-bucle
│   ├── tuning.js                 # Variables de afinación y rendimiento
│   ├── store/
│   │   └── chatStore.js          # Store RAM de mensajes de Baileys (precarga web-like)
│   ├── services/
│   │   ├── internalBus.js        # Bus interno HTTP (:5400) para desacoplar el gateway del panel
│   │   ├── db.js                 # Persistencia atómica de contacts_db y settings_db
│   │   ├── contactsRepository.js # Gestión de agenda, búsqueda O(1) e índices RAM
│   │   ├── contactSyncQueue.js   # Cola de sincronización de contactos por chunks
│   │   ├── messageSyncQueue.js   # Cola de sincronización de mensajes de historial por chunks
│   │   ├── messageQueue.js       # Cola persistente en disco para caídas del brain
│   │   ├── broadcastService.js   # Mensajes programados y difusión masiva segura
│   │   ├── stateService.js       # Gestión de estados (permitido/ignorado/handoff/neutro)
│   │   ├── metadataService.js    # Smart Delta Sync (TTL 24h), Phone/LID dual, Foto HD, Bio y Países
│   │   ├── statusServer.js       # Métricas locales en HTTP (:5300)
│   │   ├── factoryReset.js       # Motor único de reset de fábrica F7
│   │   └── brainService.js       # Cliente HTTP REST + Simulación Humana (Typing Delay & Multi-Bubble)
│   ├── handlers/
│   │   ├── commandHandler.js     # Dispatcher modular de comandos admin con extracción de citas
│   │   ├── commandHelpers.js     # Sanitización, help de comandos y utilidades
│   │   ├── commands/             # Comandos modulares (/ia, /humano, /perfil, /broadcast, /estado, etc.)
│   │   └── messageHandler.js     # Pipeline de mensajes, De-bounce estocástico, Handoff y Presencia RAM
│   ├── contacts_db.json          # Base de datos centralizada de contactos y estados (gitignored)
│   ├── settings_db.json          # Configuración global del bot (gitignored)
│   ├── settings_db.json.example  # Plantilla de configuración global
│   ├── *.json.example            # Plantillas de ejemplo para despliegues limpios
│   └── auth_info_baileys/        # Sesión y estado de WhatsApp (gitignored)
├── apps/panel/                   # Panel Web — proceso independiente (puerto 5201)
│   ├── index.js                  # Servidor HTTP proxy hacia el bus interno y estáticos
│   ├── public/                   # Frontend legacy modular (dashboard, pairing, Telegram, contactos)
│   └── web/                      # Bandeja React/TypeScript/Vite
├── gateway/                      # Estado runtime (sesión, DB, credenciales, logs y locks)
├── brain/                        # Código y estado de la Capa de Inteligencia (Python + FastAPI)
│   ├── main.py                   # Aplicación FastAPI modularizada (/chat, /reset-memory, /profiles, :5100)
│   ├── config.py                 # API Keys y modelos (Groq, OpenRouter, Gemini)
│   ├── memory.py                 # Gestor de memoria persistente SQLite (brain/memory.db)
│   ├── providers.py              # Router multi-proveedor (Groq 25s → OpenRouter 25s → Gemini 40s)
│   ├── profiles.py               # Motor de perfiles SOUL en caliente
│   ├── profiles/                 # Perfiles SOUL editables en Markdown (default, lucia, mateo, cobranzas, recepcion)
│   ├── .env                      # API Keys (gitignored)
│   └── requirements.txt          # Dependencias Python
├── deploy/                       # Scripts y configuraciones de despliegue por plataforma
│   ├── docker/                   # Producción Linux: Docker Compose (brain, gateway, panel)
│   ├── linux/                    # Lanzamiento manual dev y alternativa systemd legacy
│   ├── termux/                   # Scripts y servicios runit para Android (Termux)
│   └── windows/                  # Scripts batch para Windows (startBrain.bat, startGateway.bat)
├── docs/                       # Documentación Técnica
│   ├── ARCHITECTURE.md           # Plan de Arquitectura Completo
│   ├── ROADMAP.md                # Hoja de ruta de fases (guía de sesiones)
│   ├── adr/                      # Architecture Decision Records (ADR 001 Adapter Hub)
│   └── OAUTH-LESSONS.md          # Lecciones de OAuth Google en el panel
```

---

## 🚀 Inicio Rápido

### 0. Preparar entorno Python (solo la primera vez)

> En Debian/Ubuntu, antes de crear el venv instala el paquete `python3-venv`:
> `sudo apt install python3-venv` (en Debian 12/Ubuntu 24.04: `python3.12-venv`).

```bash
cd brain
# Linux / macOS
python3 -m venv venv && venv/bin/pip install -r requirements.txt
# Windows
python -m venv venv && venv\Scripts\pip install -r requirements.txt
```

### 1. Iniciar Cerebro IA (Python FastAPI):
```bash
cd brain
# Linux / macOS (desarrollo manual: puerto 5100, bind 0.0.0.0)
export NODE_ENV=development BRAIN_PORT=5100 BRAIN_HOST=0.0.0.0
venv/bin/python main.py
# Windows
venv\Scripts\python.exe main.py
# Si ya está corriendo (puerto ocupado): `venv/bin/python main.py --restart` lo reinicia
```

### 2. Iniciar Gateway WhatsApp (Node.js):
```bash
cd apps/gateway
export NODE_ENV=development
npm start
# o: node index.js
# Si ya está corriendo: `npm start -- --restart` lo reinicia
```
> 🔒 **Instancia única:** abrir una segunda instancia del brain o del gateway se bloquea automáticamente (mensaje claro + salida). Esto protege la sesión de WhatsApp de corrupción por doble conexión.

### 3. Iniciar Panel Web (Opcional, proceso independiente):
```bash
cd apps/panel
export NODE_ENV=development
export NODE_PATH="$(cd ../gateway && pwd)/node_modules"
node index.js
# Acceso en el navegador: http://localhost:5201 (o tu IP / Tailscale en el puerto 5201)
```

#### 🔐 OAuth con Google

En producción o con PANEL_REQUIRE_AUTH=true, el panel exige Google OAuth 2.0.
Requiere PANEL_GOOGLE_CLIENT_ID y PANEL_GOOGLE_CLIENT_SECRET; sin ambas falla
cerrado. En desarrollo, legacy conserva acceso abierto; v1 requiere opt-in dev
explícito o sesión OAuth forzada.

- Crea un "ID de cliente de OAuth" (Aplicación web) en Google Cloud Console.
  - Orígenes autorizados JS: `https://panel.zer0x.org`
  - URIs de redirección: `https://panel.zer0x.org/auth/callback`
- Guarda las credenciales en `gateway/panel/.env` (ya está en `.gitignore`):
  ```
  PANEL_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
  PANEL_GOOGLE_CLIENT_SECRET=....
  PANEL_SESSION_SECRET=<secreto-fijo-32-bytes>
  PANEL_ALLOWED_EMAILS=           # csv de correos permitidos; vacío = cualquier cuenta Google
  ```
- El server carga `gateway/panel/.env` automáticamente al arrancar (no
  necesita `export`). La cookie de sesión se firma con HMAC-SHA256
  (HttpOnly, Secure tras proxy HTTPS, SameSite=Lax, 12 h).
- En el homelab el panel se expone vía Caddy + Cloudflare Tunnel en
  `https://panel.zer0x.org` (TLS en el borde; Caddy proxifica a
  `127.0.0.1:5201` / `host.docker.internal:5201`).
- Gateway y panel requieren el mismo SDK_PANEL_GATEWAY_SECRET >=32 bytes para
  la frontera firmada; Compose exige esa variable en su entorno. Es distinta del
  secreto de cookie y de claves IA. Sin secreto solo queda compatibilidad legacy
  de desarrollo en loopback, nunca v1. Configuración/grants y límites:
  [FRONTERA-AUTENTICADA-V1](docs/FRONTERA-AUTENTICADA-V1.md).

#### Canales y Pairing desde el panel

- **WhatsApp:**
  - **QR:** Baileys puede emitir varios QRs consecutivos durante una misma solicitud. El panel reemplaza la imagen, pero mantiene una sola ventana total de 140 segundos (`GATEWAY_QR_TTL_MS=140000`); no permite pedir otro hasta que expire. El timer cuenta hacia arriba desde el primer QR.
  - **Código:** se solicita con un número que incluya el código de país, sin `+`. Baileys devuelve un código de 8 caracteres, que se muestra en una ficha grande con copia al portapapeles. Solicitar otro código es manual y reemplaza el anterior; no hay renovación automática.
  - El bus interno conserva el método pendiente (`QR` o `código`). Si se cambia de pestaña o se recarga el panel, Pairing restaura directamente el método activo y bloquea solicitudes cruzadas.
- **Telegram:**
  - Pestaña dedicada para ingresar el **Telegram Bot Token** y obtener automáticamente el **Chat ID** de administración pulsando *"Testear y Obtener Chat ID"*.
  - Guarda la configuración en caliente en `settings_db.json` sin reiniciar el gateway. El adaptador inicia polling automático y configura el menú de comandos en Telegram.

### 4. Producción — Docker Compose en Linux

El código del bot es el mismo en desarrollo y producción. En Linux, producción usa Docker Compose para supervisar los tres procesos:

| Plataforma | Supervisor | Cómo se despliega |
|---|---|---|
| 🐧 **Linux (servidor)** | Docker Compose | `docker compose -f deploy/docker/compose.yml up -d` |
| 🤖 **Android (Termux)** | runit | `bash deploy/termux/setup-termux.sh` (o el manual en `deploy/termux/README.md`) |
| 🪟 **Windows (PC)** | Programador de tareas | `deploy/windows/startBrain.bat` + `startGateway.bat` (ver `deploy/windows/README.md`) |

**Linux — producción en segundo plano:**
```bash
test -f brain/.env || { echo 'Falta brain/.env'; exit 1; }
docker compose -f deploy/docker/compose.yml build
docker compose -f deploy/docker/compose.yml up -d
docker compose -f deploy/docker/compose.yml ps
docker compose -f deploy/docker/compose.yml logs -f gateway
```

El panel queda en `http://127.0.0.1:5201`. El estado de WhatsApp, las DB, la
memoria y las colas viven en volúmenes Docker; `docker compose down -v` los
borra y es un reset destructivo. El detalle está en `deploy/docker/README.md`.

**Termux — todo en un comando:**
```bash
pkg install -y git
git clone https://github.com/Zer0x25/SDK-Bot.git && cd SDK-Bot
bash deploy/termux/setup-termux.sh           # dependencias + runit + boot automático
# (luego edita brain/.env con tus API keys)
```

**Windows — terminales:**
```powershell
deploy\windows\startBrain.bat    # terminal 1 (siempre primero)
deploy\windows\startGateway.bat  # terminal 2
# Para el panel web (opcional):
cd apps\panel
$env:NODE_PATH = (Resolve-Path ..\gateway\node_modules).Path
node index.js # terminal 3
```

### 5. Desarrollo en Linux — lanzamiento manual:

El desarrollo no usa systemd ni Docker Compose. La forma recomendada es
`deploy/linux/dev.sh`, que lanza los 3 procesos en background (brain :5100,
gateway :5400/:5300, panel :5201), crea el venv del brain y las devDeps del
gateway si faltan (con `NODE_ENV=development` forzado para no omitir eslint/tsc),
y deja logs en `/tmp/sdk-bot-{brain,gateway,panel}.log`.

```bash
cd ~/playground/sdk-bot
bash deploy/linux/dev.sh up all        # levanta brain + gateway + panel en background
bash deploy/linux/dev.sh status        # health de los 3 puertos
bash deploy/linux/dev.sh down          # mata todo y libera los locks
# Por componente (varios a la vez):
bash deploy/linux/dev.sh up brain
bash deploy/linux/dev.sh up gateway panel   # gateway + panel, sin brain
```

`up` es idempotente: si ya hay procesos vivos en esos puertos, los mata y
relanza (no deja duplicados ni `EADDRINUSE`). `NODE_ENV=development` identifica
estos lanzamientos, pero la aplicación no
usa esa variable como interruptor de comportamiento. No ejecutes a la vez una
instancia manual y los contenedores de producción sobre la misma sesión.
Por defecto los logs van a `/tmp/sdk-bot-{brain,gateway,panel}.log`; define
`SDK_BOT_DEV_LOG_DIR` para guardarlos en otro directorio.

> 📋 **Logs:** rotación automática (5MB × 3) en `gateway/logs/gateway.log` y `brain/logs/brain.log` (en Termux: `~/logs/sdk-gateway.log`).
> Los tests no escriben en esos logs: `npm test` guarda sus logs técnicos en `/tmp/sdk-bot-test-<pid>.log` y deja en consola solo el resultado de `node:test`.

### 6. Re-sincronizar Libreta Completa de Contactos (Fresh QR):
```bash
cd apps/gateway
npm run reset          # interactivo: pide confirmación y luego genera QR
npm run reset -- --yes # no interactivo: borra la sesión y sale (el gateway ya corriendo regenera el QR)
```
`npm run clean -- --yes` hace un reset de fábrica: borra todo el estado runtime,
incluido el archivo de conversaciones, y conserva `brain/profiles/`. Antes hay
que detener supervisores y evitar arranques concurrentes. El CLI rechaza servicios
supervisados detectados o una parada no verificable; `--yes` no omite esa guarda.
Tras un reset correcto sale sin relanzar procesos. En Windows/Termux detén las
instancias antes de usarlo. Alcance y límites: [reset seguro](docs/RESET-SEGURO-F2B1.md).

---

## 🎮 Comandos Admin (WhatsApp Self-Chat & Telegram Bot)

Envía estos comandos desde tu chat de WhatsApp ("Mensaje a ti mismo") o directamente a tu bot en **Telegram**.
**Nota:** En WhatsApp puedes citar (responder) cualquier mensaje de cliente o alerta para omitir el `<num/lid>`. En Telegram los comandos están preconfigurados en el menú interactivo.

| Comando | Alias Cortos | Descripción |
|---------|--------------|-------------|
| `/auto <num/lid>` | `/a`, `/ia`, `/unpause` | Reactivar la IA para un cliente en atención humana (Handoff) |
| `/handoff <num/lid>` | `/h`, `/humano` | Activar atención humana (pausar IA únicamente para ese cliente) |
| `/limpiar <num/lid>` | `/c`, `/reset` | Borrar la memoria conversacional de la IA para un cliente |
| `/nombre <num> <nombre>` | `/n`, `/name`, `/alias` | Asignar o renombrar un contacto de tu agenda manualmente |
| `/buscar <query>` | `/s`, `/search` | Buscar un contacto por Nombre de Agenda, Nombre Público, Teléfono o LID |
| `/ignorar <num\|agenda\|*>` | `/i`, `/b`, `/ignore`, `/bloquear` | Asignar número/LID o agenda a lista negra (`*` = modo estricto) |
| `/permitir <num\|*>` | `/p`, `/allow` | Asignar número/LID a lista blanca (`*` = permitir a todos) |
| `/quitar <num\|*>` | `/q`, `/remove`, `/revoke`, `/rem` | Remover regla individual y devolver contacto a estado neutro |
| `/listas` | `/l`, `/list` | Ver estado global y listas de permitidos e ignorados |
| `/contactos` | `/lc`, `/contacts` | Ver resumen de contactos registrados y últimos activos |
| `/sincronizar` | `/sync`, `/resync` | Sincronizar memoria RAM con `contacts_db.json` |
| `/exportar` | `/export` | Exportar la libreta completa de contactos mapeados |
| `/pausar` | `/pg`, `/pause`, `/stop` | Pausar el auto-respondedor globalmente para todos los chats |
| `/reanudar` | `/ag`, `/resume`, `/start`, `/run` | Reanudar el auto-respondedor globalmente |
| `/perfil <nombre>` | `/pf`, `/profile` | Cambiar personalidad del bot (`default`, `lucia`, `mateo`, `cobranzas`, `recepcion`) |
| `/info` | `/whoami` | Ver datos de conexión admin (Phone, LID, País, JID) |
| `/estado` | `/e`, `/menu`, `/status`, `/help`, `/admin` | Panel de estado general del bot y menú de ayuda |
| `/init` | `/guia`, `/startguide` | Ver guía rápida de inicio explicativa interactiva |

> 💡 Los textos normales enviados en Self-Chat o Telegram Admin activan el modo **Asistente Personal IA**.

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
