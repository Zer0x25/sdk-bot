# ADR 004: Resiliencia de la Interacción (Timeouts, Colas y Guardas)

## 1. Contexto y Problema
La interacción gateway ↔ brain ↔ canales atraviesa tres redes distintas (WS de Baileys, Bot API, HTTP local al brain). Un sistema así es tan robusto como su peor espera sin techo: se detectaron `fetch` sin timeout (`clearAIMemory` podía colgar un comando admin indefinidamente), y Node por defecto **tumba el proceso** ante una promesa rechazada no manejada — un solo `.catch` olvidado en cualquier cola o poller derribaría WhatsApp Y Telegram a la vez.

## 2. Decisión
Cinco reglas explícitas, aplicadas en código:

1. **Todo fetch saliente lleva `AbortSignal.timeout(ms)` declarado.** Sin excepciones. El valor expresa el contrato (chat IA 90s por generación lenta; operaciones administrativas/perfiles 5s; health 4s).
2. **Errores clasificados antes de reaccionar**: HTTP 4xx = bug/validación → NO se reintenta y se informa tal cual; red/timeout/5xx = transitorio → 1 reintento con backoff corto.
3. **El mensaje del cliente jamás se pierde en silencio**: si el brain está caído, `messageQueue` lo persiste en disco (JSONL) y lo reprocesa al volver; el admin recibe alerta con throttle de 15 min (sin spam bajo tormenta de clientes).
4. **Simulación humana separada y pura** (`services/humanSim.js`): split en globos y cálculo de delays sin I/O ni estado global — testeable y reutilizable por cualquier canal.
5. **Guardas de proceso** (gateway): `unhandledRejection`/`uncaughtException` se registran con contador. Solo si hay ≥4 fallos en <60s (estado posiblemente corrupto) se sale con código 1 para que el supervisor levante un proceso sano. Fallos aislados NO tumbean los canales.

Anti-objetivo deliberado: no se añaden circuit breakers, retries exponenciales genéricos ni colas de salida para todos los canales. La cola persistente existe SOLO para la dependencia crítica (brain); los envíos de canal ya tienen sus propias políticas por servicio (broadcast/queue con contadores de intento). Complejidad solo donde el fallo cobra mensajes reales.

## 3. Consecuencias
### Positivas
- Ninguna espera indefinida: todo camino tiene techo temporal explícito y visible en código.
- Degradación predecible: brain caído → respuestas encoladas + alerta clara; fallo puntual de código → log ERROR y sistema vivo.
- Los contratos de error (4xx vs transitorio) están centralizados en el cliente del brain, no dispersos.

### Negativas / Trade-offs
- Log-and-continue ante fallos graves puede enmascarar bugs si nadie mira logs: mitigado por el umbral de salida y por las alertas al admin/panel.
- Los timeouts son contratos manuales: una operación nueva del brain exige elegir uno explícito (no hay default silencioso).
