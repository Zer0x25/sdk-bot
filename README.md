# 🤖 SDK-Bot

**Plataforma Multi-Bot de WhatsApp 100% Custom & Modular** — Gateway de mensajería + Cerebro IA con router multi-proveedor, fallback automático, IgnoreList, Base de Datos de Contactos y Suite de Metadatos PRO.

---

## 🎯 ¿Qué es?

SDK-Bot es un sistema modular para crear bots de WhatsApp inteligentes con:

- **Estructura Modular & Desacoplada** en capas limpias de configuración, servicios y manejadores.
- **Conexión WhatsApp** vía Baileys (QR + reconexión automática).
- **Captura Máxima de Metadatos (PRO Suite):**
  - **`savedName`**: Nombre guardado en tu agenda del teléfono (ej: *"Mamá"*, *"Tío Juan"*).
  - **`pushName`**: Nombre público configurado por el usuario en WhatsApp.
  - **`bio` / `status`**: Biografía o estado de WhatsApp.
  - **`profilePicUrl`**: Foto de perfil HD.
  - **`isBusiness`**: Detección de cuentas de empresa.
- **Base de Datos de Contactos Automática (`contacts_db.json`)** con mapeo Teléfono ↔ LID ↔ Agenda ↔ Público.
- **Filtro Escalonado (IgnoreList > Whitelist)** para excluir contactos personales o familiares en producción.
- **Cerebro IA** con FastAPI, contexto enriquecido y router multi-proveedor (OpenRouter → Groq → Gemini).
- **Panel de control remoto** desde el Self-Chat de WhatsApp (búsqueda, listas, control de perfil).

---

## 📁 Estructura del Proyecto Refactorizado

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
│   ├── allowed_numbers.json      # Whitelist de números/LIDs (Hot-Reload)
│   ├── ignored_numbers.json      # IgnoreList / Lista Negra (Hot-Reload)
│   ├── contacts_db.json          # Base de datos de contactos mapeados con metadatos completos
│   └── auth_info_baileys/        # Sesión WhatsApp (auto-generada, gitignored)
├── brain/                        # Capa de Inteligencia (Python + FastAPI)
│   ├── main.py                   # Aplicación FastAPI modularizada
│   ├── config.py                 # API Keys, perfiles SOUL y modelos
│   ├── memory.py                 # Gestor de memoria por user_id
│   ├── providers.py              # Router multi-proveedor (OpenRouter → Groq → Gemini)
│   ├── .env                      # API Keys (gitignored)
│   └── requirements.txt          # Dependencias Python
├── PLAN-ARQUITECTURA.md          # Documentación técnica completa
└── .gitignore
```

---

## 🎮 Comandos Admin (Self-Chat)

Envía estos comandos desde tu propio chat ("Mensaje a ti mismo"):

| Comando | Descripción |
|---------|-------------|
| `/search <query>` | Buscar un contacto por Nombre de Agenda, Nombre Público, Teléfono o LID |
| `/contacts` | Ver resumen de contactos registrados (Agenda vs Anónimos) |
| `/export` | Exportar la libreta de contactos mapeados |
| `/status` | Panel de estado del bot y conteo de listas |
| `/help` | Lista de comandos disponibles |
| `/pause` / `/resume` | Pausar o reanudar el auto-respondedor |
| `/ignore <num/lid>` | Bloquear respuestas automáticas a un contacto o LID |
| `/unignore <num/lid>` | Remover contacto de la IgnoreList |
| `/ignorelist` | Ver lista de contactos/LIDs ignorados |
| `/allow <num/lid/*>` | Agregar número/LID a whitelist (`*` = público) |
| `/remove <num/lid>` | Remover número/LID de whitelist |
| `/list` | Ver todos los números permitidos |
| `/info` | Ver datos de conexión admin (Phone, LID, País) |
| `/profile <nombre>` | Cambiar personalidad (`default`, `lucia`, `mateo`) |

> 💡 Los textos normales en Self-Chat activan el modo **Asistente Personal IA**.

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
