# Plan de Arquitectura: SDK-Bot (100% Custom & Store Persistence)

Este documento define las bases para construir nuestro propio sistema Multi-Bot de WhatsApp desde cero, dejando atrás las limitaciones y colisiones de arquitecturas pre-empaquetadas.

## 🎯 Objetivo Principal
Crear una plataforma escalable donde podamos levantar `N` cantidad de bots de WhatsApp, cada uno con su propio número, memoria aislada y personalidad configurable (SOUL), utilizando herramientas modernas y control total del flujo.

---

## ✅ Estado Actual del Proyecto (Implementado con `makeInMemoryStore`)

### 📁 Estructura de Archivos

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Punto de entrada con makeInMemoryStore (~95 líneas)
│   ├── config.js                 # Estado global, URLs y rutas
│   ├── services/
│   │   ├── storageService.js     # Gestor I/O (allowed, ignored, contacts_db, cleanContactsDB)
│   │   ├── metadataService.js    # Smart Delta Sync (TTL 24h), Phone/LID dual, Foto HD y Bio
│   │   └── brainService.js       # Cliente HTTP REST para el Cerebro IA
│   ├── handlers/
│   │   ├── commandHandler.js     # Procesador modular de comandos admin (/search, /sync total, /ignore, etc.)
│   │   └── messageHandler.js     # Pipeline de filtrado y mensajería
│   ├── allowed_numbers.json      # Whitelist (Hot-Reload)
│   ├── ignored_numbers.json      # IgnoreList / Lista Negra (Hot-Reload)
│   ├── contacts_db.json          # Base de datos de contactos PRO (Caché local persistente)
│   └── auth_info_baileys/        # Sesión y Store de Baileys (`baileys_store.json`)
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

## 🏗️ Arquitectura Implementada (Store Persistente + Full Sync)

### 1. Capa de Mensajería (WhatsApp Gateway)
**Tecnología:** Node.js + Baileys

**Componentes:**
*   **Baileys Store Persistente (`baileys_store.json`):**
    *   `makeInMemoryStore` mantiene la base de datos completa de contactos y chats sincronizada con tu teléfono.
    *   Se escribe automáticamente en disco en `auth_info_baileys/baileys_store.json`.
*   **Comando `/sync` de Sincronización Total de Agenda:**
    *   Recorre `store.contacts` (la agenda de tu celular almacenada en el store).
    *   Extrae el `name` (Nombre guardado en tu agenda) de cada contacto.
    *   Puebla `contacts_db.json` con la información completa de la agenda.

---

## 🔒 Flujo de Seguridad y Pipeline de Mensajes

```
Mensaje Entrante en Baileys
│
├── 🗂️ Registro/Actualización en contacts_db.json (savedName, pushName, Teléfono, LID, Bio, isContact)
├── 💾 Indexación en baileys_store.json (store.bind)
│
├── ¿Es un mensaje anti-loop (ID del bot)?  → IGNORAR
├── ¿Es Self-Chat (isFromMe + JID del Admin)?
│   ├── ¿Empieza con /? → EJECUTAR COMANDO ADMIN (/sync total, /search, /ignore, etc.)
│   └── Texto normal   → ASISTENTE PERSONAL IA (brainService)
├── ¿isFromMe en chat de cliente?           → IGNORAR (no interferir)
├── ¿Empieza con / (tercero)?              → BLOQUEAR (seguridad)
├── ¿Bot pausado?                           → IGNORAR
├── ¿Teléfono o LID en ignored_numbers.json?→ SÍ: IGNORAR (Prioridad Alta)
├── ¿Coincide con allowed_numbers.json?     → SÍ: CEREBRO IA | NO: IGNORAR
└── Respuesta de la IA al cliente con Contexto de Agenda
```
