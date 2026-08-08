# 🤖 SDK-Bot

**Plataforma Multi-Bot de WhatsApp 100% Custom & Full Agenda Sync** — Gateway de mensajería con `makeInMemoryStore` + Cerebro IA con router multi-proveedor, fallback automático, IgnoreList, Base de Datos de Contactos con Smart Delta Sync y Suite de Metadatos PRO.

---

## 🎯 ¿Qué es?

SDK-Bot es un sistema modular para crear bots de WhatsApp inteligentes con:

- **Sincronización Total de Agenda (`npm run reset` / `node reset-session.js`):** Script automatizado para usuarios finales que elimina la sesión previa y genera un nuevo QR de sincronización masiva de libreta.
- **Smart Delta Sync (TTL 24h):** Caché local en `contacts_db.json` con refresco inteligente de fotos y bio cada 24 horas.
- **Filtro Anti-Basura:** Exclusión automática de Grupos, Comunidades, Canales y Estados.
- **Conexión WhatsApp** vía Baileys (QR + reconexión automática).
- **Captura Máxima de Metadatos (PRO Suite):**
  - **`savedName`**: Nombre guardado en tu agenda del teléfono (ej: *"Mamá"*, *"Tío Juan"*).
  - **`pushName`**: Nombre público configurado por el usuario en WhatsApp.
  - **`bio` / `status`**: Biografía o estado de WhatsApp.
  - **`profilePicUrl`**: Foto de perfil HD.
  - **`isBusiness`**: Detección de cuentas de empresa.
- **Filtro Escalonado (IgnoreList > Whitelist)** para excluir contactos personales o familiares en producción.
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
| `/name <num> <nombre>` | Asignar o renombrar un contacto de tu agenda manualmente |
| `/search <query>` | Buscar un contacto por Nombre de Agenda, Nombre Público, Teléfono o LID |
| `/sync` | Sincronizar contactos activos de la sesión |
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

---

## 📄 Licencia

Proyecto privado. Todos los derechos reservados.
