# Validación y presupuestos v1 — F0.3

Fecha: 2026-10-19. Define cómo demostrar la especificación. F1A ejecuta los seis
casos TXT y comprueba formas wire de ID. F2E.2 ejecutó el dataset y la carga completa
en un host distinto del perfil de referencia; resultados y límites están en
[F2E2-CARGA-COMPLETA](F2E2-CARGA-COMPLETA.md). No se midió takeover porque la API
de control pertenece a F5. F2A ejecuta los casos de repositorio descritos en
[ARCHIVO-CONVERSACIONES-F2A](ARCHIVO-CONVERSACIONES-F2A.md).
Norma: [SPEC-OPERATIVA-V1.md](SPEC-OPERATIVA-V1.md).
Valores/ejemplos: [fixtures/v1-acceptance.json](fixtures/v1-acceptance.json).

## 1. Escenarios de referencia

El fixture usa únicamente datos sintéticos, una fecha fija UTC y IDs UUID de
prueba. Sus grupos describen expectativas independientes de la implementación:

| Grupo | Alcance | Puerta que debe ejecutarlo contra código real |
|---|---|---|
| ID | Igualdad exacta, signo TG, precisión >2^53, cuentas/canales y alias verificado | F1A tipos/validadores; F2 resolución de identidad |
| DEDUP | Mismo mensaje por JID/LID y reutilización de ID en otra cuenta | F2 captura/aliases; cubre defecto de diseño BUG-016 |
| MIG | Estados/perfiles legacy, handoff vencido y cuarentena | F5 importador dry-run y corte de acceso/control |
| EL | Las 36 combinaciones de acceso, modo, globalMode y pausa | F5 servicio de elegibilidad/control/dispatch |
| RET | Límite de 90 días y fecha antigua del proveedor con captura reciente | F2 política/purga y F8 ensayo de backup/restore |
| CTL | Control separado de actualizaciones, toma pendiente, release, restore y ecos | F3 eventos; F5 control/outbox/contexto |
| ROLL | Aborto previo, restauración inválida y código compatible tras nuevos envíos | F5 migración; F8 ensayo de recuperación |
| TXT | Texto vacío, Unicode de 1/3/4 bytes y límite por puntos de código | F1A validadores, F5 envío/F6 compositor |

EL presupone identidad/perfil resueltos, lifecycle open, propietario coincidente,
control confirmado y versiones actuales. No usar una respuesta true de esa tabla
para omitir esas precondiciones. La variante human false cuando ignored no impide
tomar control: impide enviar hasta quitar la regla.

En F0.3 se revisan estructura, IDs únicos y consistencia lógica de los ejemplos.
F1 valida formas y tipos; cada fase ejecuta después los casos contra sus servicios
o adapters falsos. Comprobar un JSON no demuestra que el gateway cumpla la regla.
No implementar un segundo motor de políticas solo para hacer pasar el fixture.

## 2. Dataset reproducible de carga

Fuente de parámetros: loadProfile del fixture. El generador de F2 deberá:

1. Usar seed 20261019 y xorshift32: estado uint32; xor con desplazamiento izquierdo
   13, xor con desplazamiento derecho sin signo 17 y xor izquierdo 5, en ese orden,
   conservando 32 bits. U = estado / 2^32. No Math.random ni fecha del sistema.
2. Crear 5 cuentas sintéticas (índices 0–1 WA y 2–4 TG), 2.000 contactos/chats
   (c = 0..1999); cuenta = c % 5. IDs UUIDv5 con namespace del fixture y nombres
   UTF-8 exactos `account:i`, `contact:c`, `conversation:c` y `message:c:j`.
   Raw chat WA = (10000000000+c)@s.whatsapp.net; TG = texto de (1000000000+c).
   Son valores sintéticos para adapters falsos; nunca se envían a esos canales.
3. Crear 500 mensajes por conversación (1.000.000 únicos), providerMessageId local
   al chat, texto sintético de 100–600 puntos de código y autoría customer/ai/operator
   según índice. Iterar c externo y j = 0..499 interno; g = c*500+j. Autoría según
   g % 3: customer, ai, operator. Cada mensaje consume un U para longitud
   100+floor(U*501); carácter k = alfabeto ASCII a..z[(g+k)%26]. Ambos timestamps
   = anchorMs - (c%90)*86400000 - floor(j/3)*1000. Tres mensajes por grupo comparten
   fecha. El dataset inicial es backfill, sin respuestas ni no leídos nuevos.
4. Añadir redelivery de los primeros 50.000 IDs sin nuevas entidades/eventos ni
   nuevos no leídos. Incluir JID/LID verificados para un subconjunto fijo y
   message_id repetidos en chats distintos (`providerMessageId=String(j+1)`).
   Para chats WA con c <100, el redelivery usa LID (70000000000+c)@lid verificado
   como alias. No convertir backfill en tráfico live.
5. Mantener 50.000 eventos recientes para replay, seleccionados de mensajes cuya
   captura cae dentro de los últimos 7 días, los de mayor secuencia de inserción;
   usar secuencias del log real de fixture.
   Epoch fijo para benchmark; restauración usa otro epoch en su caso de aceptación.
6. Generar casos de purga/identidad inválida por separado del dataset de consultas.
   Exportar JSONL UTF-8, claves ordenadas, sin espacios y LF final por registro;
   para archivo usar los DTOs v1 de packages/contracts/schema.json: Account, Contact,
   Conversation, Message y Event, un archivo por tipo, sin wrappers arbitrarios.
   El generador/adapters falsos de F2 definen aparte las inyecciones de redelivery
   por alias; no confundirlas con mensajes distintos del archivo. Emitir manifest
   con versión de contratos v1 y hash del schema, parámetros,
   recuentos y SHA-256 de cada archivo. Igual seed/config/esquema debe dar igual hash.

Los archivos generados viven en temporales, sin tokens/sesiones y con limpieza.
El JSON versionado describe el dataset, no contiene un millón de mensajes en git.
El generador y los resultados F2E.2 están implementados en
[apps/gateway/scripts/conversation-load.js](../apps/gateway/scripts/conversation-load.js) y
[F2E2-CARGA-COMPLETA](F2E2-CARGA-COMPLETA.md); el runner exige un volumen temporal
con al menos 6 GiB libres para evitar agotar el espacio durante el snapshot.

## 3. Presupuestos iniciales y medición

Referencia: Linux x64, 2 vCPU, 4 GiB RAM, disco SSD local, Node >=22.13.0. Registrar
CPU/límites de contenedor, RAM, disco, Node/SQLite, commit y configuración. Si el
ejecutor difiere, informar resultados sin etiquetarlos como aprobación del perfil.
Windows/Termux requieren sus propias ejecuciones; no extrapolar desde Linux.

| Operación local | Objetivo p95 | Objetivo p99 |
|---|---|---|
| Ingesta aceptada -> commit mensaje/evento | 100 ms | 500 ms |
| Lista de 50 conversaciones | 150 ms | 500 ms |
| Página de 50 mensajes | 100 ms | 300 ms |
| Takeover admitido -> controlVersion durable | 100 ms | 250 ms |
| Retraso de event loop principal | Se informa | 20 ms |

Objetivos adicionales: importación >=1000 mensajes únicos/s, RSS total de gateway
(incluye worker) <=512 MiB, cola <=1000 elementos y <=32 MiB. Ninguna pérdida o
duplicación se acepta para ganar rendimiento. Son objetivos por verificar, no
mediciones obtenidas en F0.3 ni garantías para canales externos.

Procedimiento:

- Preparar dataset/DB una vez, comprobar integridad y guardar snapshot; restaurar
  estado de medición equivalente entre runs sin reconectar transportes reales.
- Dos runs de calentamiento y tres medidos. Por run, al menos 2.000 muestras por
  operación de consulta/control y carga de ingesta de 10/s durante 120 s más
  ráfaga de 50/s durante 30 s. IDs/rutas se seleccionan con el mismo PRNG.
- Ejecutar queries/control junto a ingesta; registrar concurrencia, profundidad
  de cola, rechazos, errores y cada latencia. Los envíos usan adapter falso con
  tiempos controlados; proveedores IA/STT no intervienen en esas latencias.
  La medición de almacenamiento no programa generación IA ni mensajes de salida;
  sus carreras/entrega se comprueban con casos funcionales separados. La carga nueva
  es live y usa IDs distintos de los del dataset de backfill.
- Medir reloj monotónico; p95/p99 por nearest-rank de muestras ordenadas. Los
  tres runs deben cumplir, sin promediar percentiles ni excluir errores/timeouts.
  Informar resultados de caché fría por separado, sin mezclar con calentamiento.
- Commit de takeover y drenaje externo son métricas distintas. Una toma pendiente
  por envío de proveedor puede tardar hasta su timeout de 15 s; nunca etiquetarla
  como confirmada por cumplir el tiempo de commit.
- Reportar JSON por run con manifest/hash, commit, runtime, recursos, recuentos,
  p50/p95/p99, errores, queuePeak y rssPeak. Un timeout cuenta como fallo, no se borra
  de la distribución. Conservar resultados antes de borrar temporales del dataset.
- Añadir ensayo de saturación por encima del límite: rechazo/backpressure visible,
  cursor TG sin confirmar y ausencia de envío IA sin persistencia. No requiere
  cumplir latencia normal mientras está saturado, sí conservar el límite de memoria.

Una muestra única de 5.000 escrituras del spike F0.2 no cumple este protocolo.
No ralentizar la CI de cada cambio con el dataset completo: CI ejecuta casos
funcionales reducidos; la entrega de almacenamiento/UI conserva un informe de
carga completo antes de cerrar sus puertas. El runner actual está en
`apps/gateway/scripts/conversation-load.js`; repetir con 2 CPU/4 GiB antes de certificar
ese perfil. Para contenedores Linux con cgroup v2, el runner calcula CPU/memoria
efectivas usando cuota, cpuset y límites de todos los ancestros, además de conservar
los valores del host en el informe. Si no puede leer límites cgroup, informa los
recursos del host y no declara que un perfil limitado coincida. Takeover se incorpora
cuando F5 entregue la operación durable.

## 4. Ensayos de corte y recuperación

Antes de cerrar F5/F8 se necesita un fixture con legacy válido/ambiguo, handoff
vencido, perfil ausente y salida incierta. Interrumpir el importador antes de
staging, a mitad, antes/después de authority flip y tras un nuevo envío humano.
Repetir migrationId no duplica; los recuentos del informe cuadran y ningún paso
dispara IA, mueve credenciales o abre otro transporte.

Probar aborto pre-corte con delta de metadatos; rollback de código compatible
con DB actual; rechazo de downgrade incompatible/snapshot antiguo tras nuevas
escrituras. Ensayar backup con WAL activo, restore en mantenimiento, rotación
de epoch, purga/revocaciones y no reenvío de delivery_unknown. Verificar permisos,
propietario, watermarks, idempotencia y messages/events tras cada interrupción.

La validación real posterior WA/TG usa cuenta de prueba y una instancia. Debe
separar pérdida de redelivery no garantizado del proveedor de pérdida local por
adelantar ack. No se usaron cuentas ni se ejecutó migración en esta unidad.

## 5. Evidencia de cierre de F0.3

- JSON leído con la biblioteca estándar de Python: 75 escenarios, IDs únicos,
  UUIDs válidos, IDs TG de texto con signo/precisión conservados y matriz completa
  de 36 combinaciones de acceso/modo/global/pausa.
- Revisión de expectativas: captura no depende de respuesta, ningún caso permite
  IA y humano a la vez, handoff importado no pasa a ai, cuarentena bloquea,
  límites de purga respetan ingestedAt y seis casos Unicode respetan puntos de
  código/UTF-8. Dataset y plazos cuadran con los parámetros declarados.
- DEDUP-01 reproduce la inconsistencia de diseño con dos tuplas raw distintas
  y la misma tupla canónica; documentación corregida. BUG-016 cerrado en diseño.
- SHA-256 del fixture: `0473916adaf212eb1bd3be9e42edb64ec3aff2773b91ea75083f649015a6a130`.
- Enlaces locales, fences Markdown, JSON y diff revisados. No se ejecutaron suites
  funcionales nuevas ni benchmark de la plataforma: esta unidad cambia solamente
  especificación/fixtures. Resultados de código previos siguen en baseline/spike.
