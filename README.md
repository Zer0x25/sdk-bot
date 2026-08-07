# 🤖 SDK-Bot

**Plataforma Multi-Bot de WhatsApp 100% Custom** — Gateway de mensajería + Cerebro IA con router multi-proveedor y fallback automático.

---

## 🎯 ¿Qué es?

SDK-Bot es un sistema modular para crear bots de WhatsApp inteligentes con:

- **Conexión WhatsApp** vía Baileys (QR + reconexión automática)
- **Cerebro IA** con FastAPI y router multi-proveedor (OpenRouter → Groq → Gemini)
- **Panel de control remoto** desde el Self-Chat de WhatsApp
- **Whitelist hot-reload** sin reiniciar el servidor
- **Perfiles de personalidad (SOUL)** intercambiables en caliente
- **Simulación humana** (estado "escribiendo..." + pausa artificial)

---

## 📁 Estructura del Proyecto

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Gateway WhatsApp
│   ├── allowed_numbers.json      # Whitelist de números/LIDs
│   ├── package.json              # Dependencias Node.js
│   └── auth_info_baileys/        # Sesión WhatsApp (auto-generada, gitignored)
├── brain/                        # Capa de Inteligencia (Python + FastAPI)
│   ├── main.py                   # API REST del Cerebro IA
│   ├── .env                      # API Keys (gitignored)
│   ├── requirements.txt          # Dependencias Python
│   └── venv/                     # Entorno virtual
├── PLAN-ARQUITECTURA.md          # Documentación técnica completa
└── .gitignore
```

---

## 🏗️ Arquitectura

```
┌─────────────────────┐       HTTP POST /chat       ┌─────────────────────┐
│   WhatsApp Gateway  │ ──────────────────────────▶  │    Cerebro IA       │
│   (Node.js/Baileys) │ ◀──────────────────────────  │  (Python/FastAPI)   │
│                     │        JSON Response         │                     │
│  • Filtros          │                              │  • Multi-Proveedor  │
│  • Anti-loop        │                              │  • Fallback Auto    │
│  • Admin Commands   │                              │  • Perfiles SOUL    │
│  • Whitelist        │                              │  • Memoria x user   │
└─────────────────────┘                              └─────────────────────┘
```

### Router Multi-Proveedor (Fallback Automático)

| Prioridad | Proveedor   | Modelo                        |
|-----------|-------------|-------------------------------|
| 🥇 Primario | OpenRouter  | `openai/gpt-oss-20b:free`    |
| 🥈 Fallback 1 | Groq       | `llama-3.3-70b-versatile`    |
| 🥉 Fallback 2 | Gemini     | `gemini-flash-latest`        |

Si un proveedor responde con `429 (Rate Limit)` o falla, el sistema conmuta automáticamente al siguiente sin afectar la experiencia del usuario.

---

## ⚡ Instalación

### Requisitos
- **Node.js** ≥ 18
- **Python** ≥ 3.10

### 1. Gateway (WhatsApp)

```bash
cd gateway
npm install
node index.js
```

> Escanea el código QR con tu WhatsApp al primer inicio.

### 2. Cerebro IA

```bash
cd brain
python -m venv venv
source venv/bin/activate    # Linux/Mac
# venv\Scripts\activate     # Windows
pip install -r requirements.txt
```

Crea el archivo `.env`:

```env
GROQ_API_KEY=tu_key_aqui
OPENROUTER_API_KEY=tu_key_aqui
GEMINI_API_KEY=tu_key_aqui
```

Inicia el servidor:

```bash
uvicorn main:app --host 0.0.0.0 --port 3001
```

---

## 🎮 Comandos Admin (Self-Chat)

Envía estos comandos desde tu propio chat ("Mensaje a ti mismo"):

| Comando | Descripción |
|---------|-------------|
| `/status` | Panel de estado del bot |
| `/help` | Lista de comandos disponibles |
| `/pause` | Pausar el auto-respondedor |
| `/resume` | Reanudar el auto-respondedor |
| `/allow <num>` | Agregar número a whitelist |
| `/remove <num>` | Remover número de whitelist |
| `/list` | Ver todos los números permitidos |
| `/profile <nombre>` | Cambiar personalidad (`default`, `lucia`, `mateo`) |

> 💡 Los textos normales en Self-Chat activan el modo **Asistente Personal IA**.

---

## 🔒 Seguridad

- ✅ Solo los números en `allowed_numbers.json` reciben respuestas (`*` = público)
- ✅ Los clientes **no pueden** ejecutar comandos de administración
- ✅ Si el admin responde manualmente a un cliente, el bot se inhabilita en ese chat
- ✅ Registro anti-loop previene auto-respuestas infinitas
- ✅ Credenciales y sesiones excluidas de git

---

## 🗺️ Roadmap

- [x] Gateway WhatsApp con Baileys (QR + reconexión)
- [x] Cerebro IA con FastAPI
- [x] Puente Gateway ↔ Cerebro via HTTP REST
- [x] Simulación de tiempos humanos
- [x] Router multi-proveedor con fallback
- [ ] Memoria persistente (SQLite)
- [ ] Compresión de contexto para historiales largos
- [ ] Búsqueda web en tiempo real (RAG)
- [ ] Despliegue en Termux (Android 24/7)
- [ ] Multi-Bot (N sesiones simultáneas)

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
