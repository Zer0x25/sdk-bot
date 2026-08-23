# ADR 003: Dueño Único del Transporte por Canal

## 1. Contexto y Problema
Telegram tenía **dos loops de long-polling** compitiendo por `getUpdates` con el mismo token y offsets separados: el poller del bus interno (para comandos admin) y el `poll()` del adaptador (para el pipeline). Cada update caía en uno u otro según una carrera no determinista: un comando podía ejecutarse, perderse o entrar como mensaje de cliente. Además, `whatsappAdapter` registraba handlers de eventos sin capturar la referencia del socket de esa conexión, permitiendo que eventos de sockets viejos se procesaran tras un reconnect.

Patrón general del bug: **dos consumidores para una misma fuente de eventos**.

## 2. Decisión
Regla arquitectónica: **cada fuente de transporte tiene exactamente UN dueño, y es su adapter**.

1. **El adapter es el único consumidor** de su transporte (`getUpdates`, socket de Baileys). Ningún otro módulo inicia polls ni lee sockets ajenos.
2. El adapter solo **normaliza y emite**: traduce el evento nativo a `StandardMessage` y lo publica vía EventEmitter. No decide qué hacer con él.
3. **Las decisiones son puras** (`services/pipeline.js::decideMessageFlow`): entradas → descriptor de acción (`respond`, `self_chat_ai`, `admin_command`, `handoff`, `ignore`). Sin I/O, 100% testeable.
4. **Los efectos viven en `handlers/messageHandler.js`**: debounce, typing, colas, persistencia. Consume decisiones, no transportes.
5. **Los comandos admin convergen en un único runner** (`services/adminCommandRunner.js`) usado por las tres superficies admin: self-chat de WhatsApp, chat admin de Telegram (vía pipeline SCENARIO 1) y terminal del panel (vía bus `/command`). Mismo dispatcher, mismas respuestas normalizadas.
6. **Recarga en caliente sin loops duplicados**: reconfigurar un canal usa regeneración explícita (contador de generación en el loop del adapter, callbacks inyectados al bus tipo `setQrRefresh`/`setPairingCodeRequester`/`setTelegramReloader`), nunca un segundo consumidor.

## 3. Consecuencias
### Positivas
- Determinismo total: cada update se procesa exactamente una vez y por quien corresponde.
- Agregar un canal = implementar adapter + conectar sus eventos; cero cambios en pipeline/commands.
- Los tres puntos de administración (WA self-chat, TG admin, panel) garantizan comportamiento idéntico.
- La lógica de decisión se testea sin red ni sockets.

### Negativas / Trade-offs
- Todo feature "que escuche mensajes" debe pasar por el pipeline; no hay atajos leyendo el transporte (esto es intencional).
- El patrón generación/callback exige disciplina al tocar adapters: capturar referencias locales del socket/ciclo actual e invalidar ciclos viejos.
