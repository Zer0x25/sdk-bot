# Especificación operativa v1 — cierre F0.3

Fecha: 2026-10-19. Estado: **decisiones de implementación acordadas**, aún sin
conectar al runtime. Complementa [ARCHITECTURE.md](ARCHITECTURE.md) y ADR-005.
Los ejemplos de [fixtures/v1-acceptance.json](fixtures/v1-acceptance.json) son
expectativas futuras, no resultados de pruebas del producto. El protocolo de
medición está en [VALIDACION-V1.md](VALIDACION-V1.md).
Este documento fija semántica de negocio; la arquitectura fija límites/componentes.
OpenAPI/JSON Schema de F1 fijarán el formato wire y deben respetar estas reglas.

## 1. Alcance y autoridad

V1 cubre una instalación, un administrador y sus pestañas, cuentas configuradas
de WhatsApp/Telegram y chats individuales. Es una bandeja de texto con marcadores
multimedia, captura durable, control humano y contexto IA derivado. Grupos,
asignación de equipos, campañas nuevas y adjuntos reproducibles quedan fuera.
La difusión existente conserva su política y no se confunde con respuesta IA.

El gateway sigue siendo único dueño de transporte y DB operativa. Panel usa
sesión/proxy; brain recibe contexto, no abre esa DB. Cada módulo tiene exactamente
una autoridad activa. En F2, mensajes/eventos serán SQLite y contactos/settings
seguirán JSON; el corte de acceso/control corresponde a F5. Declarar una entidad
en este documento no adelanta ese cambio de autoridad.

## 2. Identidad, claves y aliases

- accountId, contactId, conversationId y messageId son UUID internos estables.
  accountId referencia una cuenta remota concreta y canal; cambiar teléfono o
  token no permite adoptar otra cuenta sin comprobar identidad del proveedor.
  Reautenticar la misma cuenta conserva ID; otra cuenta crea otro accountId.
- La identidad se resuelve por `(accountId, kind, exactValue)`. Telegram chat ID es
  una cadena decimal canónica no nula con signo opcional y sin ceros iniciales.
  Se valida como texto, nunca pasando por Number. WhatsApp conserva el JID/LID
  normalizado por el adapter y su tipo; un teléfono se normaliza antes a E.164.
  Preservar un ID negativo no habilita grupos en v1: el tipo de chat verificado por
  el adapter determina el alcance y un grupo queda clasificado fuera de la bandeja.
- Teléfono, LID y JID solo se enlazan con evidencia del adapter de esa cuenta o
  revisión explícita del administrador. No fusionar por nombre, foto, sufijo,
  substring, dígitos compartidos o parecido entre canales.
- El mismo texto remoto en dos cuentas/canales representa identidades distintas.
  En v1 no hay unión automática de una persona entre WhatsApp y Telegram.
- Una identidad tiene un conversationId duradero. Resolver/reabrir no crea otro
  chat ni borra el hilo. Un alias nuevo verificado se añade a esa conversación.
  Si ya apunta a otra, registrar conflicto, bloquear envíos/IA de las identidades
  afectadas y exigir resolución; conservar mensajes y procedencia, sin mezclar hilos.
- Un mensaje remoto se deduplica por `(accountId, canonicalIdentityId,
  providerMessageId)`, no por texto/fecha. La identidad canónica agrupa aliases
  verificados: recibir el mismo mensaje por JID y LID no lo duplica. El rawChatId
  se conserva como procedencia. Sin providerMessageId no inventar deduplicación
  garantizada: marcar calidad desconocida y usar ID local.
- Una unión de aliases comprobada reindexa claves de deduplicación en transacción;
  un conflicto de IDs/contenido se reporta y bloquea despacho hasta revisión.
  Esta operación no dispara IA ni infla no leídos ni modifica el control.

La transición legacy puede recibir números/JIDs, pero antes de mutar debe resolver
una identidad exacta y única dentro de la cuenta/canal comprobados del comando.
Si falta ese contexto o hay más de un candidato, devolver `409 IDENTITY_AMBIGUOUS`.
No crear un contacto de otro canal mediante el fallback de dígitos.

## 3. Acceso, automatización, ciclo y versiones

| Eje | Valores y regla |
|---|---|
| accessPolicy | allowed, ignored, neutral. Neutral hereda globalMode solo para IA. |
| globalMode | allowed_all o ignored_all; instalación nueva ignored_all. |
| automationMode | ai, human u off; human exige devolución explícita. |
| lifecycle | open/resolved; resolver conserva modo/permisos y cancela IA pendiente. Una entrada live nueva reabre. |
| globalPaused | Bloquea IA, conserva captura y envío humano autorizado. |
| ownerId | Principal autenticado que tomó control, o null si la atención humana aún no fue reclamada. |

IA puede iniciar generación/despacho únicamente con identidad resuelta, perfil
válido, ai, open, no pausa global y acceso allowed o neutral con allowed_all.
Una entrada live que reabre un chat ai vuelve a evaluar esa regla. Historias
importadas, ecos, recibos y administración no generan respuestas.

Un envío humano exige human confirmado, ownerId igual al actor, identidad resuelta,
versión vigente y accessPolicy diferente de ignored. Un neutral en ignored_all
puede recibir respuesta humana sin pasar a allowed. Pausa global no lo bloquea.
Tomar control se permite incluso en ignored, pero el compositor sigue bloqueado
hasta quitar explícitamente esa regla; así el operador puede detener la IA sin
autorizar respuestas por accidente. Off necesita TakeControl para responder.

Versiones independientes:

- `controlVersion`: aumenta al tomar/liberar/apagar control, cambiar acceso/perfil
  individual o resolver manualmente. Valida expectedVersion de comandos y envío.
  Entrada/recibo, cursor de lectura y reapertura por entrada no la incrementan.
- `policyVersion`: configuración global que afecta elegibilidad/perfil/pausa.
  Cambiarla invalida jobs admitidos con la versión anterior.
- `contextVersion`: limpieza/invalidez del contexto IA; una respuesta tardía no
  puede escribir en una versión nueva. La ventana usa un watermark de mensajes.
- `aggregateVersion`: proyección del chat para eventos/UI. No es expectedVersion
  del compositor; recibir otro mensaje no debe provocar un conflicto de control.

Cada job IA lleva las tres primeras versiones y IDs/watermark de entrada. Antes de
cada globo se revalida bajo la misma coordinación por conversación que TakeControl
y el inicio del despacho. Leer versiones y enviar fuera de esa coordinación no
cumple el contrato. Registrar el intento antes de red, sin sostener transacción
SQLite durante la petición al proveedor.

## 4. Tomar y devolver control

TakeControl persiste human, propietario y nueva controlVersion; cancela debounce,
jobs, reintentos y versiones anteriores. Nunca espera a una generación para
bloquear nuevos despachos. Si ya había un envío en red, responde 202 con operación
taking_control; el compositor espera a su confirmación. Al vencer el timeout de
transporte, el envío incierto se informa como delivery_unknown, no como cancelado.

Otro propietario devuelve 409. Un administrador puede reclamar/liberar mediante
`overrideOwner=true` explícito, auditado y con permiso `control:override`; el envío
manual nunca acepta overrideOwner como sustituto de tomar control. El principal
lo deriva cada superficie verificada, no el texto de un formulario.

Human sin propietario procede de una solicitud del cliente, un envío propio
no correlacionado en vivo o una importación legacy. Requiere TakeControl antes
de enviar desde panel. Un fromMe histórico no toma control. El eco de una salida
registrada conserva autoría y tampoco lo toma de nuevo.

ReleaseControl conserva acceso y perfil, cambia versión y deja ai con
`resumePolicy=future_only`: descarta automatización antigua, no el archivo.
`process_pending` es una selección expresa sobre IDs de entradas live posteriores
al último watermark atendido, aún no contestadas y dentro de 24 h. Reevalúa acceso,
pausa, contexto y versiones; no incluye backfill, mensajes expirados o anteriores
al inicio de handoff ya atendidos. Si no hay entradas elegibles, no genera nada.
La UI comunica que ai puede quedar bloqueada por acceso o pausa global.

No inferir qué quedó atendido analizando texto humano: SendMessage puede declarar
`handledThroughInboundSeq` del hilo mostrado, validado contra conversación/actor.
Solo al confirmar sent se avanza ese watermark; entradas posteriores siguen
pendientes. IA confirma sus IDs de entrada al enviar. Una salida delivery_unknown
mantiene sus entradas fuera de reenvío automático hasta reconciliación/revisión.
La selección de process_pending muestra los IDs que procesará y excluye esos casos.

Los comandos /humano y /auto conservan aliases pero usan estos mismos casos de
uso. /humano no exige cambiar globalMode. /auto no convierte allowed en neutral.
Los comandos admin comprobados pueden solicitar override explícito por su acción;
ninguna entrada de cliente obtiene ese permiso. Cerrar sesión/pestaña o reiniciar
no libera control ni reactiva jobs viejos. Una pausa con TTL legacy pasa a control
explícito en el corte de F5, con aviso de cambio de comportamiento.

## 5. Migración de permisos y datos ambiguos

| estado legacy | accessPolicy de destino | automationMode de destino | Condición |
|---|---|---|---|
| permitido | allowed | ai | Sujeto a pausa global de mantenimiento. |
| ignorado | ignored | off | No habilitar envíos manuales por importar. |
| neutro, null o ausente en registro válido | neutral | ai | Hereda modo global conservado; sin autorizar nuevos contactos. |
| handoff, con cualquier fecha/TTL | neutral | human | ownerId null; no inferir el permiso previo perdido. |
| valor inválido o identidad ambigua | neutral | off | requiresReview=true y motivo; sin envío hasta revisión. |
| permitido/ignorado/neutro con perfil inexistente | Mantener su traducción de acceso | off | requiresReview=true; no fallback silencioso. |

Con handoff y perfil inexistente, conservar human y marcar requiresReview para
el perfil. Un operador puede reclamarlo; no se reactiva IA hasta resolver perfil
y liberar explícitamente. El informe distingue ese caso del permiso desconocido.

No descartar un handoff por estar vencido al importar. Duplicados solo se unen
con evidencia exacta; reglas contradictorias se retienen como conflicto, sin
elegir allowed por prioridad. Un ID legacy sin canal verificable queda en
cuarentena con sourceKey y motivo, no se deduce de su longitud.

El informe debe cuadrar `sourceRecords = imported + quarantined + excluded` y
explicar exclusiones de basura/grupos/administración. Cada sourceKey aparece una
vez, con checksum y targetId cuando exista. Contradicciones que cambien permisos
quedan bloqueadas; no se ocultan para conseguir que los recuentos coincidan.

## 6. Retención y lectura

Valores iniciales configurables, fijados también en el fixture de aceptación:

| Dato | Retención / comportamiento inicial |
|---|---|
| Cuerpo de mensajes/adjuntos | 90 días desde ingestedAt durable. Una importación antigua tiene 90 días desde su captura. |
| Eventos para SSE | 7 días; payload mínimo, sin copia del texto. |
| Idempotencia y huellas de deduplicación | 180 días desde captura/intención; sin contenido de mensaje ni token. |
| Contexto IA | Ventana 7 días / presupuesto 5000 tokens, independiente del archivo; incluye humano. |
| Salida queued sin iniciar | Máximo 24 h, después failed/expired; ningún envío sorpresa tras largas caídas. |
| Exportaciones temporales | 1 hora, descarga autenticada y vinculada al actor. |
| Backups | Una copia diaria, 7 días; no sustituyen un destino de recuperación externo. |

Purga diaria, por lotes acotados: eliminar cuerpos con ingestedAt estrictamente
menor que cutoff; el límite exacto se conserva hasta la siguiente ejecución.
Conservar cuentas, identidades, permisos y control humano mientras exista cuenta;
una purga no concede acceso ni cambia human/off. Cursores de lectura guardan
secuencia de entrada por actor, sin FK obligatoria al cuerpo purgable. No leídos
cuenta solo entradas live retenidas posteriores al cursor; un cursor viejo no
vuelve a retroceder ni marca leído en el proveedor.

Las huellas dentro de 180 días evitan recrear un mensaje purgado por redelivery.
Repetir una intención cuyo resultado ya fue purgado devuelve
`410 IDEMPOTENCY_RESULT_EXPIRED`, nunca la ejecuta otra vez. Tras 180 días esa
garantía vence; un cliente antiguo debe resincronizar y no reenviar automáticamente.
No se almacenan cuerpos indefinidamente por tener un envío delivery_unknown;
se conserva solo su huella/estado mínimo hasta el plazo aplicable.

Borrar contexto crea un nuevo contextVersion y límite de mensajes/contexto: la
proyección no vuelve a importar ese tramo del archivo. Purgar un cuerpo invalida
cualquier resumen/contexto derivado que todavía lo contenga. Una exportación o
backup puede conservarlo hasta su propio vencimiento; documentar esa ventana
(hasta 7 días adicionales en backups diarios). Restaurar aplica de nuevo purga y
revocaciones antes de permitir lecturas. Borrado explícito se audita y exige una
operación propia; limpiar memoria no es borrar historial.

SSE y cursores incluyen un `dataEpoch` UUID y secuencia decimal como texto. Un
restore/corte que cambie la línea temporal rota dataEpoch y fuerza resync. Los
cursores opacos de páginas se vinculan a epoch, conversación/filtros y orden; no
pueden usarse en otra cuenta o consulta. Retención de eventos vencida fuerza
instantánea nueva sin resetear control ni cursores de lectura locales.
La secuencia global puede tener saltos legítimos por filtrado/purga; el cliente
deduplica y verifica monotonicidad, sin exigir números consecutivos. Un salto de
aggregateVersion del chat requiere releer su proyección; epoch distinto/cursor
expirado requiere resync de la instantánea completa del ámbito autorizado.

## 7. Corte por módulo, backup y rollback

No ejecutar esta operación en F0.3. El implementador debe proporcionar un comando
dry-run e informe antes de habilitar escrituras de la nueva autoridad.

1. Verificar versión de runtime/DB, backup disponible, espacio, cuenta y un único
   transporte. Fijar migrationId; activar mantenimiento: rechazar mutaciones admin
   del módulo, pausar IA e impedir nuevas salidas. Drenar envíos ya iniciados con
   timeout e inventario de resultados inciertos. Captura de mensajes sigue activa.
2. Congelar escrituras legacy, incluyendo enriquecimiento asíncrono. Drenar los
   guardados diferidos antes de snapshot JSON con checksum. Cambios de metadatos
   recibidos después se encolan como delta durable en el gateway, no solo en RAM;
   mensajes continúan al archivo de F2. Telegram no confirma entradas no persistidas.
3. Tomar snapshot SQLite mediante worker/VACUUM INTO y manifest de versiones,
   checksums, recuentos, watermarks y autoridad de cada módulo. No copiar DB/WAL
   en caliente por separado; no mover volúmenes ni credenciales con el código.
4. Importar contactos/settings del módulo a staging por lotes con progreso
   recuperable. Comprobar recuentos/identidades/reglas/foreign keys y reporte de
   cuarentena. Repetir migrationId no duplica entidades. No ejecutar IA por backfill.
5. Bajo barrera final, aplicar delta hasta watermark y cambiar autoridad/versiones
   en una transacción. Las operaciones posteriores consultan la autoridad nueva;
   no hay dos writers JSON/SQLite. Rotar dataEpoch cuando invalide cursores y
   mantener control/permisos importados con IA globalmente pausada.
6. Probar lectura, control y reconciliación con un informe posterior. Reanudar
   explícitamente después de verificación. Eliminar la autoridad antigua solo
   después de vencer la ventana de rollback y conservar backup según política.

Antes del corte, abortar staging y devolver autoridad al JSON congelado, aplicando
su delta; el archivo ya capturado en SQLite no se restaura a un punto viejo.
Después del corte, el rollback soportado es a una versión de código compatible
con esa autoridad/DB, conservando mensajes, control, outbox y ledger. La versión
pre-archivo no es un rollback válido: no puede reconstruir propietario/versiones.

Un downgrade de formato exige un exportador del delta y una capa de compatibilidad
probados; mientras no existan, se bloquea. Un snapshot previo no sobrescribe la DB
actual después de nuevos envíos humanos. No convertir delivery_unknown en queued
ni repetir envíos al restaurar; pausar y reconciliar antes de continuar.

La restauración tras pérdida de disco es una operación distinta: RPO de backup
diario hasta 24 h, sin prometer recuperar lo que el proveedor no reenvíe. Debe
informar el intervalo faltante, no afirmar historial íntegro. Ejecutar restauración
en mantenimiento, verificar integridad, rotar epoch y aplicar retención antes de
abrir lecturas. No se considera rollback seguro descartar silenciosamente ese delta.

## 8. Límites y puertas de implementación

- Texto saliente v1: 1–4096 puntos de código Unicode, máximo 16 KiB UTF-8; texto
  vacío/solo espacios rechaza. Sin convertirlo en Markdown ni comandos admin.
- Ingesta: conservar mensaje base aunque no haya texto/STT. Contenido fuera del
  límite de 64 KiB de texto queda como marcador `oversized`, con tamaño/motivo y
  sin IA; no truncar y fingir cuerpo íntegro. Bytes de audio/adjuntos no viajan por SSE.
- Presión de ingesta: cola máximo 1000 elementos o 32 MiB, lo que ocurra primero.
  No hacer ack durable antes de commit. Saturación visible; TG deja de adelantar
  offset. WA no garantiza redelivery, por lo que se informa el intervalo afectado.
- Queries/control del panel tienen techo 5 s; envío al proveedor 15 s; tomar
  control responde confirmado o 202 antes de esperar al proveedor. Reintentos de
  lectura acotados; envío ambiguo requiere reconciliación/acción expresa.
- El esquema operativo usa FK, transacciones y synchronous=FULL en WAL antes de
  declarar ack durable; pruebas de caída no equivalen a prueba de pérdida de energía.
- Una fase solo se cierra con sus escenarios implementados y comprobados. Los
  ejemplos F0.3 revisan decisiones; no cierran bugs runtime por describir su solución.

Puertas inmediatas: F1A crea contratos y valida ejemplos; F1B verifica actor/frontera
y resuelve BUG-013 antes de exponer historial. F2 implementa identidad/ingesta y sus
bugs; F5 implementa control/outbox/contexto. Windows/Termux conservan sus puertas de
compatibilidad; los objetivos de rendimiento son propuestas verificables, no resultados.
