# Plan de Arquitectura: SDK-Bot (100% Custom)

Este documento define las bases para construir nuestro propio sistema Multi-Bot de WhatsApp desde cero, dejando atrás las limitaciones y colisiones de arquitecturas pre-empaquetadas.

## 🎯 Objetivo Principal
Crear una plataforma escalable donde podamos levantar `N` cantidad de bots de WhatsApp, cada uno con su propio número, memoria aislada y personalidad configurable (SOUL), utilizando herramientas modernas y control total del flujo.

---

## ✅ Estado Actual del Proyecto (Implementado)

### 📁 Estructura de Archivos
```
SDK-Bot/
├── gateway/
│   ├── index.js                  # Gateway WhatsApp (Baileys) - Capa de Mensajería
│   ├── allowed_numbers.json      # Lista de números/LIDs permitidos (editable en caliente)
│   ├── package.json              # Dependencias Node.js
│   └── auth_info_baileys/        # Sesión de WhatsApp (auto-generada)
└── brain/
    ├── main.py                   # API REST del Cerebro IA (FastAPI)
    ├── .env                      # API Keys: Groq, OpenRouter, Gemini
    ├── requirements.txt          # Dependencias Python
    └── venv/                     # Entorno virtual Python
```

---

## 🏗️ Arquitectura Implementada (Dos Capas)

### 1. Capa de Mensajería (WhatsApp Gateway)
**Tecnología:** Node.js + Baileys | **Archivo:** `gateway/index.js`

**Funcionalidades implementadas:**
*   **Conexión WhatsApp:** Autenticación por QR y reconexión automática ante caídas de red (`shouldReconnect`).
*   **Simulación Humana:** Estado `composing` (escribiendo...) + pausa artificial de 1 segundo antes de responder.
*   **Filtro de Seguridad / Whitelist (Hot-Reload):** Lista de permitidos en `allowed_numbers.json`. Soporta números de teléfono tradicionales y LIDs (nuevo sistema de privacidad de WhatsApp). Se recarga en tiempo real sin reiniciar el servidor. Acepta `*` para modo público.
*   **Panel de Control Remoto (Self-Chat Admin Commands):**
    *   Detección automática del `ADMIN_PHONE` y `ADMIN_LID` desde `sock.user` al conectar.
    *   Comandos de administración exclusivos del **Self-Chat** (Chat "Mensaje a ti mismo"):
        *   `/status` / `/help` — Panel de estado del bot.
        *   `/pause` / `/resume` — Activar/desactivar el auto-respondedor.
        *   `/allow <num_o_lid>` — Agregar usuario a la lista de permitidos.
        *   `/remove <num_o_lid>` — Remover usuario de la lista.
        *   `/list` — Ver todos los permitidos.
        *   `/profile <default|lucia|mateo>` — Cambiar personalidad de la IA en caliente.
    *   Los textos normales en Self-Chat activan el modo **Asistente Personal IA**.
*   **Aislamiento de Conversaciones del Admin:** Si el administrador responde manualmente en el chat de un cliente desde su teléfono, el bot se inhabilita al 100% para no interferir. Los clientes no pueden ejecutar comandos de administración.
*   **Registro Anti-Bucle (Anti-Loop Registry):** Rastreo por `msg.key.id` de los mensajes enviados por el bot, impidiendo auto-respuestas o bucles infinitos.

---

### 2. Capa de Inteligencia (Cerebro IA)
**Tecnología:** Python + FastAPI | **Archivo:** `brain/main.py`

**Funcionalidades implementadas:**
*   **API REST:** Endpoint `POST /chat` recibe `user_id`, `message` y `bot_profile`.
*   **Router Multi-Proveedor con Fallback Automático (3 niveles):**
    1.  **Primario:** OpenRouter → `openai/gpt-oss-20b:free`
    2.  **Fallback 1:** Groq → `llama-3.3-70b-versatile`
    3.  **Fallback 2:** Google Gemini → `gemini-flash-latest`
*   **API Keys configuradas:** Groq (`GROQ_API_KEY`), OpenRouter (`OPENROUTER_API_KEY`), Gemini (`GEMINI_API_KEY`) en archivo `.env`.
*   **Perfiles de Personalidad (SOUL):** Diccionario de `system_prompts` por perfil (`default`, `lucia`, `mateo`). Perfil activo gestionado remotamente por el admin desde WhatsApp.
*   **Memoria de Conversación (Short-Term):** Historial por `user_id` en diccionario en RAM. Se pierde al reiniciar el servidor (versión v1 sin persistencia).

---

## 🔒 Flujo de Seguridad de Mensajes

```
Mensaje Entrante
│
├── ¿Es un mensaje anti-loop (ID del bot)?  → IGNORAR
├── ¿Es Self-Chat (isFromMe + JID del Admin)?
│   ├── ¿Empieza con /? → EJECUTAR COMANDO ADMIN (solo en Self-Chat)
│   └── Texto normal   → ASISTENTE PERSONAL IA
├── ¿isFromMe en chat de cliente?           → IGNORAR (no interferir)
├── ¿Empieza con / (tercero)?              → BLOQUEAR (seguridad)
├── ¿Bot pausado?                           → IGNORAR
├── ¿Número en allowed_numbers.json?        → SI: CEREBRO IA | NO: IGNORAR
└── Respuesta de la IA al cliente
```

---

## 🚀 Hoja de Ruta Original (Estado)

1.  ✅ **Prueba de Concepto (Gateway):** Script Baileys funcional con QR y reconexión.
2.  ✅ **Prueba de Concepto (Cerebro):** API FastAPI con Gemini/Groq/OpenRouter.
3.  ✅ **El Puente:** Gateway conectado al Cerebro vía HTTP REST.
4.  ⏳ **Sistema de Memoria Persistente:** SQLite para que la memoria sobreviva reinicios.
5.  ✅ **Tiempos Humanos:** Estado `composing` + pausa artificial implementados.

---

## 🔮 Futuras Mejoras y Arquitectura Avanzada

### 🧠 1. Arnés de Memoria Avanzado (Inspirado en OpenClaw / Hermes)
*   **Compresión de Contexto (Short-Term Compaction):** Resumir historiales largos automáticamente mediante un LLM secundario para no saturar la ventana de tokens.
*   **Extractor de Hechos (Fact Extraction & Long-Term Memory):** Detectar y almacenar datos clave del usuario (nombre, preferencias, historial) en SQLite / Base de Datos Vectorial por `user_id`.
*   **Memoria Persistente (SQLite):** Reemplazar el diccionario en RAM por una BD ligera para que la memoria sobreviva reinicios del servidor.

### 🌐 2. Módulo de Navegación y Búsqueda Web en Tiempo Real
*   **Detección Automática de Intención:** Detectar preguntas sobre información actual/fresca (noticias, precios, eventos).
*   **Extracción sin API Key:** Usar `duckduckgo_search` (o Tavily API) para extraer los 3 mejores resultados truncados a ~500 caracteres.
*   **Inyección RAG en el Prompt:** Pasar los resultados como contexto temporal al LLM antes de generar la respuesta.

### 📱 3. Despliegue en Dispositivos Móviles (VPS de Bolsillo / Termux)
*   Ejecución 24/7 en Android mediante Termux + `termux-wake-lock` + `pm2`.
*   Vinculación sin QR mediante **Pairing Code** de 8 dígitos de Baileys.

### 🤖 4. Multi-Bot (N Sesiones Simultáneas)
*   Múltiples instancias de Gateway (cada una con su carpeta de sesión independiente).
*   El Cerebro gestiona perfiles y memorias aisladas por `user_id` + `bot_id`.
