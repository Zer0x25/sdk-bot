# Plan de Arquitectura: SDK-Bot (100% Custom & Modular)

Este documento define las bases para construir nuestro propio sistema Multi-Bot de WhatsApp desde cero, dejando atrás las limitaciones y colisiones de arquitecturas pre-empaquetadas.

## 🎯 Objetivo Principal
Crear una plataforma escalable donde podamos levantar `N` cantidad de bots de WhatsApp, cada uno con su propio número, memoria aislada y personalidad configurable (SOUL), utilizando herramientas modernas y control total del flujo.

---

## ✅ Estado Actual del Proyecto (Refactorizado & Smart Sync)

### 📁 Estructura de Archivos

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Punto de entrada ultraligero (~45 líneas)
│   ├── config.js                 # Estado global, URLs y rutas
│   ├── services/
│   │   ├── storageService.js     # Gestor I/O atómico (allowed, ignored, contacts_db, cleanContactsDB)
│   │   ├── metadataService.js    # Smart Delta Sync (TTL 24h), Phone/LID dual, Foto HD y Bio
│   │   └── brainService.js       # Cliente HTTP REST para el Cerebro IA
│   ├── handlers/
│   │   ├── commandHandler.js     # Procesador modular de comandos admin (/search, /sync, /ignore, etc.)
│   │   └── messageHandler.js     # Pipeline de filtrado y mensajería
│   ├── allowed_numbers.json      # Whitelist (Hot-Reload)
│   ├── ignored_numbers.json      # IgnoreList / Lista Negra (Hot-Reload)
│   ├── contacts_db.json          # Base de datos de contactos PRO (Caché local persistente)
│   └── auth_info_baileys/        # Sesión WhatsApp (auto-generada)
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

## 🏗️ Arquitectura Implementada (Dos Capas Modulares)

### 1. Capa de Mensajería (WhatsApp Gateway)
**Tecnología:** Node.js + Baileys

**Componentes:**
*   **Sincronización Incremental Inteligente (Smart Delta Sync):**
    *   **Caché en Disco:** `contacts_db.json` actúa como fuente local persistente.
    *   **Refresco TTL (24 Horas):** `enrichContactExtraData` solo consulta fotos de perfil o biografías a la red si han pasado más de 24 horas (`lastEnrichedAt`).
    *   **Filtro Anti-Basura:** Excluye automáticamente grupos (`@g.us`), canales (`@newsletter`), broadcast (`status@broadcast`) y entradas fantasma sin identidad.
    *   **Historial Inicial:** Escucha el evento nativo `messaging-history.set` para capturar la libreta al primer inicio.
*   **Servicio de Almacenamiento (`storageService.js`):** Escritura atómica, migración automática de claves LID a Teléfono y limpieza en tiempo real.
*   **Manejador de Comandos (`commandHandler.js`):** Panel admin completo en Self-Chat (`/search`, `/sync`, `/contacts`, `/export`, `/ignore`, `/unignore`, `/allow`, `/remove`, `/status`, `/info`, `/profile`).

---

### 2. Capa de Inteligencia (Cerebro IA)
**Tecnología:** Python + FastAPI

**Componentes:**
*   **Aplicación Principal (`main.py`):** Endpoints REST con validación Pydantic (`ChatRequest`).
*   **Router Multi-Proveedor (`providers.py`):** OpenRouter → Groq → Gemini.

---

## 🔒 Flujo de Seguridad y Pipeline de Mensajes

```
Mensaje Entrante en Baileys
│
├── 🗂️ Actualización en contacts_db.json (savedName, pushName, Teléfono, LID, Bio, isContact)
├── 🧠 Smart TTL Check (¿lastEnrichedAt < 24h? SÍ: Omitir Red | NO: Consultar Foto/Bio)
│
├── ¿Es un mensaje anti-loop (ID del bot)?  → IGNORAR
├── ¿Es Self-Chat (isFromMe + JID del Admin)?
│   ├── ¿Empieza con /? → EJECUTAR COMANDO ADMIN (commandHandler: /search, /sync, etc.)
│   └── Texto normal   → ASISTENTE PERSONAL IA (brainService)
├── ¿isFromMe en chat de cliente?           → IGNORAR (no interferir)
├── ¿Empieza con / (tercero)?              → BLOQUEAR (seguridad)
├── ¿Bot pausado?                           → IGNORAR
├── ¿Teléfono o LID en ignored_numbers.json?→ SÍ: IGNORAR (Prioridad Alta)
├── ¿Coincide con allowed_numbers.json?     → SÍ: CEREBRO IA | NO: IGNORAR
└── Respuesta de la IA al cliente con Contexto de Agenda
```
