# ADR 005: Historial operativo, control humano y plataforma modular

- Fecha: 2026-10-19.
- Estado: **propuesta de implementación**, documentada por solicitud del usuario.
- Este cambio entrega documentación; no declara migraciones ejecutadas.
- Mantiene ADR-001, ADR-002 y ADR-003.
- Amplía el antiobjetivo de ADR-004 sobre colas de salida.

## Contexto

La bandeja necesita historial persistente, toma de control y respuesta humana.
El store RAM de WhatsApp, la memoria IA con retención y el estado handoff con
caducidad no garantizan ese recorrido. Existen envíos directos al adapter y al
socket desde `/notify`. Reescribir todo simultáneamente pondría en riesgo la
verificación de sesión única y la compatibilidad de instalaciones existentes.

## Decisión

1. Crear módulos de conversaciones, contactos, mensajería y automatización dentro
   del gateway. Conservar procesos independientes para panel, brain y STT; el
   gateway sigue siendo único dueño del transporte.
2. Usar SQLite del gateway como archivo operativo. El brain mantiene contexto
   derivado e invalidable. Generar no equivale a enviar; los mensajes humanos
   forman parte del contexto al devolver la atención a IA.
3. Separar acceso, automatización y lifecycle. Control humano explícito con actor
   y versión persistente, sin vencimiento automático para tomas desde panel.
4. Coordinar por conversación y validar control antes de cada envío. Cancelar
   trabajos obsoletos y reconocer el límite de mensajes ya iniciados en red.
5. Incorporar salida durable con idempotencia local, estados y reconciliación.
   Esto amplía el antiobjetivo de ADR-004; mantiene timeouts y clasificación de
   errores. Los envíos ambiguos no se reintentan automáticamente.
6. Versionar API HTTP y contratos OpenAPI/JSON Schema. SSE con replay durable y
   eventos publicados después del commit; no adoptar event sourcing del dominio.
7. Construir bandeja React/TypeScript con Vite, servida por el proceso del panel,
   conservando OAuth/proxy. Migrar JS a TypeScript de forma incremental.
8. Adoptar `apps/` + `packages/` mediante movimientos graduales y verificables.
   Python conserva su tooling. Verificar driver SQLite en plataformas soportadas
   antes de incorporarlo; preferencia inicial `node:sqlite`.
9. Migrar handoff/permisos conservadoramente. Resolver IDs exactos por canal/cuenta;
   no mezclar dígitos de WhatsApp y Telegram ni reactivar IA por una importación.

## Alternativas consideradas

| Alternativa | Motivo para descartarla como base |
|---|---|
| Mostrar `/history` del brain | No contiene archivo íntegro, autoría humana ni estados de envío. |
| Persistir únicamente el store RAM | No cubre Telegram, salida, control ni API durable. |
| Panel con otro Baileys | Viola transporte único y puede generar conflicto de sesión. |
| Microservicio y broker de conversaciones | Añade operación/consistencia distribuida sin necesidad demostrada. |
| Reescritura simultánea | Mezcla riesgos de rutas, datos, OAuth y transporte antes de validarlos. |
| Next.js/SSR | No hay necesidad de renderizado servidor para esta consola privada. |

## Consecuencias

- Cada mensaje tiene procedencia/estado; cada control, actor/versión.
- UI y canales evolucionan mediante contratos sin duplicar reglas de negocio.
- Aumentan obligaciones de migración, backup, retención, salida y replay.
- SQLite requiere propietario único y disco local. Esto no habilita múltiples
  gateways sobre la misma DB o credenciales.
- Sin promesa de historial previo completo ni exactly-once externo.
- Rutas actuales siguen disponibles hasta pasar puertas de compatibilidad.

## Evidencia de implementación requerida

Pruebas de repositorios y contratos; takeover durante generación, typing y entre
globos; caída tras aceptación del proveedor; HTTP idempotente; reinicio con human;
replay SSE; mensajes desde teléfono; aislamiento cuenta/canal. Recorrido E2E:
entrada -> control humano -> respuesta -> devolución a IA con transporte falso.
Validación manual posterior en cuenta de prueba, sin duplicar producción.

Modelo y contratos: [ARCHITECTURE.md](../ARCHITECTURE.md).
Orden de implementación: [ROADMAP.md](../ROADMAP.md).
