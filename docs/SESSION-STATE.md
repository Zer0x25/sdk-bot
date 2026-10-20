# Estado de continuidad — SDK-Bot

Actualización: 2026-10-20. F4.2 se fusionó en main en 7526edc (PR #4).
BUG-064 y BUG-065 están cerrados y sus arreglos pasaron CI. Release Please run #32
falló primero con E800, error interno de GraphQL de GitHub durante la búsqueda de
commits; el segundo intento pasó y generó la PR #2 `chore(main): release 0.3.0`,
que ya se fusionó en 9b0d0b5. BUG-067 eliminó un input inválido de la acción.

La revisión de workflows encontró que cada merge ejecutaba CI tanto en la PR como
en `main`, y disparaba el deploy Homelab aunque su runner `self-hosted` ya no está
disponible. BUG-068 cierra esa duplicación: CI queda en PRs a `main` y también se
puede lanzar manualmente; Release Please conserva el evento `push` a `main`, y el
deploy automático se retiró. El despliegue de producción sigue el procedimiento
manual documentado en README. La nueva PR de release #6 (`0.4.0`) volvió a quedar
`action_required` con cero jobs (run 39420100563); BUG-066 permanece abierto para
resolver la autorización de checks de Release Please. `.release-please-config.json`
mantiene las releases como borrador y F4.3 sigue pendiente.

## Objetivo vigente

Plataforma multicanal con bandeja tipo WhatsApp Web, historial persistente,
respuesta humana desde el chat y retorno seguro a IA con contexto actualizado.

## Resultado acumulado

- Política acordada: commit local al cerrar cada fase/unidad probada y bugs en
  [BACKLOG.md](BACKLOG.md). Reparar bloqueantes de la especificación actual;
  diferir los demás con prioridad, fase límite y aceptación.
- Base arquitectónica, ADR-005, roadmap, prompt reutilizable y orientación en
  AGENTS/README creados en la sesión inicial.
- F0.1 completada: [BASELINE-CONVERSACIONES.md](BASELINE-CONVERSACIONES.md) inventaría
  captura, identidad, sockets/polling, comandos, persistencia, generación/envío,
  handoff, endpoints, UI y cobertura existente con referencias de archivo/línea.
- Commit de cierre F0.1: `9155212`, incluye base documental y backlog.
- F0.2 completada: [SQLITE-SPIKE.md](SQLITE-SPIKE.md), script temporal reproducible,
  driver node:sqlite con worker y mínimo sin flags Node 22.13.0 comprobado en Linux.
  Backup VACUUM INTO; Windows/Termux pendientes. CI prepara ejecutar el script.
- Commit de cierre F0.2: `f69ac1d`.
- F0.3 completada: [SPEC-OPERATIVA-V1.md](SPEC-OPERATIVA-V1.md) fija identidades,
  permisos/control/versiones, retención, corte/rollback y límites; 75 escenarios
  sintéticos de aceptación futura y protocolo de medición en VALIDACION-V1.
- F1A completada: workspace raíz packages/* y contracts con JSON Schema/OpenAPI,
  validadores AJV y tipos TS generados; CI de contratos. Gateway conserva su lock
  y despliegue independientes. Evidencia: [CONTRATOS-V1.md](CONTRATOS-V1.md).
- F1B completada: sesión v1, actor/grants servidor, firma panel → gateway, límites
  HTTP/SSE y /history brain autenticado. Contratos instalados en gateway/Docker.
  Evidencia: [FRONTERA-AUTENTICADA-V1](FRONTERA-AUTENTICADA-V1.md).
- F2A: worker SQLite, repositorios, migración, dedup/aliases/cuarentena, eventos,
  retención/backup de repositorio y snapshot durable en sesión. Evidencia:
  [ARCHIVO-CONVERSACIONES-F2A](ARCHIVO-CONVERSACIONES-F2A.md).
- F2B.1: parada segura del reset CLI, rechazo de supervisión antes de señales y
  comprobación de identidad/parada; brain publica lock configurable. BUG-029/031
  cerrados. Evidencia: [RESET-SEGURO-F2B1](RESET-SEGURO-F2B1.md).
- F2B.2: captura base WA live/history antes de legacy, identidad/cuenta exactas,
  cola acotada, guardas de socket y purga inicial/diaria. BUG-001/002/003/032
  cerrados. [ADR-006](adr/006-admision-durable-en-adapter.md) documenta la espera
  de admisión en el adapter antes del consumidor legacy. Evidencia:
  [CAPTURA-WHATSAPP-F2B2](CAPTURA-WHATSAPP-F2B2.md).
- F2B.3: STT durable sobre el mismo ID y huella, pending/completed/failed con
  message.updated, recuperación de pendientes, captions por tipo y tareas acotadas.
  BUG-033/034/036 cerrados. [MULTIMEDIA-WHATSAPP-F2B3](MULTIMEDIA-WHATSAPP-F2B3.md).
  BUG-037 descarga Baileys sin abort físico queda puerta F8 antes de STT real.
- F2C.1: descubrimiento TG observa el adapter configurado sin getUpdates extra;
  HTTP cancelable/cierre antes de reemplazo, offset RAM separado al cambiar token,
  backoff/4xx y setup parcial. BUG-004/038–042 cerrados; BUG-043 salida diferido F5.
  [TELEGRAM-DUENO-UNICO-F2C1](TELEGRAM-DUENO-UNICO-F2C1.md).
- F2C.2: `getMe` verifica el bot y deriva `telegram_bot:<id>` estable; la migración
  v2 añade cursores por cuenta. Cada lote confirma mensajes, huellas, eventos,
  proyección y cursor antes del offset siguiente. JSON conserva IDs enteros no
  seguros; mensajes deduplican por bot/chat/message_id. Administración, grupos y
  tipos excluidos avanzan cursor transaccionalmente. El audio se archiva como
  marcador y STT actualiza el mismo mensaje antes del pipeline. BUG-005/009/044/047
  y la porción TG de BUG-008 cerrados; F2D cierra después BUG-045 y BUG-046 inbox
  admin queda diferido. Evidencia: [TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md).
- F2D: migración SQLite v3 agrega `legacy_dispatch` atómico con la captura WA/TG;
  el pump reconstruye `StandardMessage` cuando el canal abre, trata eventos como
  wake-up y persiste ACK. Audio espera STT; respond mantiene pendiente el ACK hasta
  completar debounce/IA. BUG-045 cerrado para el corte post-commit→handler;
  BUG-050 mantiene abierta la idempotencia de efectos externos y BUG-051 la
  reconciliación antes de desplegar sobre archivos reales. Evidencia:
  [REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md).
- F2E.1: `sendMessage` de WA archiva la aceptación del proveedor con su ID y el eco
  `fromMe` converge en ese mensaje; la prueba cubre el eco antes del retorno. TG
  archiva el `Message` aceptado solo para chats privados exactos, fuera del chat
  admin/grupos; HTTP 200 `{ok:false}` falla y no deja salida. Ambas salidas quedan
  `external_self` hasta tener origen correlacionado en F5. Respuesta TG con UTF-8
  dividido conserva contenido e IDs >2^53. BUG-052/053/054 cerrados.
  Evidencia: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md).
- Sin migrar datos antiguos ni conectar cuentas reales. La bandeja web consulta
  páginas/SSE autenticados existentes, pero la UI aún no integra SSE ni ofrece API
  de envío/control; la barrera de automatización v1 sigue pendiente de F5.

## Validación ejecutada en F0.1

Los comandos se ejecutaron sobre copia temporal de archivos versionados con
contenido actual, enlazando únicamente dependencias instaladas. Sin copiar .env,
sesiones ni DB del workspace; brain también escribió logs dentro de la copia.

| Comando/entorno | Resultado |
|---|---|
| gateway: npm run check, Node 24.19.0 | Lint, typecheck y 143 pruebas pasan. |
| gateway: npm exec --yes --package=node@22 -- sh -c 'node --version && npm run check', Node 22.23.3 | Lint, typecheck y 143 pruebas pasan. |
| brain: venv/bin/ruff check ., Python 3.12.14 / ruff 0.17.1 | Sin hallazgos. |
| brain: venv/bin/python -m pytest tests/ -q | 21 pruebas pasan. |
| bash deploy/linux/tests/dev-smoke.sh con preload offline WA y TG sin token | Launcher/health/apagado pasan; puertos liberados. |

Smoke de procesos con transporte sustituido: no demuestra pairing, sync, OAuth,
entrega externa ni STT/IA real. No se llamó a proveedores ni se usaron credenciales.
No se ejecutó npm ci limpio. No se observaron fallos previos en los checks hechos.
Detalles de reproducción y logs efímeros están en la baseline.

## Validación ejecutada en F0.2

- `npm run spike:sqlite`: 10 comprobaciones pasan en Linux x64 con Node 22.13.0,
  22.23.3 y 24.19.0; worker/WAL, rollback, aislamiento, cursor, concurrencia,
  lote 5000, backup/restauración y reapertura. Temporales eliminados.
- Fallo simulado después de escribir, en Node 22.13.0/24.19.0: conserva el error,
  código 1, workers cerrados y estado temporal eliminado. Cierra BUG-015.
- `npm run check` con Node 22.13.0 en copia temporal: lint, tipos y 143 pruebas
  pasan; el spike vuelve a pasar. Sin usar credenciales ni canales.
- Node 22.12.0 no carga node:sqlite sin flags; 22.13.0 no tiene sqlite.backup,
  por eso el experimento prueba VACUUM INTO. ExperimentalWarning visible en 22.
- No se repitió smoke/brain, cuyos módulos no cambiaron. No se hizo push ni se
  ejecutó GitHub Actions. Véase SQLITE-SPIKE para comandos/limitaciones.

## Hallazgos que condicionan implementación

- F2B.2 corrige el primer elemento del lote, la conexión live al cache y los
  callbacks de socket reemplazado. F2B.3 repara BUG-033/034/036; la descarga
  física tiene BUG-037 antes de aceptación STT real F8.
- F2C.1 repara el descubridor paralelo testAndGetChatId y las carreras del request
  en reconnect; descubrimiento solo observa al owner configurado, sin nuevos offsets.
- F2C.2 persiste captura y cursor Telegram antes de emitir al legacy. F2D reanuda
  clientes desde outbox hasta handler/IA; un resultado externo ambiguo aún puede
  repetirse si falla antes del ACK (BUG-050/F5). El comando admin confirma cursor
  antes de ejecución y tampoco tiene inbox durable (BUG-046/F5).
- Handoff/pause no cancelan jobs admitidos ni protegen cada envío; flush de cola
  tampoco reevalúa el control. Brain guarda respuestas antes de entregarlas.
- Identidades/anti-bucle usan índices o IDs sin namespace suficiente; comandos
  por dígitos pierden signo TG y pueden resolver por coincidencias parciales.
- Los checks existentes no prueban estos escenarios de conversación completa.

## Validación ejecutada en F0.3

- Consistencia documental y JSON: 75 IDs de escenario únicos; matriz completa de
  36 combinaciones; UUID/IDs TG, handoff, cuarentena, retención, seis límites Unicode
  y cantidades del dataset/plazos revisados. Hash del fixture en VALIDACION-V1.
- BUG-016 de diseño corregido: deduplicación por identidad canónica verificada,
  sin tratar JID/LID del mismo hilo como dos chats distintos.
- No se cambió runtime ni se ejecutaron suites/benchmark del producto en esta
  unidad documental. Los escenarios aún deben ejecutarse contra implementaciones.

## Validación ejecutada en F1A

- Instalaciones limpias raíz/gateway en copia temporal sin secretos ni DB.
- Raíz npm run check: 14 tests, referencias OpenAPI válidas, tipos reproducibles y
  compilación con casos positivos/negativos pasan en Node 22.13.0 y 24.19.0 Linux.
- TXT-01 a TXT-06 ejecutados contra validador; ID-01 a 07 solo formas, sin demostrar
  resolución/aliases. El resto de escenarios sigue pendiente de servicios reales.
- Gateway npm run check: lint, tipos y 143 tests pasan Node 24.19.0; spike SQLite
  pasa sus 10 comprobaciones y elimina temporales. Brain/smoke no repetidos.
- npm ci --omit=dev en layout de manifiestos Docker resuelve dependencias gateway
  sin raíz. No se construyó imagen ni se ejecutaron canales/IA/GitHub Actions.
- BUG-017 corregido: generador marcaba defaults opcionales como requeridos;
  defaultNonNullable=false. Compilación reproduce fallo al reactivar opción;
  --check rechaza artefacto alterado. BUG-018 corregido: TextEncoder sustituye
  Buffer; test con global Buffer ausente. Bundle/navegador pendiente F4.
  BUG-001 a 014 siguen abiertos.

## Validación ejecutada en F1B

- Raíz npm ci y npm run check: 14 tests de contratos, generación y tipos pasan
  Node 24.19.0. Schemas/OpenAPI no cambiaron; cambió instalación/consumo runtime.
- Gateway npm ci limpio; npm run check pasa lint/tipos y **158 tests** en Node
  24.19.0 y mínimo 22.13.0 Linux. Comprobación final usa copias separadas por
  versión. Son 143 anteriores + 15 de frontera, no 158 casos de chat completo.
- Brain: ruff y 21 tests pasan, suite secuencial desde copia; /history prueba
  contenido privado denegado sin/con clave incorrecta y lectura con clave correcta.
  / y /health públicos. No hubo peticiones /chat ni llamadas a proveedores.
- Imagen de gateway construida en Docker con npm ci --omit=dev, contracts
  empaquetado sin symlink ni node_modules raíz. Dockerfile temporal conserva COPY/
  instalación/entrada reales y solo agrega mount de CA proxy al RUN npm ci para
  este cloud, con TLS verificado; certificado no queda en capas. No build Compose.
- Esa imagen (Node 22.23.3) pasa **15 tests de frontera con --network none**;
  proceso HTTP de panel/bus y OAuth simulado, sin iniciar gateway/index.js/canales.
  Verificado require contracts y precisión TG sin instalación raíz.
- Compose config validado con env_files vacíos temporales y secreto ficticio:
  rechaza ausencia del secreto, comparte variable gateway/panel, conserva comando
  node panel/index.js y bus sin puertos publicados. No se ejecutó compose up.
- bash -n pasa Linux y scripts Termux editados. No se ejecutó smoke del launcher:
  aunque puertos estaban libres, sus logs globales /tmp preexistían; se conservaron.
  Prueba previa de launcher offline sigue en baseline, sin atribuirla a esta unidad.
- Reproducción con panel de f0d2b13 confirma excepción por cookie/Referer dañados,
  OAuth no verificado aceptado, separadores faltantes de cookie y desvío de proxy
  por request-target absoluto; regresiones pasan en implementación nueva.
- BUG-013 y BUG-019 a 023 cerrados; BUG-010 proxy reparado, TG pendiente F5.
  BUG-025 también cerrado: panel/.env ya se excluye de Docker; canary falso
  reproduce inclusión con reglas anteriores y demuestra exclusión tras reparar,
  tanto en COPY directo como en imagen de producción sin ese archivo.
  BUG-024 registrado antes de roles limitados/F3. BUG-014 no bloqueó la suite
  secuencial y sigue abierto. No se marcaron resueltos bugs de captura/control.
- Evidencia efímera: /tmp/sdkbot-f1b-1xfiq0qs (logs de Node/imagen/reproducción).
  Sin .env/sesiones/DB nuevas en workspace, sin credenciales reales en fixtures.
  No push, despliegue, Google OAuth real, IA ni canales reales. GitHub Actions
  preparado, no ejecutado. Windows/Termux no ejecutados.

## Decisiones y puertas después de F1B

- SDK_PANEL_GATEWAY_SECRET >=32 bytes en ambos procesos; Compose lo exige.
  Producción/bind de bus expuesto sin secreto falla cerrado. Solo legacy local
  de desarrollo en loopback admite compatibilidad sin firma. Panel requerido sin
  OAuth no se abre ni habilita dev como fallback.
- PANEL_DEV_ACTOR=true requiere NODE_ENV=development y auth no forzada; grants
  PANEL_ACTOR_GRANTS por google:<sub> o dev:local, omisión solo lectura v1.
  Cookie OAuth anterior conserva legacy; requiere login nuevo para v1.
- Grants v1 no limitan todavía el administrador legacy: BUG-024 antes de ofrecer
  operadores limitados. No describir esto como un sistema global de roles de equipo.
- F1B usaba bootstrap volátil. **F2A ya lo sustituye** por epoch/seq del archivo;
  falta/fallo devuelve 503. Esto no habilita páginas/SSE de F3.
  PolicyVersion efectiva en memoria incluye pausa/modo/perfil global; F5 la hará
  durable. No usarla ahora para afirmar cancelación/entrega segura.
- Cache replay 10000 entradas/30s, no durable entre reinicios. F5 requiere ledger
  de idempotencia antes de mutaciones; no confundir requestId con Idempotency-Key.
- contracts es dependencia file: empaquetada (install-links=true), no workspace
  gateway. Repetir npm ci en gateway tras cambiar contracts. Docker copia fuente;
  launchers/updater detectan cambios. No depender de la instalación raíz en runtime.

## Validación ejecutada en F2A

- Gateway check (lint/tipos): **174 tests** en Node 24.19.0 y mínimo 22.13.0 Linux,
  copias separadas sin secretos/DB, dependencias instaladas enlazadas. No npm ci
  nuevo porque no cambiaron manifiestos. 158 anteriores +14 archivo +1 reset +1
  entry real offline. Raíz check: 14 contratos/generación/tipos pasan.
- Repositorios probados: transacción con rollback, identidad/cuenta exactas,
  JID/LID/dedup/procedencia, conflictos, IDs y secuencias >2^53, cobertura/history,
  páginas internas, marcadores multimedia/oversized, FIFO/saturación/timers,
  retención estricta y huellas después de borrar cuerpo, backup/restore con epoch.
- Otro proceso es eliminado con SIGKILL dentro de transacción sin commit: conserva
  anterior y revierte incompleto. No es prueba de pérdida de energía.
- Sesión firmada real usa snapshot del archivo; archivo cerrado →503 saneado.
  Entry real con WA sustituido/TG sin token prueba dos arranques, PID/lock
  configurables, epoch estable y SIGTERM 0. Smoke gateway+panel con puertos
  efímeros también pasa. Launcher global no repetido para conservar logs previos.
- Docker producción con contracts/npm ci --omit=dev construido; adaptación cloud
  solo mount CA temporal/TLS verificado en instalación. Pruebas sin red y profiles
  montados como Compose: **37 tests pasan**, Node 22.23.3. Primer run sin ese
  montaje falló un assert de profiles del fixture, corregido al montar el volumen. Sin compose up ni canales reales.
- BUG-026/027/028/030 reparados; BUG-029 nuevo pendiente antes de captura live F2B.
  BUG-016 ejecutado contra DB real; bugs de adapters/control no se cerraron.
- Evidencia efímera /tmp/sdkbot-f2a-kg__9opd. Brain/smoke launcher no repetidos,
  Windows/Termux/GitHub Actions no ejecutados. Sin push/despliegue/IA/OAuth real.

## Validación ejecutada en F2B.1

- Unidad acotada por AGENTS: cerrar la puerta de reset antes de conectar captura.
  F2B no se declara completada por esta corrección.
- Gateway npm run check: lint/tipos y **188 tests** pasan Node 24.19.0 y mínimo
  22.13.0 Linux, en copias independientes sin secretos/DB. Dependencias instaladas
  enlazadas; no npm ci nuevo. Son 174 previos +14 de guarda/CLI.
- Brain ruff y **23 tests** pasan, secuenciales: 21 previos +2 de lock configurable
  y fallo de arranque si no se publica. BUG-014 sigue abierto, no paralelizar Python.
- Reproducción de stopProcess de 37525a1 con supervisor falso confirma SIGTERM y
  reemplazo vivo; detector antiguo devuelve false ante cgroup systemd v2. Nueva
  guarda rechaza servicio antes de señales a gateway/brain y antes del borrado.
- Regresiones: supervisor simulado/reintento offline, PID/lock reemplazados,
  inicio durante parada, lock eliminado con proceso vivo, SIGKILL/permiso/fallo de
  inspección. CLI --yes real en hijos prueba aborto 1 y reset offline 0 sobre
  inventario temporal; nunca relanza en --yes. Otro hijo cierra SQLite real antes
  de borrar DB/WAL/SHM. Entry offline anterior sigue pasando en suite completa.
- No detector universal de supervisores ni barrera contra lanzamiento concurrente:
  detener supervisores antes del CLI y mantenerlos detenidos hasta finalizar.
  Cgroup de servicio ancestro se rechaza conservadoramente. No señales a servicios
  reales ni reset de datos originales. Windows/Termux requieren parada previa;
  no ejecutados. Rutas absolutas coherentes en procesos/CLI.
- Evidencia efímera /tmp/sdkbot-f2b1-llaak1dx. Sin cambios de manifiestos/contratos,
  no nuevos checks raíz, build Docker ni smoke launcher. Logs previos conservados.
  Sin proveedores/canales/OAuth reales, push ni despliegue.

## Validación ejecutada en F2B.2

- Gateway npm run check: lint/tipos y **204 tests** pasan Node 24.19.0 y mínimo
  22.13.0 Linux en copias independientes. 188 anteriores +15 captura/retención +1
  entry integrado. No npm ci nuevo: manifiestos/contratos no cambiaron.
- SQLite real y Baileys simulado: lotes/cuenta estable, cache live, restart/dedup,
  JID/LID y cuarentena, IDs entre chats/cuentas, history/append/eco inertes,
  malformed/oversized, cola 1000/32MiB, fallo después de commit sin retry,
  sockets obsoletos, STT tardío y reconexiones solapadas. Purga antes de admisión,
  acotada y con yield, falla cerrada si no puede iniciar.
- Ráfaga de 1001: 1000 admitidos, saturación visible, mensaje restante guardado
  cuando se reentrega. Heartbeat avanza; no demuestra presupuestos p95/p99 ni
  recuperación garantizada WA. La pérdida de proveedor sigue siendo posible.
- Entry real con transporte/auth sustituidos: dos ciclos SIGTERM 0 conservan tres
  mensajes/eventos, epoch/seq estables y cache reconstruida. IA pausada, sin envío.
- Docker de producción F2A ya instalado, código/tests actuales montados readonly,
  profiles como Compose y --network none: **52 tests** pasan Node22.23.3. No nueva
  imagen construida ni compose up; solo compatibilidad con dependencias/layout.
- Reproducción de adapter 4bb4ec3: lote 3 emite 1, eventos de socket viejo tienen
  efectos y auth antigua sustituye conexión nueva. Regresiones cierran
  BUG-001/002/003/032; 008 solo aislamiento de archivo y 009 corregido solo WA.
- Nuevos pendientes: BUG-033/034 antes de cerrar F2B (STT durable/tipo con caption);
  BUG-035 pairing async diferido F8. No se presentan marcadores como transcripciones
  persistidas ni unknown como autoría IA/humana confirmada.
- Evidencia efímera /tmp/sdkbot-f2b2-uh19lsui. Brain/contratos no cambiaron; sin
  repetir sus suites. Launcher global no repetido para conservar logs. Sin
  proveedores/cuentas/OAuth reales, push, despliegue, Windows/Termux ni carga completa.

## Validación ejecutada en F2B.3

- Gateway npm run check: lint/tipos y **218 tests** pasan en Node 24.19.0 y mínimo
  22.13.0 Linux, copias independientes sin secretos/DB. 204 anteriores +5 archivo
  +8 captura/enriquecimiento +1 cancelación STT. Dependencias enlazadas tras npm ci
  --offline gateway con scripts habilitados para refrescar contracts empaquetado.
- Contratos raíz npm run check: generación/tipos y **15 tests** pasan en ambas
  versiones. Caption opcional conserva marcadores previos; tipos regenerados.
  No cambios de manifiestos/lock ni nuevas dependencias.
- SQLite real: CAS, evento mínimo/versión atómicos, huella estable, alias/dedup,
  reinicio de pending a failed, purga sin recreación, caption/oversized y texto
  antiguo conservado ante forma incompatible nueva en cuarentena.
- STT sustituido: pending antes de descarga y completed antes de legacy; captura
  de texto progresa durante STT. Falla/exceso/Unicode, deadline/saturación, cancelación
  de socket, revisión de identidad y resultado incierto sin retry pasan. Self-chat
  audio sigue fuera del archivo. History/fromMe/duplicados no inician STT.
- Cuatro trabajos sin cola, deadline 150 s, acumulación por stream limitada a
  STT_MAX_UPLOAD_BYTES. Un trabajo que ignora abort conserva plaza hasta terminar;
  no publicar resultados tardíos. Shutdown/reset drenan actualizaciones antes de SQLclose.
- Imagen nueva sdkbot-f2b3:local construida con npm ci --omit=dev, contrato actual
  empaquetado y sin node_modules raíz; CA temporal solo en RUN/TLS verificado.
  **72 tests** pasan Node22.23.3 --network none, profiles como Compose. No despliegue.
- Reproducción adapter/normalizador 7d99f36 confirma cinco STT sin límite, estados
  not_requested tras terminar y caption como texto. BUG-033/034/036 cerrados.
  BUG-037 nuevo: fetch sustituido confirma que Baileys no reenvía signal de descarga;
  deferido P2/F8 antes de aceptar STT real, sin afirmar aborto físico/handles cerrados.
- Evidencia efímera /tmp/sdkbot-f2b3-9a8_8bcc. Fixture 75 expectativas sin cambios;
  no carga completa. Brain/launcher no cambiaron ni se repitieron, logs conservados.
  Sin cuentas/STT/modelos/OAuth reales, push, despliegue, Windows/Termux/GitHub Actions.

## Validación ejecutada en F2C.1

- Gateway npm run check: lint/tipos y **233 tests** pasan Node24.19.0 y mínimo
  22.13.0 Linux, copias independientes sin secretos/DB. 218 anteriores +10 ownership/
  bus +4 HTTP +1 setup. Diez tests Telegram previos actualizados y conservados.
- Descubrimiento concurrente sobre poll activo, mensajes al consumidor normal,
  sin peticiones/offset extra. Caché cinco minutos, esperas 1,5 s/máximo 64,
  cancelación individual, token no guardado, timeout/reinicio y setup parcial pasan.
- Reemplazos esperan cierre del request local; connects superados no instalan
  loops. Offset RAM conserva el mismo token y reinicia al cambiarlo. Audio legacy
  revalida token/generación tras esperas; STT tardío no emite con el reemplazo.
- HTTP local: deadline absoluto, cancelación y cierre sin headers/con body detenido,
  8 MiB, UTF-8 fragmentado/dañado y JSON inválido. 4xx paran visibles; 5xx/red
  aplican pausa cancelable. POST de prueba de notificación acotado y sin retry.
- Reproducción 42b8321 confirma dos lectores, petición A viva al abrir B, offset
  124 heredado, retry inmediato de 500, UTF-8 corrupto y UI parcial bloqueada.
  BUG-004/038/039/040/041/042 cerrados. BUG-043 inspeccionado y diferido F5:
  retry Markdown de salida relee token mutable; no se presenta como reparado.
- Docker sdkbot-f2b3:local con dependencias de producción, código afectado/tests
  actuales readonly y profiles como Compose: **97 tests** pasan Node22.23.3,
  --network none. No imagen nueva, compose up ni despliegue.
- Evidencia efímera /tmp/sdkbot-f2c1-d6sse47d. Sin cambios de manifiestos/contratos/
  brain: no npm ci nuevo ni sus suites. Sin launcher global para conservar logs.
  Fixture 75 expectativas intacto; no carga completa. Sin cuentas/getUpdates/getMe/
  envíos/STT/OAuth reales, push ni GitHub Actions. Windows/Termux pendientes.

## Validación ejecutada en F2C.2

La evidencia y límites de esta unidad están en
[TELEGRAM-CAPTURA-F2C2](TELEGRAM-CAPTURA-F2C2.md).

- Gateway `npm run check` en copias del árbol staged: Node 24.19.0 y mínimo
  Node 22.13.0, lint/tipos y **242 pruebas** pasan en ambos. Node 22 emite la
  advertencia conocida de `node:sqlite` experimental.
- Docker cacheado `sdkbot-f2b3:local`, Node 22.23.3, `--network none`, imagen de
  producción sin dependencias de desarrollo: **242 pruebas** pasan con el snapshot
  completo versionado y dependencias runtime; no se reconstruyó imagen ni se ejecutó
  Compose. La primera pasada montó solo `gateway/` y falló tres pruebas que requieren
  perfiles versionados de `brain/`; la repetición incluyó el árbol completo y pasó.
- Las 8 pruebas nuevas de `telegramCapture.test.js` cubren migración v1→v2,
  reapertura/offset, IDs mayores de 2^53, rollback de lote, redelivery, namespace,
  exclusiones, despacho admin stale y descarga de audio limitada por stream.
- Códigos y perfiles fueron los del repositorio versionado en copias temporales;
  no se copiaron DB, secretos ni estado local. No se llamaron proveedores/canales,
  STT real, Docker build, ni pruebas de carga de 1M mensajes.

## Validación ejecutada en F2D

La evidencia funcional y los límites de replay están en
[REPLAY-LEGACY-F2D](REPLAY-LEGACY-F2D.md).

- `gateway npm run check` en Node 24.19.0: lint, typecheck y **247 pruebas** pasan.
- Pruebas enfocadas de archivo, captura WA/TG y `legacyDispatch.test.js` pasan;
  migraciones v1/v2→v3, commit/cursor/outbox atómicos, corte antes del wake, reopen,
  ACK persistente, gating por canal, retry, debounce/IA diferido, y transcripción
  audio completada/fallida. `git diff --check` no reporta espacios defectuosos.
- Sin canal real, proveedores, STT real, DB de usuario ni carga de 1M. No se migran
  filas pre-v3 a outbox porque no existe un recibo que pruebe si ya se procesaron.

## Validación ejecutada en F2E.1

- Pruebas WA/TG enfocadas: **34 pasan**, incluyendo ID de proveedor, `external_self`,
  eco WA antes/después del ACK, deduplicación, exclusión de admin/grupos, entero TG
  >2^53, UTF-8 dividido y `ok:false` HTTP 200 sin fila nueva.
- `gateway npm run check` en Node 24.19.0: lint, typecheck y **250 pruebas** pasan.
- Sin canal/proveedor real, credenciales, DB de usuario ni carga de 1M. Detalles y
  límites: [SALIDAS-ACEPTADAS-F2E1](SALIDAS-ACEPTADAS-F2E1.md).

## Validación ejecutada: F2E.2 / carga sintética completa

- Dataset v1 reproducible: 1M mensajes, 2.000 conversaciones, cinco cuentas,
  50.000 redeliveries y 40 aliases WA; throughput 3.152 mensajes/s. Snapshot:
  integridad `ok`, 50.000 eventos retenidos, 0 cuarentenas/FK.
- Dos calentamientos y tres runs medidos, 2.000 páginas por tipo/run y 2.700
  ingestas live/run. En los tres medidos: p95/p99 de lista 1,94–2,55/5,02–5,87 ms;
  página de mensajes 1,87–2,48/4,91–5,87 ms; ingesta steady p99 7,39–12,48 ms;
  event loop p99 10,86–10,90 ms; RSS 280,3–284,2 MiB; cero errores.
- BUG-055: la primera carga halló 50.700 eventos tras el tráfico nuevo; la poda ahora
  ocurre al final de cada commit que genera eventos. La repetición retuvo exactamente
  50.000 en los cinco runs. Saturación por 1.000 items y 32 MiB rechaza con claridad;
  Telegram no confirma el cursor al saturarse y no se crea mensaje/dispatch.
- Evidencia y muestras: [F2E2-CARGA-COMPLETA](F2E2-CARGA-COMPLETA.md) y
  [JSON completo](evidence/F2E2-load-report.json). `gateway npm run check` en
  Node 24.19.0 pasa lint, typecheck y **256 pruebas**.
- Perfil de host distinto (Linux x64, 3 CPU/10,45 GiB vs objetivo 2 CPU/4 GiB): no
  certificar aún el presupuesto de referencia; repetir allí. Takeover queda F5;
  atribución outbound del backfill se mantiene `unknown` hasta el outbox F5.
  Sin canal real, credenciales ni DB de usuario.

## Validación ejecutada: F3.1 / lectura autenticada

Evidencia y contrato de la unidad: [F3.1-LECTURA-AUTENTICADA](F3.1-LECTURA-AUTENTICADA.md).

- API v1 implementada para cuentas, lista y detalle de conversaciones, páginas de
  mensajes y `POST /read`. Panel/gateway validan firma y capacidad; el proxy verifica
  `AccountsResponse`, `ConversationsResponse`, `ConversationResponse`,
  `MessagesResponse` y `ReadResponse`.
- Los cursores son opacos y HMAC; la lista enlaza actor, filtros, época/watermark,
  revisión de agenda/política y lectura local. Cambio concurrente devuelve 410 para
  recargar. Mensajes usan keyset `(occurredAt,id)` y se devuelven cronológicamente.
- `read_cursors` es durable por actor y conversación, monotónico, y no marca recibos
  remotos. Los nombres se proyectan por coincidencia exacta con la agenda; identidad
  no resuelta produce nombre null. Control sigue siendo una proyección de JSON hasta
  F5, sin habilitar takeover ni operadores limitados.
- Añadido BUG-056 (filtros opcionales null) y BUG-057 (búsqueda sensible a caja);
  ambos bloqueaban lectura/filtros F3.1, se reprodujeron, corrigieron y cerraron con
  prueba HTTP. La prueba de archivo también confirma cursor actor-local tras reopen.
- Validación: `npm run check` raíz (contratos/generación/tipos/15 tests) y
  `npm run check` gateway (lint, typecheck y 258 tests) en Node 24.19.0/Linux.
  Prueba adicional de API firmada incluye filtros, empate de timestamps,
  capacidades, historial parcial, rechazo 401/403/422/410 y aislamiento de lecturas.

BUG-024 continúa como puerta antes de crear operadores limitados: esta unidad no
introduce nueva UI ni roles. El SSE exige sesión firmada y `conversations:read`;
cada conexión dura como máximo los 30 segundos del grant firmado, por lo que el
proxy vuelve a resolver y firmar actor/capacidad al reconectar.

## F3.2 completada: SSE, replay y resync

- `GET /v1/events` publica eventos mínimos tras commit desde el worker SQLite.
  El subscriber se instala antes de leer watermark; el replay se pagina hasta ese
  watermark y se deduplica con la cola viva. Sin cursor se entrega un checkpoint
  id-only y el cliente obtiene el snapshot tras abrir el stream.
- Cambio de época o hueco de retención/purga emite `resync.required` en el
  watermark actual. Replay no extiende la ventana de 50.000 eventos. Cola por
  conexión limitada a 1.000 eventos/1 MiB, heartbeat de 15 s y reconexión a 3 s.
- Proxy conserva `Last-Event-ID`, transmite SSE y cierra upstream al desconectar.
  Pruebas cubren auth 401/403, cursor malformado/futuro, cambio de época,
  expiración, carrera determinista replay/live, publicación solo tras commit,
  duplicado silencioso, respuesta de archivo no disponible y cleanup.
- Evidencia: [F3.2-STREAM-SSE-REPLAY](F3.2-STREAM-SSE-REPLAY.md). `gateway npm run
  check`: lint, TypeScript y 264 pruebas; `npm run check` raíz: generación,
  TypeScript y 15 pruebas. Node 24.19.0/Linux. No se encontraron bugs funcionales
  nuevos; BUG-024 permanece como puerta de autorización administrativa legacy.

## F4.1 completada: shell visual de bandeja

- App React/TypeScript/Vite en `gateway/panel/web`, servida por el proceso de panel
  existente bajo `/inbox` solo con `PANEL_CONVERSATIONS_UI_ENABLED=true`. La ruta
  legacy `/` y OAuth se conservan; la UI permanece apagada por defecto.
- Shell adaptable de navegación, conversaciones, hilo y contexto, tokens visuales,
  router y cliente TanStack Query. El ID de chat vive en URL; filtros, búsqueda y
  envío están deshabilitados hasta integrar comportamiento real. No hay fixtures
  de conversación en la interfaz.
- Docker tiene etapa de build separada para Vite y copia el artefacto al runtime,
  que conserva `npm ci --omit=dev`. No se abre un servicio/canal adicional.
- BUG-058/059/060 se reprodujeron y cerraron en esta unidad: import de icono,
  ESLint sobre bundle generado y setup Vitest descubierto como test de Node.
- Evidencia: [F4.1-SHELL-VISUAL](F4.1-SHELL-VISUAL.md). `gateway npm ci` limpio y
  `gateway npm run check`: ESLint/TypeScript pasan; 3 pruebas Vitest, build Vite,
  prueba HTTP del build y 269 pruebas Node gateway pasan en Node 24.19.0/Linux.
- Imagen Docker Node 22 construida con CA temporal vía BuildKit Secret; una prueba
  dentro de la imagen confirma bundle/contratos presentes y Vite ausente del runtime.
  El CA solo se monta durante `npm ci`, no queda en capas. BUG-061 cierra la
  adaptación del builder a instalaciones detrás de CA corporativo.
- La auditoría inicial encontró BUG-062 P1 en `sharp@0.35.3` y
  `music-metadata@11.14.0`, transitivos de Baileys. Se cerró en un commit de lockfile
  separado; la evidencia está abajo y en
  [DEPENDENCY-SECURITY-BUG-062](DEPENDENCY-SECURITY-BUG-062.md).
- No hubo navegador E2E con viewport ni prueba visual manual; queda como límite
  registrado, junto con la conexión de API pendiente. El CSS incluye breakpoints,
  y Vitest verifica regiones, navegación y foco por teclado.

## BUG-062 completado: dependencias de medios

`npm audit fix` actualizó solo `gateway/package-lock.json`: `sharp@0.35.5` y
`music-metadata@11.16.1` bajo el Baileys existente. Auditoría completa y producción
dan cero vulnerabilidades; gateway check conserva 269 pruebas y 3 Vitest. Docker
Node 22 se reconstruyó con el CA temporal y probó runtime, bundle, contrato y
ausencia de Vite/CA. Commit separado de la UI.

## F4.2 completada: lectura HTTP real de la bandeja

- La app consulta cuentas, lista filtrada, detalle e historial paginado a través de
  `/api/v1` del panel OAuth. La selección queda en la URL. Búsqueda por contacto,
  filtros no leídos/abiertas/canal y páginas siguientes usan cursores de la API.
- El hilo carga primero los mensajes recientes, ordena cronológicamente las páginas
  anteriores y conserva el ancla de scroll. Representa contenido multimedia y su
  disponibilidad; la ficha contextual presenta canal/estado, automatización,
  ciclo, no leídos y cobertura sin mostrar IDs del proveedor.
- Al abrir mensajes entrantes actualiza el cursor local monotónico por
  `inboundSeq`; esto no manda recibos remotos. Carga, vacío, errores, reintentos y
  cursor vencido tienen estados explícitos. BUG-063 se cerró: al vencer un cursor
  de lista, “Actualizar lista” vuelve a la primera página.
- Evidencia: [F4.2-LECTURA-HTTP-REAL](F4.2-LECTURA-HTTP-REAL.md). `gateway npm run
  check` pasa en Node 24.19/Linux: 9 pruebas Vitest, build Vite y verificación HTTP
  del artefacto, además de 269 pruebas Node. El build Docker Node 22 pasa con CA
  temporal BuildKit. El contenedor de sondeo no pudo arrancar porque el filesystem
  llegó al 100% y Docker no pudo crear la capa escribible; el build y las pruebas
  locales sí finalizaron.
- La UI no implementa envío ni toma de control. F4.3 conecta SSE, caché,
  reconexión, ancla de scroll y resync.

## Pendientes materiales

- F4.3 integra SSE en la bandeja. F5 aborda toma de control, cancelación de IA,
  contexto y outbox; BUG-043/046/050 son puertas de esa entrega y BUG-051 antes de
  migrar archivos preexistentes.
- BUG-010 sigue parcial; BUG-035/037 quedan para F8. Windows/Termux y canales reales
  no están validados; la historia previa que conservan los proveedores es limitada.
- BUG-024 antes de operadores limitados; BUG-014 antes de Python paralelo.

## Regla de cierre para la siguiente sesión

Actualizar estado y solo checkboxes demostrados; hacer commit probado e informar
hash. Consultar [BACKLOG.md](BACKLOG.md) para el estado y aceptación de cada bug.

BUG-005/009/044/045/047/052/053/054/055 están cerrados; BUG-006/007/008/010/011/012/014/024/035/037/043/046/050/051 siguen abiertos o parciales según el backlog. BUG-016 fue probado en repositorio y alias del adapter, sin afirmar F2 completa.

Cierres históricos: commits F2C.1/F2C.2/F2D/F2E.1 están en el log local; F2B.3 `42b8321`, F2B.2 `7d99f36`, F2B.1 `4bb4ec3`, F2A `37525a1`.
