# ADR 006: admisión durable antes del consumidor legacy

Fecha: 2026-10-19. Estado: aceptada para la transición F2.
Complementa ADR-003/005; implementación inicial WA en F2B.2.

## Contexto

ADR-003 indicaba que el adapter solo normaliza/emite y el handler concentra
efectos. EventEmitter no espera handlers async: emitir y continuar permite
automatización antes del commit, además de formar colas sin límite. El handler
legacy filtra texto, permisos y pausa antes de disponer de captura independiente.
El archivo F2A necesita conservar también historia, ecos y marcadores multimedia.

## Decisión

Se amplían los puntos 2 y 4 de ADR-003: durante la transición, el adapter puede
esperar un coordinador de admisión durable inyectado por el gateway antes de
emitir `message` al consumidor legacy. La persistencia está en
`services/conversations/whatsappCapture.js`, no en el handler ni en SQL dentro
del adapter. El gateway compone el único archivo, su purga y su ciclo de vida.

- El adapter conserva normalización de transporte, clasificación de origen y
  protección de su socket; ningún segundo consumidor lee Baileys.
- La coordinación captura independiente de elegibilidad de IA, con cola acotada
  y confirmación de commit. Resultados duplicados/históricos/cuarentena no admiten
  automatización nueva. Un error no simula éxito ni activa retry de escritura.
- El coordinador recibe observaciones e identidad comprobada; no importa
  Baileys, perfiles, permisos, STT, HTTP ni proveedores. El único SQL continúa en
  el worker. El archivo inyectado es un puerto async dentro del gateway.
- Como protección transitoria, el adapter consulta `requires_review` antes de un
  envío individual. Esto no sustituye coordinación/versionado/outbox de F5 ni
  traslada autoridad de acceso/control desde JSON.
- `archived_message` alimenta consumidores de cache solo tras commit. Emitirlo
  no constituye una API pública ni un ACK adicional al proveedor.

Las decisiones de negocio de respuesta/comandos permanecen en pipeline y los
efectos legacy en su handler. F5 deberá concentrar despacho/control en los casos
de uso comunes; no extender esta excepción a decisiones de acceso dentro de los
adapters. Telegram reutilizará el principio de admisión con su cursor durable F2C,
sin copiar reglas WA ni agregar polling.

## Consecuencias y validación

El acoplamiento transitorio del adapter a un puerto de archivo es explícito y
reemplazable. Evita emitir al handler antes de guardar, a costa de no ser todavía
la separación completa de observaciones/casos de uso de la arquitectura destino.
No incorpora control humano ni salida durable por sí solo.

Pruebas de commit previo, fallo después de commit, saturación, sockets antiguos,
reapertura y composición del entry real en
[CAPTURA-WHATSAPP-F2B2](../CAPTURA-WHATSAPP-F2B2.md). Los límites de transporte y
proceso de ADR-001/002 y el dueño único de ADR-003 se conservan.
