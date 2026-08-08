# 🤖 SDK-Bot

**Plataforma Multi-Bot de WhatsApp 100% Custom, Smart Sync & Automated Handoff** — Gateway de mensajería modular en Node.js + Cerebro IA en Python FastAPI con router multi-proveedor (OpenRouter → Groq → Gemini).

---

## 🎯 Características Principales

- **🤝 Derivación a Humano (Single-User Handoff):** Si un cliente pide *"hablar con un asesor"*, la IA se pausa **únicamente para ese cliente** y notifica al Admin en Self-Chat (`/auto <num>` para reactivar).
- **🧠 De-bounce Queue (8s Timer de Inactividad Pos-Escritura):** Acumula mensajes consecutivos. Si el usuario escribe despacio (`composing`), los temporizadores se renuevan continuamente sin cortar la idea del cliente.
- **⏱️ Auto-Expiración de Escritura (4.5s):** Si el cliente se arrepiente y borra lo que escribía, el estado expira automáticamente a los 4.5s y arranca los 8s de silencio.
- **🛡️ Simulación Humana Ultra-Realista (Multi-Bubble & Jitter Rate Limiter):** 
  - Simula tiempo de **lectura/pensamiento** inicial (1s - 3s) antes de encender el teclado.
  - Velocidad de tecleo natural a ritmo humano (7 a 10 char/s, 100ms - 135ms por carácter) con **varianza aleatoria estocástica (jitter)** para evadir algoritmos de detección de Meta.
  - Fragmenta respuestas largas en **varios globos de chat secuenciales (Multi-Bubble)** de ~180 caracteres con micro-pausas interactivas.
- **🌎 Detección Automática de País e Idioma Nativo:**
  - Cobertura completa de prefijos telefónicos de toda América (Sur, Centro, Norte y Caribe) y Europa.
  - Inyección automática del **idioma del cliente** (Portugués, Inglés, Francés, Alemán, Italiano, Neerlandés, etc.) al prompt de la IA para ofrecer atención en su idioma nativo si es diferente al español.
- **🚨 Alertas Silenciosas de Error al Self-Chat:** 
  - Los errores técnicos o caídas de la IA **nunca se envían al cliente**. 
  - En su lugar, el sistema notifica en privado al Self-Chat del Admin con el nombre del cliente, teléfono, país, mensaje original y el comando rápido `/handoff <num>` para tomar la conversación.
- **🗂️ Base de Datos de Contactos (`contacts_db.json`) con Smart Delta Sync:**
  - Persistencia de `savedName` (Agenda), `pushName` (Público), `phone`, `lid`, `country`, `language`, `profilePicUrl` HD, `bio` e `isBusiness`.
  - Refresco inteligente TTL de 24 horas para foto y biografía.
  - Inserciones masivas ultra-rápidas en lote (`bulkUpsertContactsMetadata`).
- **🚀 Re-Sincronización Automatizada (`npm run reset`):** Script `reset-session.js` para limpiar sesión y escanear un QR nuevo con descarga masiva de libreta.
- **🔒 Privacidad & Seguridad Total:** `contacts_db.json`, `auth_info_baileys/`, `.env` e `ignored_numbers.json` protegidos en `.gitignore`.

---

## 📁 Estructura del Proyecto

```
SDK-Bot/
├── gateway/                      # Capa de Mensajería (Node.js + Baileys)
│   ├── index.js                  # Punto de entrada ultraligero
│   ├── reset-session.js          # Script de re-sincronización de libreta (npm run reset)
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
├── brain/                        # Capa de Inteligencia (Python + FastAPI)
│   ├── main.py                   # Aplicación FastAPI modularizada
│   ├── config.py                 # API Keys, perfiles SOUL y modelos
│   ├── memory.py                 # Gestor de memoria por user_id
│   ├── providers.py              # Router multi-proveedor (OpenRouter → Groq → Gemini)
│   ├── .env                      # API Keys (gitignored)
│   └── requirements.txt          # Dependencias Python
└── PLAN-ARQUITECTURA.md          # Documentación técnica completa
```

---

## 🚀 Inicio Rápido

### 1. Iniciar Cerebro IA (Python FastAPI):
```bash
cd brain
venv\Scripts\python.exe main.py
```

### 2. Iniciar Gateway WhatsApp (Node.js):
```bash
cd gateway
npm start
# o: node index.js
```

### 3. Re-sincronizar Libreta Completa de Contactos (Fresh QR):
```bash
cd gateway
npm run reset
```

---

## 🎮 Comandos Admin (Self-Chat en WhatsApp)

Envía estos comandos desde tu propio chat de WhatsApp ("Mensaje a ti mismo"):

| Comando | Descripción |
|---------|-------------|
| `/auto <num/lid>` | Reactivar la IA para un cliente en atención humana (Handoff) |
| `/handoff <num/lid>` | Activar atención humana (pausar IA únicamente para ese cliente) |
| `/name <num> <nombre>` | Asignar o renombrar un contacto de tu agenda manualmente |
| `/search <query>` | Buscar un contacto por Nombre de Agenda, Nombre Público, Teléfono o LID |
| `/sync` | Ejecutar sincronización incremental de contactos activos |
| `/contacts` | Ver resumen de contactos registrados (Agenda vs Anónimos vs Handoff) |
| `/export` | Exportar la libreta de contactos mapeados |
| `/status` / `/help` | Panel de estado del bot y lista de comandos |
| `/pause` / `/resume` | Pausar o reanudar el auto-respondedor globalmente o por cliente (`/pause <num>`) |
| `/ignore <num/lid>` | Agregar un número o LID a la IgnoreList |
| `/unignore <num/lid>` | Remover de la IgnoreList |
| `/ignorelist` | Ver lista de números e IDs ignorados |
| `/allow <num/lid/*>` | Agregar número/LID a whitelist (`*` = público) |
| `/remove <num/lid>` | Remover número/LID de whitelist |
| `/list` | Ver todos los números permitidos |
| `/info` | Ver datos de conexión admin (Phone, LID, País) |
| `/profile <nombre>` | Cambiar personalidad del bot (`default`, `lucia`, `mateo`) |

> 💡 Los textos normales enviados en Self-Chat activan el modo **Asistente Personal IA**.

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
