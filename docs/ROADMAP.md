# Hoja de ruta: plataforma de conversaciones SDK-Bot

Actualización: 2026-10-19. Arquitectura: [ARCHITECTURE.md](ARCHITECTURE.md).
Decisión: [ADR-005](adr/005-plataforma-conversaciones.md).
Estado por sesión: [SESSION-STATE.md](SESSION-STATE.md).
Prompt reutilizable: [PROMPT-CONTINUIDAD.md](PROMPT-CONTINUIDAD.md).

## Objetivo verificable

Un cliente escribe, el mensaje queda guardado y aparece en la bandeja. El operador
abre el chat, toma control, responde desde allí y devuelve la atención a IA. La IA
conoce lo hablado con el humano. Reiniciar servicios o reconectar navegador no
pierde historial ni reactiva respuestas canceladas.

**Nada de las fases siguientes se declara implementado por escribir este plan.**
La sesión inicial creó la base documental. Después se completaron F0.1 y los
checks actuales en copia temporal: gateway Node 22/24, brain y smoke del launcher
con WA simulado/TG sin token. Evidencia: [BASELINE-CONVERSACIONES.md](BASELINE-CONVERSACIONES.md).
F0.2 también completada: [experimento SQLite](SQLITE-SPIKE.md) probado en Linux
con Node 22.13/22.23/24, driver elegido y plataformas pendientes registradas.
Siguiente unidad: F0.3. No se conectaron canales reales ni se migraron datos.

## Alcance y entregas

| Entrega | Fases | Resultado demostrable |
|---|---|---|
| Base técnica | 0–2 | Contratos y captura durable con pruebas; panel actual operativo. |
| Bandeja de lectura | 3–4 | Chats e historial paginado reales, búsqueda de contactos, eventos y reconexión. |
| Atención completa v1 | 5–6 | Control humano seguro, envío manual, retorno a IA con contexto y E2E. |
| Consolidación | 7–8 | Nuevo panel cubre funciones previas; estructura de destino y despliegues coherentes. |
| Capacidades posteriores | 9–10 | Multimedia y herramientas IA con alcance y pruebas propios. |

La entrega de mayor valor es atención completa v1. No bloquearla por campañas,
roles de equipo, un rediseño de proveedores o mover todas las carpetas.

## Reglas de trabajo

- Al cerrar cada fase o unidad entregable probada, revisar diff/docs y hacer un
  commit local. Registrar bugs en [BACKLOG.md](BACKLOG.md); reparar los que bloqueen
  la especificación de la unidad y diferir los demás con prioridad/fase límite.
- Una unidad vertical y revisable por sesión; una fase puede necesitar varias.
- Leer AGENTS, arquitectura, ADR y estado antes de editar. Verificar primero código
  real y cambios locales; no completar checkboxes por suposiciones.
- Criterio de cierre: comportamiento, pruebas y actualización de estado/docs.
  UI con mocks no demuestra transporte; tests no sustituyen validación real.
- Fixtures y DB temporales, adapters falsos y proveedores simulados por defecto.
  No duplicar sesiones, resetear ni re-vincular producción para probar.
- Reutilizar pruebas existentes; añadir las de carreras, contratos y recuperación
  necesarias. No probar únicamente que una función llama otra función.
- Registrar limitaciones por plataforma. No decir que Windows/Termux funcionan
  si únicamente se comprobó Linux. No publicar ni desplegar por cerrar una fase.
- No ejecutar fases posteriores porque quede tiempo sin cerrar la unidad actual.
  Un bloqueo externo se registra y se avanza solo en trabajo independiente.

## Fase 0 — Línea base y compatibilidad

**Depende de:** ninguna. **Próxima sesión recomendada: F0.3.**

- [x] F0.1 Inventariar entradas/salidas, generaciones de sockets, comandos, rutas,
  cursores y puntos de persistencia; producir `docs/BASELINE-CONVERSACIONES.md`
  con archivo/línea, hallazgo y prueba existente o faltante.
- [x] Ejecutar checks actuales de gateway/brain y smoke cuando el entorno lo permita;
  registrar versiones, comandos y resultados. Un fallo previo no se atribuye al cambio.
  Completado con smoke aislado sin transporte real; pairing/sync/entrega no validados.
- [x] F0.2 Probar en fixture temporal `node:sqlite`: versión mínima real, worker,
  WAL, transacciones, constraints, backup y cierre. Comprobar disponibilidad de
  runtime en Linux/Windows/Termux o registrar pendiente por plataforma. Decidir
  driver con evidencia y actualizar ADR-005 antes de añadir dependencia.
  Node >=22.13.0 sin flags en Linux; Windows/Termux pendientes. Sin dependencia
  externa ni DB runtime añadida. Script incluido en el job de CI para futuras ejecuciones.
- [ ] F0.3 Fijar alcance v1, orden de IDs/aliases, retención inicial (propuesta 90d
  historial), compatibilidad de handoff y estrategia de backup/corte/rollback.
  Definir presupuesto de carga y mediciones con fixtures reproducibles.

**Aceptación:** baseline con resultados reproducibles, riesgos concretos y siguiente
cambio acotado. Sin mover carpetas ni tocar credenciales/sesiones.

## Fase 1 — Contratos y frontera autenticada

**Depende de:** Fase 0.

- [ ] Crear `packages/contracts` y workspace Node mínimo sin mover apps actuales;
  registrar impacto en locks, CI y release-please. Mantener Python independiente.
- [ ] OpenAPI/JSON Schema para cuenta, identidad, conversación, mensaje, control,
  operaciones, errores y eventos. IDs texto; límites y cursores documentados.
- [ ] Validación runtime y generación/verificación de tipos. Tests impiden deriva
  entre schema, DTO servidor y cliente; contratos Python solo donde corresponda.
- [ ] Endpoint de sesión y contexto actor firmado panel -> gateway; validar firma,
  expiración, método/ruta/hash, permisos y principal local dev. No confiar actor
  del navegador. Conservar OAuth, origen y compatibilidad de rutas previas.

**Aceptación:** contratos válidos y pruebas de 401/403, actor falsificado, contexto
alterado/vencido y desarrollo explícito, sin conectarse a canales reales.

## Fase 2 — Historial durable y captura completa

**Depende de:** Fase 1.

- [ ] Repositorios y migraciones SQLite para cuentas, identidades, mensajes,
  conversaciones y eventos. Worker único; constraints e índices para consultas.
- [ ] Antes de escribir estado, agregar `SDK_CONVERSATIONS_DB_PATH`, DB/WAL/SHM,
  cursores, .gitignore, inventario factoryReset y volumen. Probar backup/restauración
  y cierre sin pérdida con temporales. No cambiar rutas de credenciales existentes.
- [ ] Captura de todos los elementos WA upsert, no solo el primero; importación de
  history_sync por lotes. Timestamps originales y deduplicación estable.
  Cubrir callbacks de sockets reemplazados y conexión del flujo live al archivo.
- [ ] Captura Telegram antes de adelantar/confirmar cursor durable. Reprocesar un
  update tras crash sin duplicarlo. No agregar otro poller para descubrir historial.
  Reconducir el getUpdates indirecto de testAndGetChatId al dueño único o coordinar
  descubrimiento sin competencia de transporte; añadir prueba de esa exclusión.
- [ ] Persistir entrada aunque IA esté pausada, ignorando o en human. Reconciliar
  salida IA, humana desde teléfono y avisos por origen; separar chats administrativos.
- [ ] Multimedia como mensaje base y STT como actualización del mismo ID, incluso
  con STT apagado/fallido. Backfill sin respuestas ni no leídos falsos.
- [ ] Mientras se migra, contactos/settings JSON siguen siendo autoridad detrás de
  repositorios; SQLite es autoridad del nuevo archivo de mensajes/eventos. No
  introducir un segundo estado de control activo en competencia con JSON.

**Aceptación:** reinicio conserva mensajes; lote, reimportación y ecos no duplican;
canales/cuentas/IDs con signo no colisionan; audio fallido sigue visible. Carga con
miles de mensajes sin bloquear pings del transporte falso; progreso observable.

## Fase 3 — API de lectura y eventos en vivo

**Depende de:** Fase 2.

- [ ] Listar conversaciones y mensajes con paginación por cursor, orden estable,
  filtros y límites. Búsqueda de contacto; no prometer búsqueda de texto aún.
- [ ] Detalle con cobertura de historial, autoría y capacidades del canal.
- [ ] Cursor de lectura por actor separado de recibos remotos; no leídos fiables.
- [ ] SSE con eventos transaccionales, watermark, replay, deduplicación y
  resync.required. Cerrar carrera replay/vivo y soportar cursor fuera de retención.
- [ ] Autorizar lectura/SSE por sesión; probar proxy, desconexión, cierre de recursos
  y falta temporal de gateway. No exponer raw/secretos/rutas locales.

**Aceptación:** mismo resultado al leer y reanudar stream; no perder eventos entre
snapshot y suscripción; páginas sin duplicados con timestamps iguales. Revisar
actualización de lista cuando llegan mensajes durante paginación.

## Fase 4 — Bandeja de lectura y sistema visual

**Depende de:** Fase 3.

- [ ] Crear app React/TS/Vite y layout con tokens, navegación lateral, controles
  accesibles, router y cliente TanStack Query; feature flag/ruta de transición.
- [ ] Vista escritorio de tres columnas y móvil de una; chat activo en URL.
- [ ] Lista, filtros, historial paginado, marcadores multimedia y ficha contextual
  usando API real. Mocks exclusivamente para desarrollo/pruebas.
- [ ] Integrar SSE con caché, ancla de scroll, contador de novedades, carga, vacío,
  error, reconexión y cobertura parcial. Sin reconstruir todo el hilo por evento.
- [ ] Configurar build servido por panel y tests de componentes/E2E de lectura.
  Mantener panel antiguo accesible hasta completar sustitución.

**Aceptación:** leer hilos largos y reconectar sin saltos ni mensajes duplicados;
recorrido con teclado y viewport móvil. Compositor todavía no ofrece enviar.

## Fase 5 — Control exclusivo, salida y contexto IA

**Depende de:** Fases 2–4.

- [ ] Introducir coordinación por conversación, controlVersion y jobs cancelables
  en debounce, pool global, petición, typing, pausas, reintentos y cola persistente.
  Migrar o invalidar explícitamente trabajos JSONL previos y operaciones pendientes;
  no reproducir trabajos con permisos/versiones obsoletos tras reinicio.
- [ ] Migrar autoridad de acceso/control a SQLite mediante importación verificable
  de contactos/handoff. JSON queda como fuente previa de rollback/exportación,
  sin doble autoridad. Mapeo conservador: handoff -> human sin autorizar IA;
  accessPolicy previa desconocida -> neutral. Confirmar la nueva semántica de TTL.
- [ ] Comandos legacy y endpoints de estado llaman al mismo servicio de control;
  reemplazar búsqueda ambigua de dígitos con identidad exacta por canal/cuenta.
  Conservar aliases y explicar el cambio a control explícito sin caducidad.
- [ ] Implementar takeover/release/operaciones con versión, propietario y auditoría;
  estado tomando control mientras se drenan envíos ya iniciados con timeout.
- [ ] Outbox y SendMessage comunes a humano/IA/avisos; reconducir `/notify` y
  envíos directos. Campañas usan el puerto común conservando su política/intent.
- [ ] Idempotencia de mensajes, intento antes de red, estados reales y
  delivery_unknown. Recuperación tras crash sin reenvío automático de ambiguos.
- [ ] Brain GenerateReply con generationId y contexto explícito/versionado o
  protocolo equivalente de confirmación. Incluir mensajes humanos; invalidar
  memoria de respuestas canceladas; confirmar solo globos realmente enviados.
- [ ] Release future_only por defecto; no resucitar buffers viejos. Pausa global
  corta IA pero conserva archivo y respuesta manual autorizada.

**Aceptación obligatoria con transportes/proveedores falsos:**

| Escenario | Resultado requerido |
|---|---|
| Takeover durante debounce, pool, generación, typing o entre globos | Ningún envío IA nuevo atraviesa la barrera tras el cambio de control. |
| Takeover con envío de red ya iniciado | Estado pendiente; informar lo enviado/incierto y habilitar humano tras confirmación. |
| Reinicio en human | Continúa human, sin TTL accidental ni jobs viejos reactivados. |
| Doble click, timeout HTTP del panel, dos pestañas | Misma intención se ejecuta una vez localmente; versiones viejas reciben 409. |
| Caída tras aceptación del proveedor | delivery_unknown/reconciliación; ningún retry ciego que duplique. |
| Operador escribe desde teléfono | Eco registrado se reconcilia; salida propia desconocida suspende IA y aparece con procedencia. |
| Human -> IA tras varios mensajes humanos | IA recibe ese contexto; ninguna respuesta cancelada figura como enviada. |
| /limpiar memoria | Invalida contexto sin borrar historial ni reimportar el tramo limpiado. |

## Fase 6 — Responder desde el chat y cerrar v1

**Depende de:** Fase 5.

- [ ] Cabecera Tomar control/Devolver a IA; compositor condicionado a estado confirmado,
  permisos y propietario; estados taking_control, conflicto y envío incierto claros.
- [ ] Envío optimista por clientMessageId, reconciliación por evento/HTTP y borrador
  conservado si falla. Reintento ambiguo exige acción expresa informada.
- [ ] Resolver/reabrir y lectura; devolver a IA conserva permisos y permite elegir
  procesar pendientes, sin activarlo de forma silenciosa.
- [ ] E2E completo: entrada -> hilo -> takeover -> mensaje humano -> recepción de
  cliente durante human -> release -> siguiente respuesta IA con contexto correcto.
- [ ] Smoke manual documentado en cuenta de prueba WA/TG cuando esté disponible;
  una única instancia y resultados separados de simulación. No ejecutar reset para
  fabricar datos. Registrar si la validación externa queda pendiente.

**Aceptación:** flujo operativo completo, reinicios/reconexión, móvil y teclado.
Esta es la v1 útil; publicar/desplegar es una acción separada, no automática.

## Fase 7 — Sustituir el resto del panel

**Depende de:** v1 estable.

- [ ] Resumen orientado a decisiones con métricas reales y periodos explícitos.
- [ ] Contactos con permisos/perfiles y ficha compartida con bandeja.
- [ ] Canales con pairing existente, ventana QR de 140s, código manual y estados
  restaurables. No alterar exclusión QR/código ni crear otro gateway.
- [ ] Asistente: perfiles, editor, cambios sin guardar e importación/exportación.
- [ ] Sistema: logs, terminal, diagnóstico y mantenimiento; preservar confirmación
  de factory reset. Campañas tienen su espacio cuando haya flujo completo.
- [ ] Inventario de paridad: cada función antigua sustituida, descontinuada de forma
  expresa o aún disponible. Retirar panel viejo después de esa comprobación.

**Aceptación:** paridad funcional documentada, sin perder OAuth, pairing, comandos,
perfiles o reset por un cambio visual.

## Fase 8 — Estructura final y operación

**Depende de:** límites estables y v1; movimientos pequeños pueden adelantarse si
son necesarios para una fase previa y pasan sus mismas comprobaciones.

- [ ] Mover gateway, panel, brain y STT a apps/ uno a uno; imports/entrypoints y
  perfiles siguen funcionando. Compartir solo contratos/testkit, no estados runtime.
- [ ] Migrar settings/campañas restantes por repositorios con corte verificable;
  retirar accesos JSON directos. Revisar locks y release-please al mover paquetes.
- [ ] Actualizar Dockerfiles multi-stage, Compose, CI, launchers de Linux/Windows/
  Termux y artefactos frontend. Mantener volúmenes/rutas de credenciales existentes.
- [ ] Runbook backup/restauración, retención/exportación/purga, rollback de código y
  datos, métricas y logs con datos de cliente minimizados.
- [ ] Ensayar migración/restauración con fixture representativo y delta posterior
  al corte; no perder envíos nuevos restaurando snapshots antiguos.

**Aceptación:** instalación limpia y upgrade simulados; build/checks/smoke en Linux;
Windows/Termux con evidencia real o pendientes explícitos. Ningún doble transporte.

## Fase 9 — Multimedia y búsqueda de mensajes

**Depende de:** v1 y política de almacenamiento definida.

- [ ] Persistir metadatos/archivos con acceso autenticado, límites y retención.
- [ ] Audio, imágenes, documentos, citas, ediciones y borrados según capacidades;
  no simular recibos de entrega/lectura que Telegram no entrega al bot.
- [ ] SQLite FTS para búsqueda del contenido con índices y páginas verificables.
- [ ] Registrar adjuntos/índices en backup/factory reset y probar acceso/purga.

**Aceptación:** adjuntos accesibles solo al operador autorizado; mensaje permanece
comprensible si el archivo expiró o no está disponible.

## Fase 10 — Asistencia al operador y herramientas IA

**Depende de:** contexto/autoría robustos y política explícita de capacidades.

- [ ] Resúmenes, borradores y propuestas de respuesta con referencias al hilo.
- [ ] Contratos de herramientas: schemas, permisos, timeout, auditoría, idempotencia
  y separación read/write. Gateway ejecuta; brain solicita sin acceder a canales.
- [ ] ADR para efectos externos/equipos si se solicitan; no activar automáticamente
  CRM, calendarios, mensajes externos ni cambiar SDK/proveedores por disponibilidad.
- [ ] Evaluaciones con conversaciones sintéticas: no enviar en human, no confundir
  notas con mensajes entregados, no usar datos de otra cuenta y reconocer límites.

**Aceptación:** asistencia comprobable que respeta control humano y permisos.

## Cierre obligatorio de cada sesión

Actualizar SESSION-STATE con unidad trabajada, resultado comprobado, archivos,
comandos/resultados, pendientes, decisiones nuevas y próxima tarea exacta. Marcar
solo checkboxes demostrados; ajustar este orden si una dependencia real lo exige.
El prompt es estable; el estado cambia. No abrir otra hoja de ruta en paralelo.

## Pendientes heredados conservados

La antigua Fase 9 trataba consolidación multicanal y seguridad. No se borra su
intención ni se toman sus checkboxes como evidencia:

- Índices Map ya existen: Fase 0 debe verificar rendimiento/cobertura antes de
  concluir si quedan optimizaciones pendientes.
- Sync de agenda y reconexión con diálogo activo requieren pruebas de carga y
  validación real; se enlazan con Fases 2, 5 y 6.
- El reset total y una nueva vinculación requieren cuenta de prueba y alcance
  explícito; no forman parte de las verificaciones de esta sesión documental.
- La seguridad del panel existente se conserva y se amplía en Fases 1 y 3.
