# ADR 002: Tres Procesos y Dos Planos (Datos / Control)

## 1. Contexto y Problema
Con el hub multi-canal (ADR-001) surgió confusión conceptual recurrente: ¿el panel es un canal?, ¿Baileys es parte del gateway o un servicio aparte?, ¿quién le habla al brain? Sin contratos explícitos entre procesos, cada feature nueva podía acoplar componentes que debían permanecer independientes (ej: el panel tocando sockets de WhatsApp directamente).

## 2. Decisión
El sistema son **tres procesos** con responsabilidades exclusivas y dependencia estrictamente unidireccional:

| Proceso | Puerto | Responsabilidad única |
|---|---|---|
| **gateway** (`gateway/index.js`) | bus 5400 · status 5300 | Dueño de TODOS los canales (adapters), del pipeline de mensajes, del estado persistente (contacts/settings DB) y de los comandos admin. Es el ÚNICO proceso que habla con redes de mensajería |
| **brain** (`brain/main.py`) | 5100 | Inteligencia pura: proveedores IA (Gemini primary → Groq → OpenRouter, orden tunable), memoria conversacional (memory.db), perfiles SOUL. No sabe qué es WhatsApp ni Telegram |
| **panel** (`gateway/panel/index.js`) | 5201 | Plano de control: sirve UI estática y proxifica `/api/*` al bus interno del gateway. No tiene acceso directo a ningún canal |

Reglas de dependencia (nunca se invierten):
```
panel → bus(5400) → gateway → brain(5100)
```
- El panel JAMÁS importa código del gateway ni toca Baileys/Telegram: todo pasa por HTTP loopback del bus.
- El gateway JAMÁS conoce proveedores ni API keys de modelos: delega en el brain vía REST.
- El brain no inicia conexiones salientes hacia canales.

Distinción clave:
- **Plano de datos** = canales (WhatsApp, Telegram): conversaciones con clientes/admin.
- **Plano de control** = panel + bus + status server: administración, observabilidad, pairing.

Baileys NO es un proceso: es una librería encapsulada dentro de `whatsappAdapter.js`. Reemplazarla solo afecta a ese archivo.

## 3. Consecuencias
### Positivas
- El panel puede caerse/reiniciarse sin tocar sesiones de mensajería; lo mismo aplica entre gateway y brain.
- Superficie de seguridad clara: solo loopback local; las API keys viven únicamente en `brain/.env`.
- Cada proceso escala y reinicia de forma independiente (Docker por unidad; en dev `deploy/linux/dev.sh up|down|status`). El systemd legacy (`deploy/linux/*.service` + `install.sh`) fue eliminado.
- Tests: el contrato HTTP entre procesos permite mockear cualquiera de los lados.

### Negativas / Trade-offs
- Tres procesos que orquestar (launcher `deploy/linux/dev.sh`, compose con healthchecks).
- El bus interno duplica como HTTP lo que antes eran llamadas en memoria: latencia trivial pero más código de serialización.
- Cambiar el contrato del bus exige actualizar panel y gateway a la vez (versionado manual, mitigado con tests de contrato).
