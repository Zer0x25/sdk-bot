# Plan de Arquitectura: SDK-Bot (100% Custom & Modular)

Este documento define las bases para construir nuestro propio sistema Multi-Bot de WhatsApp desde cero, dejando atrás las limitaciones y colisiones de arquitecturas pre-empaquetadas.

## 🎯 Objetivo Principal
Crear una plataforma escalable donde podamos levantar `N` cantidad de bots de WhatsApp, cada uno con su propio número, memoria aislada y personalidad configurable (SOUL), utilizando herramientas modernas y control total del flujo.

---

## ✅ Estado Actual del Proyecto (Refactorizado & Modular)

### 📁 Estructura de Archivos

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Punto de entrada ultraligero (~45 líneas)
│   ├── config.js                 # Estado global, URLs y rutas
│   ├── services/
│   │   ├── storageService.js     # Gestor I/O de JSONs (allowed, ignored, contacts_db)
│   │   ├── metadataService.js    # Extracción dual Phone/LID, Países, Foto de perfil HD y Bio
│   │   └── brainService.js       # Cliente HTTP REST para el Cerebro IA
│   ├── handlers/
│   │   ├── commandHandler.js     # Procesador modular de comandos admin en Self-Chat
│   │   └── messageHandler.js     # Pipeline de filtrado y mensajería
│   ├── allowed_numbers.json      # Whitelist (Hot-Reload)
│   ├── ignored_numbers.json      # IgnoreList / Lista Negra (Hot-Reload)
│   ├── contacts_db.json          # Base de datos de contactos PRO
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
*   **Punto de Entrada (`index.js`):** Gestiona el ciclo de vida del socket de Baileys, eventos de reconexión y sincronización de libreta.
*   **Servicio de Almacenamiento (`storageService.js`):** Métodos atómicos para persistir `allowed_numbers`, `ignored_numbers` y `contacts_db`.
*   **Servicio de Metadatos (`metadataService.js`):** Extracción dual Phone/LID, resolución de agenda (`savedName` vs `pushName`), fotos de perfil y biografía.
*   **Servicio Cerebro (`brainService.js`):** Comunicación asíncrona HTTP POST `/chat` con estado `composing` y simulación humana.
*   **Manejador de Comandos (`commandHandler.js`):** Panel admin completo en Self-Chat (`/search`, `/contacts`, `/export`, `/ignore`, `/unignore`, `/allow`, `/remove`, `/status`, `/info`, `/profile`).
*   **Pipeline de Mensajes (`messageHandler.js`):** Filtrado ordenado: Anti-loop → Self-Chat → Ignorado forzado en chat cliente → Bloqueo de comandos externos → Pausa global → IgnoreList → Whitelist → Cerebro.

---

### 2. Capa de Inteligencia (Cerebro IA)
**Tecnología:** Python + FastAPI

**Componentes:**
*   **Aplicación Principal (`main.py`):** Endpoints REST con validación Pydantic (`ChatRequest`).
*   **Router Multi-Proveedor (`providers.py`):**
    1.  **Primario:** OpenRouter → `openai/gpt-oss-20b:free`
    2.  **Fallback 1:** Groq → `llama-3.3-70b-versatile`
    3.  **Fallback 2:** Google Gemini → `gemini-flash-latest`
*   **Gestor de Memoria (`memory.py`):** Persistencia en RAM del historial por `user_id`.

---

## 🔒 Flujo de Seguridad y Pipeline de Mensajes

```
Mensaje Entrante en Baileys
│
├── 🗂️ Actualización en contacts_db.json (savedName, pushName, Teléfono, LID, Bio, isContact)
├── 🔄 Enriquecimiento Asíncrono (Foto de perfil HD & Biografía)
│
├── ¿Es un mensaje anti-loop (ID del bot)?  → IGNORAR
├── ¿Es Self-Chat (isFromMe + JID del Admin)?
│   ├── ¿Empieza con /? → EJECUTAR COMANDO ADMIN (commandHandler)
│   └── Texto normal   → ASISTENTE PERSONAL IA (brainService)
├── ¿isFromMe en chat de cliente?           → IGNORAR (no interferir)
├── ¿Empieza con / (tercero)?              → BLOQUEAR (seguridad)
├── ¿Bot pausado?                           → IGNORAR
├── ¿Teléfono o LID en ignored_numbers.json?→ SÍ: IGNORAR (Prioridad Alta)
├── ¿Coincide con allowed_numbers.json?     → SÍ: CEREBRO IA | NO: IGNORAR
└── Respuesta de la IA al cliente con Contexto de Agenda
```
