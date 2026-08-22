# ADR 001: Arquitectura Multi-Canal (Adapter Hub)

## 1. Contexto y Problema
Históricamente, el Gateway de **SDK-Bot** fue diseñado con una fuerte dependencia de la librería Baileys para conectarse exclusivamente a WhatsApp. Todas las funciones del core (`messageHandler`, `commandHandler`, `internalBus`) asumían el uso de IDs nativos de WhatsApp (JIDs) y operaban directamente sobre la instancia del socket de Baileys. Esto impedía escalar la plataforma a otros canales de comunicación (como Telegram o Web) sin duplicar toda la lógica del bot y del pipeline.

## 2. Decisión
Se introdujo un patrón de diseño **Hub-and-Adapter**.
1. **ChannelAdapter**: Se creó una clase abstracta base `ChannelAdapter` que define un contrato estandarizado (`connect`, `disconnect`, `sendMessage`, `sendPresenceUpdate`).
2. **Adaptadores Concretos**: La lógica específica de Baileys se encapsuló dentro de `WhatsappAdapter`, y se creó un nuevo `TelegramAdapter`.
3. **StandardMessage**: Los eventos entrantes de cualquier canal se normalizan a una instancia de `StandardMessage`, proporcionando a los pipelines un formato agnóstico.
4. **IDs Compuestos**: Para mantener las memorias y bases de datos aisladas por canal, las IDs remotas ahora usan el prefijo del canal: `whatsapp:<numero>` o `telegram:<chat_id>`.

## 3. Consecuencias
### Positivas
- **Escalabilidad**: Es trivial agregar nuevos canales de entrada (ej: un canal Webhook, Instagram, etc) implementando la clase `ChannelAdapter`.
- **Desacoplamiento**: El Core (Base de Datos, Comandos, LLM) ya no depende de la implementación subyacente de la red de WhatsApp.
- **Mantenimiento**: Los cambios en la API de Baileys (o Telegram) solo requieren modificar su respectivo adaptador, manteniendo seguro el core.

### Negativas / Trade-offs
- **Refactorización de Datos**: Se requirió migrar las claves de la base de datos de contactos para soportar los IDs compuestos (`whatsapp:JID`).
- **Complejidad de UI**: El panel de administración (Webpanel) ahora debe gestionar el estado de conexión de manera múltiple, agregando algo de complejidad al frontend.
