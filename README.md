# 🤖 SDK-Bot

**Plataforma Multi-Bot de WhatsApp 100% Custom & Robust Automation** — Gateway de mensajería con `makeInMemoryStore`, Derivación a Humano (Human Handoff), Acumulador Anti-Spam (De-bounce Queue), Simulación Humana (Typing Delay), Router multi-proveedor, IgnoreList y Base de Datos con Smart Delta Sync.

---

## 🎯 ¿Qué es?

SDK-Bot es un sistema modular para crear bots de WhatsApp inteligentes con:

- **Derivación a Humano (Human-in-the-Loop & Handoff):** Si un cliente pide *"hablar con una persona"*, la IA se pausa **únicamente para ese cliente** y notifica al Admin en Self-Chat (`/auto <num>` para reactivar).
- **Acumulador Anti-Spam (De-bounce Queue):** Acumula frases consecutivas en una ventana de 2.5s antes de consultar a la IA.
- **Simulación Humana (Typing Delay):** Simula el estado `'composing'` durante 1.5s - 4.5s según la longitud de la respuesta antes de responder.
- **Sincronización Total de Agenda (`npm run reset`):** Script automatizado para usuarios finales.
- **Smart Delta Sync (TTL 24h):** Caché local en `contacts_db.json` con refresco inteligente de fotos y bio.
- **Filtro Anti-Basura:** Exclusión automática de Grupos, Comunidades, Canales y Estados.
- **Captura Máxima de Metadatos (PRO Suite):** `savedName`, `pushName`, `bio`, `profilePicUrl`, `isBusiness`, `country`.
- **Cerebro IA** con FastAPI, contexto enriquecido y router multi-proveedor (OpenRouter → Groq → Gemini).

---

## 🚀 Inicio Rápido

### Iniciar Gateway Normalmente:
```bash
cd gateway
npm start
# o: node index.js
```

### Forzar Re-Sincronización Completa de Libreta (Fresh QR):
```bash
cd gateway
npm run reset
# o: node reset-session.js
```

---

## 🎮 Comandos Admin (Self-Chat)

Envía estos comandos desde tu propio chat ("Mensaje a ti mismo"):

| Comando | Descripción |
|---------|-------------|
| `/auto <num/lid>` | Reactivar la IA para un cliente en atención humana (Handoff) |
| `/handoff <num/lid>` | Activar atención humana (pausar IA para ese cliente) |
| `/name <num> <nombre>` | Asignar o renombrar un contacto de tu agenda manualmente |
| `/search <query>` | Buscar un contacto por Nombre de Agenda, Nombre Público, Teléfono o LID |
| `/sync` | Sincronizar contactos activos de la sesión |
| `/contacts` | Ver resumen de contactos registrados (Agenda vs Anónimos vs Handoff) |
| `/export` | Exportar la libreta de contactos mapeados |
| `/status` | Panel de estado del bot y conteo de listas |
| `/help` | Lista de comandos disponibles |
| `/pause` / `/resume` | Pausar o reanudar el auto-respondedor globalmente o por cliente (`/pause <num>`) |
| `/ignore <num/lid>` | Bloquear respuestas automáticas a un contacto o LID |
| `/unignore <num/lid>` | Remover contacto de la IgnoreList |
| `/ignorelist` | Ver lista de contactos/LIDs ignorados |
| `/allow <num/lid/*>` | Agregar número/LID a whitelist (`*` = público) |
| `/remove <num/lid>` | Remover número/LID de whitelist |
| `/list` | Ver todos los números permitidos |
| `/info` | Ver datos de conexión admin (Phone, LID, País) |
| `/profile <nombre>` | Cambiar personalidad (`default`, `lucia`, `mateo`) |

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
