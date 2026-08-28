# Plan de Arquitectura: SDK-Bot (100% Custom & Modular)

Este documento define la arquitectura y componentes de la plataforma Multi-Bot de WhatsApp **SDK-Bot**, diseñada para operar con control total de flujo, privacidad, simulación humana y derivación quirúrgica a atención humana.

---

## 🎯 Objetivo Principal
Crear una plataforma escalable donde podamos levantar `N` cantidad de bots de WhatsApp, cada uno con su propio número, memoria aislada, personalidad configurable (SOUL), protección anti-baneo y derivación a atención humana en tiempo real.

---

## 📁 Estructura del Proyecto

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Hub de Adaptadores)
│   ├── index.js                  # Punto de entrada (orquesta adaptadores, pipelines y colas)
│   ├── core/                     # Interfaces abstractas (ChannelAdapter, StandardMessage)
│   ├── adapters/                 # Implementaciones de red (whatsappAdapter, telegramAdapter)
│   ├── reset-session.js          # Script de re-sincronización de libreta (npm run reset / Fresh QR)
│   ├── reset-clean.js            # Reset limpio de fábrica F7 (npm run clean)
│   ├── config.js                 # Estado global, URLs y registro anti-bucle
│   ├── tuning.js                 # Variables de afinación y rendimiento
│   ├── panel/                    # Panel Web — 3er proceso independiente (puerto 5201)
│   │   ├── index.js              # Servidor HTTP proxy hacia el bus interno (:5400) y estáticos
│   │   └── public/               # Frontend web estático modular (dashboard, pairing, contactos, perfiles, logs)
│   ├── store/
│   │   └── chatStore.js          # Store RAM de mensajes de Baileys (precarga web-like)
│   ├── services/
│   │   ├── internalBus.js        # Bus interno HTTP (:5400) para desacoplar el gateway del panel
│   │   ├── db.js                 # Persistencia atómica (contacts_db, settings_db)
│   │   ├── contactsRepository.js # Lógica de contactos, índices RAM O(1) y saneamiento
│   │   ├── contactSyncQueue.js   # Cola de sincronización de contactos por lotes (100/tick)
│   │   ├── messageSyncQueue.js   # Cola de sincronización de mensajes de historial (100/tick)
│   │   ├── messageQueue.js       # Cola persistente en disco (JSONL) para caídas del brain
│   │   ├── broadcastService.js   # Difusión masiva y mensajes programados
│   │   ├── stateService.js       # Estados de contacto y modos globales
│   │   ├── metadataService.js    # Smart Delta Sync (TTL 24h), Phone/LID dual, Foto HD, Bio y Países
│   │   ├── statusServer.js       # Métricas locales en HTTP (:5300)
│   │   ├── factoryReset.js       # Motor unificado de reset limpio F7
│   │   └── brainService.js       # Cliente HTTP REST + Simulación Humana (Typing Delay & Multi-Bubble)
│   ├── handlers/
│   │   ├── commandHandler.js     # Dispatcher modular de comandos admin con extracción de citas
│   │   ├── commandHelpers.js     # Sanitización, help de comandos y utilidades
│   │   ├── commands/             # Comandos por categoría (/ia, /humano, /perfil, /broadcast, /estado, etc.)
│   │   └── messageHandler.js     # Pipeline de mensajes, De-bounce estocástico, Handoff y Presencia RAM
│   ├── contacts_db.json          # Base de datos centralizada de contactos y estados (gitignored)
│   ├── settings_db.json          # Configuración global del bot (globalMode: allowed_all / ignored_all)
│   ├── settings_db.json.example  # Plantilla de configuración global
│   ├── *.json.example            # Plantillas de ejemplo para despliegues limpios
│   ├── auth_info_baileys/        # Sesión y estado de WhatsApp (gitignored)
├── brain/                        # Capa de Inteligencia (Python + FastAPI)
│   ├── main.py                   # Aplicación FastAPI modularizada (/chat, /reset-memory, /profiles, :5100)
│   ├── config.py                 # API Keys y modelos (Groq, OpenRouter, Gemini)
│   ├── memory.py                 # Gestor de memoria persistente SQLite (brain/memory.db)
│   ├── providers.py              # Router multi-proveedor (orden y timeouts TUNABLES vía .env.tuning: BRAIN_PRIMARY_MODEL)
│   ├── profiles.py               # Motor de perfiles SOUL en caliente
│   ├── profiles/                 # Perfiles SOUL editables en Markdown (default, lucia, mateo, cobranzas, recepcion)
│   ├── .env                      # API Keys (gitignored)
│   └── requirements.txt          # Dependencias Python
├── deploy/                       # Despliegue por plataforma (Docker Linux, Termux runit, Windows batch)
├── PLAN-ARQUITECTURA.md          # Documentación técnica completa
└── ROADMAP.md                    # Hoja de ruta de fases (guía de sesiones)
```

---

## 🏗️ Componentes de Arquitectura e Innovaciones

### 1. 🤝 Derivación a Humano (Human Handoff & Pausa Quirúrgica)
- **Detección Automática:** Cuando un cliente utiliza expresiones como `"hablar con una persona"`, `"asesor"`, `"ejecutivo"`, `"atención humana"`, el Gateway pausa la IA **exclusivamente para ese cliente** asignando `estado: "handoff"` en `contacts_db.json`.
- **Notificación en Self-Chat:** Alerta al Administrador en su chat privado de WhatsApp indicando datos del cliente y el comando copiable `/auto <num>`.
- **Control por Comandos & Extracción de Citas:**
  - Comandos `/auto` (o `/a`, `/ia`) para reactivar la IA, `/handoff` (o `/h`, `/humano`) para pausarla individualmente, y `/limpiar` (o `/c`, `/reset`) para reiniciar la memoria conversacional del cliente.
  - **Extracción de Citas:** Al responder (citar) un mensaje en Self-Chat con un comando, el sistema extrae automáticamente el teléfono o LID del contexto.

### 2. 🧠 De-bounce Queue & Timer de Silencio Estocástico Adaptativo (Random sobre Random)
- **Ventana de Silencio Estocástica Adaptativa:** En lugar de un temporizador fijo, el tiempo de silencio pos-escritura se calcula dinámicamente:
  - **Adaptativo Normal (~83%):** 5s a 7s para mensajes únicos/cortos (<20 chars); 7.5s a 12s para múltiples mensajes o textos largos.
  - **Capa Ocupado / Distraído (~12%):** Posponimiento de 1 a 2 minutos (60s - 120s) imitando un retraso humano ocasional.
  - **Capa AFK / Muy Ocupado (~5%):** Posponimiento de 3 a 4 minutos (180s - 240s) imitando distracciones más prolongadas.
- **Renovación Dinámica (`presence.update`):** Si el cliente está escribiendo (`composing` / `recording`), los temporizadores se renuevan continuamente sin cortar la idea del usuario. Además, el composing dispara la precarga de contexto (Opción A, 2 etapas web-like): el gateway hace GET /history del cerebro y guarda en RAM la ventana reciente de ESE chat (etapa 1, señal de intervención: el bot ya sabe de qué va al abrir el chat), con límites acotados (GATEWAY_PRELOAD_MAX_MESSAGES=25, sin tope de tokens). Cuando el mensaje llega, la respuesta usa el contexto COMPLETO del cerebro (7d / 5000 tok, etapa 2); la precarga NO se inyecta en la respuesta. El dedup por TTL evita martillear al cerebro en cada evento de presencia.
  - *Soporte Multi-Device (Dual JID):* El estado de presencia entra a nivel de Teléfono (@s.whatsapp.net), pero los mensajes pueden operar bajo el LID (@lid). Nuestro motor en memoria RAM (activePresences) resuelve ambos IDs simultáneamente apoyándose en contacts_db.json.
- **Expiración de Escritura (5.0s):** Si el usuario deja de escribir sin enviar evento `paused`, el estado de escritura expira a los 5.0s (`TYPING_TTL_MS`) e inicia el temporizador de silencio adaptativo.

### 3. 🛡️ Simulación Humana & Anti-Ban Rate Limiter
- **Lectura / Pensamiento Inicial:** Simula tiempo de lectura (800ms - 3.3s) antes de encender el estado de tecleo.
- **Typing Delay Adaptativo (1.5s - 16s):** Simula velocidad humana de 7 a 10 caracteres por segundo (100ms - 135ms por carácter) con ruido estocástico (jitter), acotado entre 1.5s y 16.0s por globo.
- **Multi-Bubble (Globos Secuenciales):** Divide respuestas extensas en fragmentos (máx `GATEWAY_BUBBLE_MAX_CHARS`, default ~220 chars) con pausas inter-globo tunables (`GATEWAY_PAUSE_BETWEEN_BUBBLES_MIN/MAX_MS`, default 1.0s–2.2s). Todo en `.env.tuning` (`gateway/services/humanSim.js`).

### 4. ⚡ Router Multi-Proveedor de IA & Resiliencia
- **Cascada Automatizada de Respaldo** (orden TUNABLE vía `BRAIN_PRIMARY_MODEL` en `.env.tuning`; default **Gemini primary**):
  1. **Google Gemini** (`gemini-3.1-flash-lite`, default primary): Timeout tunable (`BRAIN_TIMEOUT_GEMINI`, default 40s).
  2. **Groq** (`llama-3.3-70b-versatile`): Respaldo 1 (Timeout `BRAIN_TIMEOUT_GROQ`, default 25s).
  3. **OpenRouter** (`openrouter/free`): Respaldo 2 (Timeout `BRAIN_TIMEOUT_OPENROUTER`, default 25s).
- Los timeouts, temperatura/top_p/max_tokens y el estilo global de "voz" son tunables en `.env.tuning` (ver `brain/config.py`).
- **Alertas Silenciosas de Error:** Si la IA falla o se agota el timeout, el error **nunca se muestra al cliente**. Se envía una alerta privada al Self-Chat del Admin con el diagnóstico exacto.

### 5. 🗂️ Motor de Estados Centralizado (`contacts_db.json` & `settings_db.json`)
- **Gestión Unificada de Estados:** Reemplaza listas externas obsoletas por el campo `estado` (`permitido`, `ignorado`, `handoff`, `neutro`) en `contacts_db.json` y `globalMode` (`allowed_all` / `ignored_all`) en `settings_db.json`.
- **TTL de 24 Horas:** Evita consultas redundantes de foto/bio a WhatsApp si el contacto fue enriquecido en las últimas 24h.
- **`bulkUpsertContactsMetadata`:** Inserciones en lote ultra-rápidas para no bloquear el Event Loop de Node.js.

### 6. 🚀 Re-Sincronización Automatizada para Usuarios Finales (`npm run reset` y `npm run clean`)
- Script `reset-session.js` para limpiar `auth_info_baileys` y generar un código QR nuevo que descargue la libreta completa de contactos de la cuenta.
- Script `reset-clean.js` (F7) para un restablecimiento de fábrica total con borrado de memoria, agenda, colas, logs y settings.

### 7. 🖥️ Panel Web Desacoplado & Bus Interno (Arquitectura de 3 Procesos)
- **Panel Web (`gateway/panel/index.js`):** Proceso HTTP independiente en puerto `5201` (bind `0.0.0.0` en dev nativo, accesible por LAN/Tailscale) que sirve el frontend administrativo y actúa como proxy inverso al bus interno. Carga `gateway/panel/.env` al arrancar.
  - **OAuth solo en producción:** el login con Google OAuth 2.0 se activa únicamente cuando `NODE_ENV=production` (o `PANEL_REQUIRE_AUTH=***, además de definir `PANEL_GOOGLE_CLIENT_ID`/`PANEL_GOOGLE_CLIENT_SECRET`. En desarrollo el panel queda **ABIERTO** (sin login) aunque haya credenciales, para no frenar el trabajo. Las rutas `/auth/*` solo existen cuando OAuth está habilitado.
  - La sesión es una cookie HMAC-SHA256 (HttpOnly, Secure tras proxy HTTPS, **SameSite=None; Secure** para sobrevivir el redirect de Google, 12 h). La cookie de estado OAuth usa lo mismo.
  - **No se expone el dominio público en dev:** en desarrollo el panel corre en localhost/LAN/Tailscale pero **no** vía `panel.zer0x.org` (ese dominio queda reservado para el despliegue en producción con Docker + OAuth). El Caddyfile del homelab no enruta `panel.zer0x.org` al panel de dev.
- **Bus Interno HTTP (`gateway/services/internalBus.js` en puerto `5400`):** Expuesto por el gateway en loopback (`127.0.0.1:5400`). Permite consultar estado, transmitir el QR y logs por SSE, regenerar QR bajo demanda (`/qr/refresh`), consultar el método de pairing pendiente (`/pairing/status`), vincular por número (`/pairing`), ejecutar comandos admin y arrancar el brain (`/brain/start`). La tanda QR conserva una ventana total de 140s aunque Baileys emita varios tokens, y el bus bloquea solicitudes QR/código cruzadas. Si el gateway cae, el panel sigue vivo y el frontend se reconecta solo al volver el servicio.

---

## 🔒 Pipeline de Seguridad y Flujo de Mensajes

```
Mensaje Entrante en Adapter Hub (WhatsApp, Telegram, etc.)
│
├── 🗂️ Registro/Actualización en contacts_db.json (bulkUpsert / upsertContactMetadata)
├── 🧠 Smart TTL Check (¿lastEnrichedAt < 24h? SÍ: Omitir Red | NO: Consultar Foto/Bio)
│
├── ¿Es mensaje de bot anti-loop (ID en botSentMessageIds)? → IGNORAR
├── ¿Es Self-Chat (isSelfChat: Admin Phone o LID)?
│   ├── ¿Empieza con /? → EJECUTAR COMANDO ADMIN (con auto-extracción de JID si cita mensaje)
│   └── Texto normal   → ASISTENTE PERSONAL IA (brainService)
├── ¿Es mensaje enviado por ti en chat de cliente (fromMe)? → IGNORAR (Bot en silencio)
├── ¿Empieza con / (cliente)?                      → BLOQUEAR (Seguridad Admin)
├── ¿Bot pausado globalmente (IS_BOT_PAUSED)?       → IGNORAR
│
├── 🗂️ Evaluación de Estado en contacts_db.json:
│   ├── ¿estado == 'ignorado'?                     → IGNORAR
│   ├── ¿estado == 'permitido'?                    → CONTINUAR (Bypassea modo global)
│   └── ¿estado == 'neutro'?
│       └── ¿globalMode == 'ignored_all'?          → IGNORAR (Modo Estricto Whitelist)
│
├── 🤝 ¿Contiene palabras clave de atención humana?  → SÍ: ESTADO = HANDOFF + NOTIFICAR ADMIN + AVISAR CLIENTE
├── ¿Tiene estado == 'handoff'?                     → SÍ: IGNORAR (Esperando atención humana)
│
└── 🧠 De-bounce Queue (Silencio estocástico adaptativo 5s-12s / 1-2m / 3-4m)
    ├── 📖 Simulación Lectura (800ms - 3.3s)
    ├── ⌨️ Simulación Tipeo ('composing' 1.5s - 16s)
    └── 🧩 Envío por Globos (Multi-Bubble ~220 chars con pausas de 1.0s - 2.2s)
```
