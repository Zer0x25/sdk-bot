# 🤖 SDK-Bot

**Plataforma Multi-Bot de WhatsApp 100% Custom, Smart Sync & Automated Handoff** — Gateway de mensajería modular en Node.js + Cerebro IA en Python FastAPI con router multi-proveedor (Groq → OpenRouter → Gemini).

---

## 🎯 Características Principales

- **🤝 Derivación a Humano (Single-User Handoff):** Si un cliente pide *"hablar con un asesor"*, la IA se pausa **únicamente para ese cliente** y notifica al Admin en Self-Chat (`/auto <num>` o `/a` para reactivar, `/handoff <num>` o `/h` para pausar).
- **🧠 De-bounce Queue Adaptativo Estocástico:** Acumula mensajes consecutivos con temporizador estocástico adaptativo (5s-7s en mensajes cortos, 7.5s-12s en textos largos/múltiples, con capas estocásticas de ocupación/distracción de 1-2 min al 12% y 3-4 min al 5%). Si el usuario escribe despacio (`composing`), los temporizadores se renuevan continuamente sin cortar la idea del cliente.
- **⏱️ Auto-Expiración de Escritura (5.0s):** Si el cliente se arrepiente y borra lo que escribía sin enviar evento de pausa, el estado expira automáticamente a los 5.0s (`TYPING_TTL_MS`) y arranca el temporizador de silencio.
- **🧠 Memoria de Conversación Persistente (2 etapas, web-like):** El cerebro guarda el historial en SQLite (aislado por bot+usuario, ventana de 7 días / sin tope de cantidad / ~5000 tokens). Al detectar que el cliente **empieza a escribir** (`composing`), el gateway **precarga el contexto de ese chat** (señal de intervención igual al cliente web: "abre el chat y ya sabe de qué va") con una ventana reciente acotada (25 mensajes por defecto, `GATEWAY_PRELOAD_*` en `.env.tuning`). Cuando el mensaje **llega**, la respuesta usa el contexto **COMPLETO** (7d / 5000 tok) del cerebro. La precarga es solo señal y NO se inyecta en la respuesta. Tunable vía `.env.tuning`.
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
- **🚨 Alertas Silenciosas de Error al Self-Chat:** 
  - Los errores técnicos o caídas de la IA **nunca se envían al cliente**. 
  - En su lugar, el sistema notifica en privado al Self-Chat del Admin con el nombre del cliente, teléfono, país, mensaje original, diagnóstico explícito y el comando rápido `/handoff <num>` para tomar la conversación.
- **🗂️ Motor de Estados Centralizado (`contacts_db.json` & `settings_db.json`):**
  - Persistencia de `savedName` (Agenda), `pushName` (Público), `phone`, `lid`, `country`, `language`, `profilePicUrl` HD, `bio`, `isBusiness` y `estado` (`permitido`, `ignorado`, `handoff`, `neutro`).
  - Refresco inteligente TTL de 24 horas para foto y biografía.
  - Inserciones masivas ultra-rápidas en lote (`bulkUpsertContactsMetadata`).
- **🚀 Re-Sincronización Automatizada (`npm run reset`):** Script `reset-session.js` para limpiar sesión y escanear un QR nuevo con descarga masiva de libreta.

---

## 📁 Estructura del Proyecto

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Entrada Baileys (presenceSubscribe, syncFullHistory, bus interno :5400)
│   ├── reset-session.js          # Script de re-sincronización de libreta (npm run reset)
│   ├── reset-clean.js            # Reset limpio de fábrica F7 (npm run clean)
│   ├── config.js                 # Estado global, URLs y registro anti-bucle
│   ├── tuning.js                 # Variables de afinación y rendimiento
│   ├── panel/                    # Panel Web — 3er proceso independiente (puerto 5201)
│   │   └── index.js              # Servidor HTTP proxy hacia el bus interno (:5400) y estáticos
│   ├── admin-web/                # Frontend web estático (HTML/CSS/JS puro, dashboard, pairing, etc.)
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
├── brain/                        # Capa de Inteligencia (Python + FastAPI)
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
├── PLAN-ARQUITECTURA.md          # Documentación técnica completa
└── ROADMAP.md                    # Hoja de ruta de fases (guía de sesiones)
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
cd gateway
export NODE_ENV=development
npm start
# o: node index.js
# Si ya está corriendo: `npm start -- --restart` lo reinicia
```
> 🔒 **Instancia única:** abrir una segunda instancia del brain o del gateway se bloquea automáticamente (mensaje claro + salida). Esto protege la sesión de WhatsApp de corrupción por doble conexión.

### 3. Iniciar Panel Web (Opcional, proceso independiente):
```bash
cd gateway/panel
export NODE_ENV=development
node index.js
# Acceso en el navegador: http://localhost:5201 (o tu IP / Tailscale en el puerto 5201)
```

#### 🔐 OAuth con Google (opcional, recomendado en producción)

El panel soporta login con Google OAuth 2.0. Cuando están presentes las
variables `PANEL_GOOGLE_CLIENT_ID` y `PANEL_GOOGLE_CLIENT_SECRET`, **todas las
rutas (excepto `/auth/*`) exigen sesión Google**; sin ellas el panel queda
abierto (comportamiento legacy).

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
cd gateway\panel && node index.js # terminal 3
```

### 5. Desarrollo en Linux — lanzamiento manual:

El desarrollo no usa systemd ni Docker Compose. Abre terminales separadas y
arranca manualmente; siempre inicia el brain antes del gateway.

```bash
cd ~/playground/sdk-bot
bash deploy/linux/dev.sh manual todos      # imprime los comandos para 3 terminales
# En terminales separadas:
bash deploy/linux/dev.sh manual brain
bash deploy/linux/dev.sh manual gateway
bash deploy/linux/dev.sh manual panel
```

`NODE_ENV=development` identifica estos lanzamientos, pero la aplicación no
usa esa variable como interruptor de comportamiento. No ejecutes a la vez una
instancia manual y los contenedores de producción sobre la misma sesión.

> 📋 **Logs:** rotación automática (5MB × 3) en `gateway/logs/gateway.log` y `brain/logs/brain.log` (en Termux: `~/logs/sdk-gateway.log`).

### 6. Re-sincronizar Libreta Completa de Contactos (Fresh QR):
```bash
cd gateway
npm run reset
```
*(O usa `npm run clean` para un reset limpio de fábrica F7)*

---

## 🎮 Comandos Admin (Self-Chat en WhatsApp)

Envía estos comandos desde tu propio chat de WhatsApp ("Mensaje a ti mismo"). **Nota:** Puedes citar (responder) cualquier mensaje de cliente o alerta para omitir el `<num/lid>`.

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

> 💡 Los textos normales enviados en Self-Chat activan el modo **Asistente Personal IA**.

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
