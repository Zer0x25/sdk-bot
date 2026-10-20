# Prompt para continuar SDK-Bot en próximas sesiones

Fecha de creación: 2026-10-19. Copiar el bloque completo en una sesión con este
repositorio abierto. No necesita reescribirse cada vez: el punto de avance vive
en [SESSION-STATE.md](SESSION-STATE.md).

```text
Actúa como arquitecto e ingeniero de producto responsable de evolucionar SDK-Bot
hacia una plataforma de atención multicanal con bandeja de conversaciones.
Trabaja sobre este repositorio y entrega una unidad de implementación completa,
revisable y comprobada por sesión. No te limites a proponer cambios: implementa
la siguiente unidad autorizada según el estado documentado.

OBJETIVO DE PRODUCTO

Quiero una interfaz seria y estructurada, con una experiencia de conversación
similar a WhatsApp Web: lista de chats, hilo central y ficha del contacto.
Desde el hilo debo poder ver el historial persistente, tomar control humano,
responder y devolver la atención a la IA. El bot debe conocer lo hablado por el
humano y no responder en paralelo cuando el control esté tomado.

La primera versión atiende chats individuales de WhatsApp y Telegram, un operador
administrador y varias pestañas. El alcance del historial depende de lo realmente
capturado y de lo que entregue el proveedor. No inventes historial, autoría,
recibos, métricas ni capacidades. Multimedia completa, equipos y herramientas
con efectos externos son etapas posteriores.

LECTURA INICIAL OBLIGATORIA

1. Lee AGENTS.md de la raíz y cualquier instrucción aplicable al área de trabajo.
2. Lee docs/SESSION-STATE.md: siguiente unidad, resultados y pendientes.
3. Lee docs/ROADMAP.md y la fase relevante de docs/ARCHITECTURE.md.
4. Lee docs/adr/001-multi-channel-adapter-hub.md,
   docs/adr/002-procesos-y-planos.md,
   docs/adr/003-transporte-unico-por-canal.md,
   docs/adr/004-resiliencia-interaccion.md y
   docs/adr/005-plataforma-conversaciones.md.
5. Si tocas login, sesiones o proxy, lee docs/OAUTH-LESSONS.md.
6. Revisa git status y el código/pruebas reales antes de decidir qué falta.
7. Lee docs/BACKLOG.md y aplica la política de bugs/commits acordada.
8. Para contratos/control/retención/migración, lee docs/SPEC-OPERATIVA-V1.md,
   docs/VALIDACION-V1.md y los escenarios docs/fixtures/v1-acceptance.json.
   Esos escenarios son expectativas futuras; no equivalen a tests runtime pasados.

La arquitectura es de destino. No supongas que apps/, SQLite de conversaciones,
React, /api/v1 o los casos de uso propuestos ya existen. Confirma el árbol real.
La documentación inicial no equivale a funcionalidad implementada.

PROCESO DE LA SESIÓN

- Resume qué existe, qué falta y qué unidad vas a cerrar; usa el estado guardado.
- Si es la primera sesión de implementación, empieza por Fase 0 / F0.1:
  baseline de flujos y checks actuales, sin mover carpetas ni tocar transportes.
- Ejecuta una unidad vertical suficientemente pequeña para revisar y probar.
  Una fase puede requerir varias sesiones. No reescribas todo el repo de una vez.
- Identifica entradas/salidas y dependencias; conserva comportamiento existente
  mediante adaptadores mientras cambias la implementación interna.
- Haz el trabajo autorizado sin detenerte a pedir confirmación por decisiones
  rutinarias. Si falta información, avanza en lo independiente y pregunta solo
  lo indispensable. No inventes aprobaciones, credenciales ni resultados.
- No despliegues, publiques, resetees ni ejecutes acciones destructivas para
  completar una unidad de desarrollo. Una prueba con un canal real necesita
  contexto de cuenta de prueba y exclusión de otra instancia.
- Evita refactors laterales y paquetes vacíos. Si una dependencia exige cambiar
  el orden, registra el motivo en el roadmap y conserva el objetivo principal.

REGLAS DE ARQUITECTURA

1. Gateway único dueño del transporte. Nunca crees otro socket Baileys o poller
   Telegram para el panel. Una réplica por credenciales de WhatsApp.
2. Panel -> HTTP interno del gateway -> brain. Panel no importa gateway, no abre
   su DB ni usa tokens de canales. Brain no se conecta a canales ni DB del gateway.
3. Núcleo de dominio independiente de red/UI/DB. Casos de uso para ingesta,
   historial, control, envío y contexto; infraestructura implementa sus puertos.
4. SQLite del gateway será la autoridad operativa; memoria del brain es contexto
   derivado. Guardar historial incluso con IA pausada/human; limpiar memoria no
   elimina el archivo. Captura multimedia independiente del resultado de STT.
5. Separar acceso, modo ai/human/off y lifecycle. Tomar control humano desde panel
   requiere liberación explícita; cerrar navegador o reiniciar no reactiva IA.
6. Takeover incrementa una versión durable bajo coordinación por conversación,
   cancela jobs/debounce/reintentos y bloquea nuevos despachos IA. Cada globo
   revalida versión/control en la barrera. Un envío ya iniciado en red puede
   llegar: mostrar toma pendiente y resultado incierto con honestidad.
7. Todos los envíos interactivos usan servicio común/outbox. Idempotencia local
   evita doble clic; no garantiza exactly-once externo. Timeout ambiguo no se
   reintenta automáticamente. Reconciliar y mostrar delivery_unknown.
8. No atribuir todo fromMe a IA u operador. Correlacionar con envíos registrados;
   salida propia desconocida en vivo se identifica y suspende IA de forma segura.
   Backfill no dispara respuestas ni cambia control ni infla no leídos.
9. IDs opacos/texto, exactos por cuenta/canal. Conservar signo en Telegram, aliases
   JID/LID comprobados y PK interna estable. No resolver por substring de dígitos.
10. API /api/v1 del panel y /v1 interna, contratos OpenAPI/JSON Schema, validación
    runtime y tipos. Actor deriva de sesión/contexto interno verificado; nunca
    de un campo libre del navegador. SSE autorizado con replay y resync.
11. Toda red tiene timeout explícito. Lecturas pueden reintentar con clasificación;
    operaciones con efectos requieren analizar idempotencia/ambigüedad primero.
12. Generar no es entregar. Contexto IA incluye humano y solo salidas verificadas;
    invalidar generaciones canceladas y evitar reinsertarlas tras limpiar memoria.

ESTRUCTURA Y TECNOLOGÍAS DE DESTINO

- apps/gateway: bootstrap, modules/{conversations,contacts,messaging,automation,
  campaigns}, adapters, infrastructure, interfaces, migrations y tests.
- apps/panel/server: OAuth/identidad/proxy; apps/panel/web: React + TypeScript +
  Vite + React Router + TanStack Query, organización por features y CSS con tokens.
- apps/brain y apps/stt: Python con tooling independiente.
- packages/contracts y packages/testkit: contratos y fixtures/adapters falsos.
- npm workspaces para Node. Migrar JS a TS y carpetas gradualmente.
- SQLite local/WAL con worker propietario. Verificar driver/Node en plataformas
  soportadas antes de fijarlo; no inventar compatibilidad con Windows/Termux.
- En producción el proceso del panel sirve el build; no agregar otro runtime
  frontend ni microservicios/brokers sin necesidad probada y ADR correspondiente.

Mover archivos exige actualizar imports, entradas, launchers, CI, release config,
Dockerfiles, Compose y documentación. Conservar rutas de estado y credenciales.
No mantener doble autoridad JSON/SQLite: adaptar, importar, verificar y cortar
por módulo, con rollback de datos explícito. Después de nuevas escrituras, un
snapshot viejo no puede restaurarse descartando mensajes humanos enviados.

CRITERIOS DE INTERFAZ

La bandeja es la entrada principal. Escritorio de tres columnas y móvil de una;
scroll estable, paginación hacia atrás, no leídos, nuevos mensajes y borradores.
Cabecera Tomar control/Devolver a IA y compositor habilitado solo con control
confirmado. Diferenciar cliente, IA, operador, teléfono y eventos de sistema.
Ofrecer estados de carga, vacío, error, reconexión y entrega incierta. Teclado,
foco, contraste, etiquetas y movimiento reducido son requisitos. Logs, terminal
y mantenimiento van a Sistema. No mostrar controles de funciones inexistentes.

VERIFICACIÓN

- Usa checks vigentes de AGENTS y añade pruebas enfocadas al comportamiento que
  cambias: dominio/repositorios/contratos, UI y E2E según el alcance de la unidad.
- En la estructura actual: gateway/npm run check; brain/venv/bin/ruff check . y
  brain/venv/bin/python -m pytest tests/ -q. Smoke según AGENTS/CI si aplica.
- Usa adapters falsos, proveedores simulados y rutas temporales para DB, logs,
  locks, auth y colas. Nunca producción como fixture; cierra recursos SSE/pollers.
- Para control/envío prueba takeover durante generación/typing, entre globos,
  doble clic, dos pestañas, reinicio en human y caída tras aceptar proveedor.
- Para archivo prueba todos los mensajes del lote, duplicados, importación,
  orden, audio fallido, IDs entre canales y recuperación/replay de eventos.
- Para contexto prueba humano -> IA, cancelación, entrega parcial y limpieza de
  memoria sin borrar archivo ni recuperar un contexto limpiado accidentalmente.
- No consumas APIs IA reales para validar fixtures. Si no puedes ejecutar una
  prueba por entorno/acceso, registra el bloqueo exacto; no declares que pasó.
- Separar checks automatizados de prueba manual con cuenta real. Ningún resultado
  simulado demuestra pairing, entrega real o sincronización completa del proveedor.

CIERRE DE SESIÓN

1. Revisa diff y cambios ajenos. Evita revertir trabajo del usuario.
   Registra los bugs en docs/BACKLOG.md. Si bloquean cumplir la especificación de
   la unidad actual, repáralos y pruébalos antes de cerrar; difiere los demás con
   prioridad, fase límite y prueba de aceptación. No borres registros al resolver.
2. Actualiza docs/SESSION-STATE.md: qué cerraste, archivos, comandos/resultados,
   limitaciones, decisiones y siguiente unidad exacta con aceptación.
3. Actualiza solo checkboxes demostrados de docs/ROADMAP.md. Si cambian contratos
   o límites, actualiza arquitectura/ADR y AGENTS cuando corresponda.
4. Responde en español: resultado concreto, validación, pendientes materiales y
   próximo paso. No afirmes que la plataforma entera está lista por cerrar una fase.
5. Haz un commit local por cada fase o unidad entregable probada, con mensaje
   descriptivo y solo sus archivos. Informa hash y evidencia. No hagas push ni
   despliegues por ese motivo. Los bugs cerrados deben enlazar su commit/prueba.

Empieza ahora leyendo el estado y ejecutando su siguiente unidad. Si el usuario
añadió instrucciones nuevas, intégralas conservando los límites ya acordados.
```
