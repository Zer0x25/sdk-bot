# Plan de Arquitectura: SDK-Bot (100% Custom & Modular)

Este documento define la arquitectura y componentes de la plataforma Multi-Bot de WhatsApp **SDK-Bot**, diseñada para operar con control total de flujo, privacidad, simulación humana y derivación quirúrgica a atención humana.

---

## 🎯 Objetivo Principal
Crear una plataforma escalable donde podamos levantar `N` cantidad de bots de WhatsApp, cada uno con su propio número, memoria aislada, personalidad configurable (SOUL), protección anti-baneo y derivación a atención humana en tiempo real.

---

## 📁 Estructura del Proyecto

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Punto de entrada ultraligero con syncFullHistory
│   ├── reset-session.js          # Script de re-sincronización de libreta (Fresh QR)
│   ├── config.js                 # Estado global, URLs y registros anti-bucle
│   ├── services/
│   │   ├── storageService.js     # Gestor I/O atómico (allowed, ignored, contacts_db, handoff, bulkUpsert)
│   │   ├── metadataService.js    # Smart Delta Sync (TTL 24h), Phone/LID dual, Foto HD y Bio
│   │   └── brainService.js       # Cliente HTTP REST + Simulación Humana (Typing Delay)
│   ├── handlers/
│   │   ├── commandHandler.js     # Procesador modular de comandos admin (/search, /sync, /auto, /name, etc.)
│   │   └── messageHandler.js     # Pipeline de mensajes, De-bounce 8s y Handoff Humano
│   ├── allowed_numbers.json      # Whitelist de números/LIDs (gitignored)
│   ├── ignored_numbers.json      # IgnoreList / Lista Negra (gitignored)
│   ├── contacts_db.json          # Base de datos de contactos PRO (gitignored)
│   ├── *.json.example            # Plantillas de ejemplo para despliegues limpios
│   └── auth_info_baileys/        # Sesión y estado de WhatsApp (gitignored)
└── brain/                        # Capa de Inteligencia (Python + FastAPI)
    ├── main.py                   # Aplicación FastAPI modularizada
    ├── config.py                 # API Keys, perfiles SOUL y modelos
    ├── memory.py                 # Gestor de memoria por user_id
    ├── providers.py              # Router multi-proveedor (OpenRouter → Groq → Gemini)
    ├── .env                      # API Keys (gitignored)
    ├── requirements.txt          # Dependencias Python
    └── venv/                     # Entorno virtual
```

---

## 🏗️ Componentes de Arquitectura e Innovaciones

### 1. 🤝 Derivación a Humano (Human Handoff & Pausa Quirúrgica)
- **Detección Automática:** Cuando un cliente utiliza expresiones como `"hablar con una persona"`, `"asesor"`, `"ejecutivo"`, `"atención humana"`, el Gateway pausa la IA **exclusivamente para ese cliente**.
- **Notificación en Self-Chat:** Alerta al Administrador en su chat privado de WhatsApp.
- **Control por Comandos:** Comandos `/auto <num>` para reactivar la IA y `/handoff <num>` para pausarla individualmente.

### 2. 🧠 De-bounce Queue & Timer de Inactividad de 8s (Pos-Escritura)
- **Ventana de Silencio de 8s:** Si un cliente envía mensajes fragmentados, el bot acumula los mensajes en cola.
- **Renovación Dinámica (`presence.update`):** Si el cliente está escribiendo (`composing`), los temporizadores se renuevan continuamente. **Protección 100% para usuarios lentos al escribir.**
- **Expiración de Escritura (4.5s):** Si el usuario se arrepiente y suelta el teclado sin enviar nada, el estado de escritura expira a los 4.5s y se activa el conteo de 8s de silencio.

### 3. 🛡️ Simulación Humana & Anti-Ban Rate Limiter
- **Typing Delay Adaptativo:** Antes de responder, el bot simula presencia `'composing'` por un tiempo dinámico (1.5s - 4.5s) en proporción a la longitud del mensaje.

### 4. 🗂️ Base de Datos de Contactos con Smart Delta Sync (TTL 24h)
- **`contacts_db.json` como Caché Local:** Persistencia en disco de `savedName` (Agenda), `pushName` (Público), `phone`, `lid`, `profilePicUrl` HD, `bio`, `country` e `isBusiness`.
- **TTL de 24 Horas:** Evita consultas redundantes de foto/bio a la red de WhatsApp si el contacto ya fue enriquecido en las últimas 24 horas.
- **`bulkUpsertContactsMetadata`:** Procesamiento en lote masivo (< 5ms) para evitar bloqueos del socket de Baileys.

### 5. 🚀 Re-Sincronización Automatizada para Usuarios Finales (`npm run reset`)
- Script `reset-session.js` para limpiar `auth_info_baileys` y generar un código QR nuevo que descargue la libreta completa de contactos de la cuenta.

---

## 🔒 Pipeline de Seguridad y Flujo de Mensajes

```
Mensaje Entrante en Baileys (messages.upsert)
│
├── 🗂️ Registro en contacts_db.json (bulkUpsert / upsertContactMetadata)
├── 🧠 Smart TTL Check (¿lastEnrichedAt < 24h? SÍ: Omitir Red | NO: Consultar Foto/Bio)
│
├── ¿Es mensaje de bot anti-loop (ID registrado)? → IGNORAR
├── ¿Es Self-Chat (isSelfChat: Admin Phone o LID)?
│   ├── ¿Empieza con /? → EJECUTAR COMANDO ADMIN (/search, /sync, /auto, /name, /ignore, etc.)
│   └── Texto normal   → ASISTENTE PERSONAL IA (brainService)
├── ¿Es mensaje enviado por ti en chat de cliente? → IGNORAR (Bot en silencio)
├── ¿Empieza con / (cliente)?                      → BLOQUEAR (Seguridad)
├── ¿Bot pausado globalmente?                     → IGNORAR
├── ¿Teléfono o LID en ignored_numbers.json?        → SÍ: IGNORAR (Prioridad Alta)
├── ¿Coincide con allowed_numbers.json?             → NO: IGNORAR
│
├── 🤝 ¿Contiene palabras clave de atención humana?  → SÍ: ACTIVAR HANDOFF + NOTIFICAR ADMIN
├── ¿Tiene Handoff activo para este cliente?        → SÍ: IGNORAR (Esperando atención humana)
│
└── 🧠 De-bounce Queue (Esperar 8s de silencio pos-escritura)
    └── 🤖 Simulación Humana (1.5s-4.5s 'composing') → Respuesta de la IA
```
