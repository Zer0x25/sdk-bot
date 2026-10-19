# Línea base de conversaciones — F0.1

Fecha: 2026-10-19. Código revisado: commit `a9196ce`, rama `work`, más los cambios
documentales de la sesión de arquitectura. No había diferencias de runtime frente
a ese commit. El inventario distingue inspección estática de comportamiento
ejecutado; no implica que las funciones de destino ya estén implementadas.

## 1. Resultado de la verificación

| Verificación | Entorno y comando | Resultado |
|---|---|---|
| Gateway, runtime del entorno | Node 24.19.0, npm 11.9.0; `cd gateway && npm run check` | Lint, typecheck y 143 ejecuciones de node:test pasan; 0 fallos, 0 omitidas. Tests: 21,27 s. |
| Gateway, major de CI | Node 22.23.3; `cd gateway && npm exec --yes --package=node@22 -- sh -c 'node --version && npm run check'` | Lint, typecheck y 143 ejecuciones pasan; 0 fallos, 0 omitidas. Tests: 21,03 s. |
| Brain, análisis | Python 3.12.14, ruff 0.17.1; `cd brain && venv/bin/ruff check .` | Sin hallazgos. |
| Brain, suite | `cd brain && venv/bin/python -m pytest tests/ -q` | 21 pruebas pasan en 1,51 s. |
| Launcher Linux, smoke aislado | Node 24.19.0; `bash deploy/linux/tests/dev-smoke.sh`, con connect de WA sustituido por standby y TG sin token | Arranque, health de gateway/panel y apagado pasan; puertos liberados al terminar. |

El total de Node coincide con 143 casos test() declarados en 18 archivos de prueba;
los dos helpers no se contaron como casos. No equivale a cobertura de extremo a
extremo ni a 143 escenarios de chat.
No se detectaron fallos previos en los checks ejecutados. Se reutilizaron las
dependencias instaladas: ESLint 10.8.1, TypeScript 7.0.2 y Baileys 7.0.0-rc14.
No se verificó una reinstalación limpia mediante npm ci en esta unidad.

## 2. Aislamiento y límites de esta evidencia

Se creó una copia de los archivos versionados con su contenido actual en un
directorio temporal. node_modules y venv se enlazaron a las dependencias instaladas.
No se copiaron .env, sesiones, DB, logs, locks ni otros archivos runtime ignorados.
El brain escribe logs en su propio árbol; ejecutar en copia temporal evita tocar
brain/logs del workspace. Algunos tests crean/eliminan estado o usan rutas /tmp
fijas: no son una suite paralela segura entre varios procesos pytest independientes.

En el smoke se sustituyó únicamente WhatsappAdapter.connect por standby mediante
un preload externo a la copia; el launcher y los servidores ejecutados fueron los
originales. Settings temporal sin token mantiene Telegram en standby. No hubo
socket/pairing WA, polling TG, generación IA ni transcripción reales. Este smoke
no valida transporte, sync, OAuth con Google ni entrega de mensajes.

Antes de invocar el launcher se comprobó que 5100/5201/5300/5400 estaban libres y
que no existían sus PID/logs globales. Es necesario: dev.sh down puede matar
procesos por puerto y eliminar locks. No ejecutarlo junto a servicios del usuario.
Al terminar se comprobó liberación de puertos y ausencia de DB, sesiones y locks
nuevos en el workspace original.

Evidencia local efímera de esta ejecución: `/tmp/sdkbot-baseline-f01-ibkgaxnj/`:
gateway-check.log, gateway-node22-check.log, brain-ruff.log, brain-pytest.log,
smoke-check.log, offline-wa.cjs y repo/. Esa ruta no es un artefacto durable ni
un requisito para futuras sesiones; los resultados resumidos quedan en este archivo.

## 3. Flujo actual de entrada y estado

| Tramo | Referencia | Comportamiento observado y límite |
|---|---|---|
| Bootstrap | [gateway/index.js:128](../gateway/index.js#L128) | Crea ambos adapters, registra listeners y conecta. Importar index tiene efectos: llama ensureSingleInstance/startGateway y abre servidores. |
| WhatsApp live | [whatsappAdapter.js:235](../gateway/adapters/whatsappAdapter.js#L235) | Procesa solo m.messages[0]; descarta IDs propios conocidos; emite StandardMessage cuando hay texto o STT exitoso. No archiva el lote íntegro. |
| Mensaje normalizado | [StandardMessage.js:27](../gateway/core/StandardMessage.js#L27) | Canal, remoteId, rawId, texto, audio, metadata y raw. No incluye como campos canónicos ID de proveedor, fecha, tipo completo, autoría ni entrega. |
| Telegram live | [telegramAdapter.js:58](../gateway/adapters/telegramAdapter.js#L58) | Un loop por generación; lastUpdateId comienza en 0 y se adelanta antes de terminar trabajo. EventEmitter no espera los listeners async del gateway; no hay ack durable. |
| Historial inicial WA | [gateway/index.js:172](../gateway/index.js#L172), [messageSyncQueue.js:19](../gateway/services/messageSyncQueue.js#L19) | history_sync pasa por lotes de 100 y siembra chatStore. No persiste el hilo ni alimenta una API de conversaciones. |
| Store de mensajes | [chatStore.js:16](../gateway/store/chatStore.js#L16), [chatStore.js:82](../gateway/store/chatStore.js#L82) | RAM, tope 200/chat, TTL 30 min; upsertMessage se exporta pero no tiene llamadas en el repo. Solo se encontró seedMessages conectado. |
| Consumidor común | [messageHandler.js:204](../gateway/handlers/messageHandler.js#L204) | Retorna si no hay texto; busca adapter importando index dentro del handler. Actualiza metadatos/contacto y decide comando, IA, handoff o ignore. |
| Decisión de respuesta | [pipeline.js:158](../gateway/services/pipeline.js#L158) | fromMe en chat de cliente se ignora; pausa global/ignorado/modo estricto filtran; handoff activo no responde. Ningún paso guarda un archivo de mensajes. |
| Contactos | [contactsRepository.js:253](../gateway/services/contactsRepository.js#L253) | Índices phone/lid/dígitos ya existen; usa remoteId como clave, pero puede fusionar registros por identidad sin namespace de cuenta/canal en los índices. |
| Identidades de comandos | [contactsRepository.js:118](../gateway/services/contactsRepository.js#L118), [stateService.js:28](../gateway/services/stateService.js#L28) | Elimina caracteres no numéricos y tiene fallback por includes. No conserva signo de TG ni garantiza resolución exacta entre canales. |
| Persistencia JSON | [db.js:119](../gateway/services/db.js#L119) | Caché mutable y guardado diferido; contactos usan tmp+rename, settings writeFile directo. Responder éxito no demuestra fsync/commit durable del control. |

La precarga está habilitada por .env.tuning, fuente baileys y 25 mensajes. El
handler la guarda como señal en RAM; processAIChat no inyecta ese hilo al brain.
Por tanto no aporta, por sí sola, el contexto de mensajes humanos al responder.

## 4. Control, generación y salidas

| Tramo | Referencia | Comportamiento observado y límite |
|---|---|---|
| Handoff por cliente | [messageHandler.js:281](../gateway/handlers/messageHandler.js#L281) | Cambia estado, notifica admin y cliente. No cancela timers/jobs ni coordina envíos ya iniciados. |
| Handoff manual | [chatControl.js:19](../gateway/handlers/commands/chatControl.js#L19) | /humano rechaza todo ignored_all, incluso un contacto permitido. /ia establece neutro; con modo estricto eso no garantiza reactivar respuestas. |
| Caducidad | [contactsRepository.js:37](../gateway/services/contactsRepository.js#L37) | Handoff TTL 24 h por defecto; fecha ausente/inválida se trata activa. Permisos y control comparten estado. |
| Debounce y pool | [messageHandler.js:389](../gateway/handlers/messageHandler.js#L389), [aiQueue.js:19](../gateway/services/aiQueue.js#L19) | Serialización RAM por chat y concurrencia global. Al vencer timer se revisa typing, sin nueva evaluación de control/permisos; el pool no tiene cancelación por job. |
| Petición IA | [brainService.js:115](../gateway/services/brainService.js#L115) | POST /chat con timeout 90 s y un retry transitorio. No generationId idempotente. El retry puede duplicar trabajo/contexto si la respuesta se perdió. |
| Entrega IA | [brainService.js:190](../gateway/services/brainService.js#L190) | Lectura, typing, globos y pausas; no valida control/pause antes de cada globo y no guarda intención/resultado en outbox. |
| Memoria brain | [brain/main.py:168](../brain/main.py#L168), [memory.py:114](../brain/memory.py#L114) | Guarda intercambio al generar, antes de saber si llegó al canal. SQLite/WAL de contexto; ventana configurada 7 días, sin tope de cantidad y ~5000 tokens de lectura. |
| Cola de caída IA | [messageQueue.js:21](../gateway/services/messageQueue.js#L21), [messageHandler.js:477](../gateway/handlers/messageHandler.js#L477) | JSONL atómico, máximo 50, TTL 24 h al cargar, hasta 5 intentos en flush. No es archivo ni outbox. Flush invoca IA sin reevaluar handoff/pausa/permisos. |
| Anti-bucle | [config.js:57](../gateway/config.js#L57) | Set global de IDs con TTL 60 s; sin cuenta/chat/canal. Un message_id de Telegram puede colisionar con otro chat. |
| Comandos | [commandHandler.js:71](../gateway/handlers/commandHandler.js#L71), [adminCommandRunner.js:46](../gateway/services/adminCommandRunner.js#L46) | Superficies convergen en dispatcher; panel usa runner/sock virtual, WA/TG entran directamente al dispatcher por pipeline. No todos llaman al runner. |
| Otras salidas | [internalBus.js:927](../gateway/services/internalBus.js#L927), [broadcastService.js:309](../gateway/services/broadcastService.js#L309), [telegramService.js:25](../gateway/services/telegramService.js#L25) | /notify, campañas y avisos tienen caminos propios. /notify llama activeSock.sendMessage con payload legacy; necesita prueba del contrato real cuando activeSock sea un adapter. |

## 5. Transporte y generación de conexiones

- WA captura sock de la conexión en [whatsappAdapter.js:137](../gateway/adapters/whatsappAdapter.js#L137)
  y compara identidad en connection.update. messages.upsert, contactos, historial
  y presencia se registran sin la misma guarda. La protección declarada por ADR-003
  está incompleta para esos callbacks; la carrera no se reprodujo contra WhatsApp.
- Telegram incrementa pollGeneration al conectar y verifica después de esperar
  respuesta, [telegramAdapter.js:28](../gateway/adapters/telegramAdapter.js#L28).
  Los tests cubren standby/loop/admin, no ack durable ni crash del consumidor.
- Sigue existiendo otro getUpdates en
  [telegramService.js:79](../gateway/services/telegramService.js#L79), usado desde
  [internalBus.js:905](../gateway/services/internalBus.js#L905) para descubrir Chat ID.
  No hay exclusión visible cuando el token ya está en polling. Puede competir con
  el adapter; el test llamado «único dueño» comprueba que cuatro exports de polling
  legacy no existan, sin recorrer esa dependencia indirecta. No se ejecutaron dos
  consumidores reales para probarlo.
- getUpdates del adapter tiene timeout 35 s; sendMessage/sendPresence y los helpers
  Telegram no declaran timeout en sus requests HTTPS. El proxy HTTP del panel
  tampoco tiene timeout propio. Deben abordarse al definir el puerto de envío y
  la frontera API; el éxito de STT/brain timeout tests no cubre esos caminos.

## 6. UI, API y operación existentes

Panel en [gateway/panel/index.js:188](../gateway/panel/index.js#L188): HTTP propio,
sesión OAuth opcional, estáticos y proxy /api/* sin actor autenticado propagado
al caso de uso. Navegación por hash con seis páginas; refresh de status cada 10 s
en [app.js:86](../gateway/panel/public/js/app.js#L86). No existe bandeja, timeline,
compositor humano, API de mensajes ni cursor de lectura de operador.

Bus [internalBus.js:766](../gateway/services/internalBus.js#L766): status, logs/QR
SSE, pairing, brain/start, Telegram config/test, command, notify, reset/restart,
contactos y perfiles. Los SSE actuales son de QR/logs, sin log durable de cambios
de conversaciones ni replay de mensajes. Contactos usa page/limit, no cursor.

La cookie OAuth usa Lax y state server-side. isWriteAuthorized tiene pruebas de
origen; no equivalen a un recorrido OAuth ni a identidad firmada panel -> gateway.
GET /telegram/settings devuelve el token al panel actual; no debe trasladarse a
DTOs de conversaciones. /history del brain está exento de API key de forma expresa
y comprobada por la suite actual: la futura API de historial debe autorizar lectura.

Inventario runtime: [factoryReset.js:74](../gateway/services/factoryReset.js#L74).
Incluir nueva DB/WAL/SHM, cursores y adjuntos antes de escribirlos. El runtime del
gateway fija .gateway.lock junto a index; SDK_GATEWAY_LOCK_PATH en reset es una
separación intencional para tests según su comentario, no configuración efectiva
del lock del proceso. Al mover carpetas debe revisarse esta diferencia y los
volúmenes [compose.yml:76](../deploy/docker/compose.yml#L76).

## 7. Matriz de pruebas disponibles y brechas

| Área | Evidencia existente | Brecha para la plataforma nueva |
|---|---|---|
| Decisiones IA | [pipeline.test.js:24](../gateway/tests/pipeline.test.js#L24): self/admin, pausa, estados, TTL, estricto, keywords y reconexión pura | No prueba cancelación de un job admitido ni guardas de despacho. |
| Identidad/DB | contactsRepository.test.js, db.test.js, commandHelpers.test.js | Sin prueba de colisión cuenta/canal, TG con signo o migración al modelo separado. |
| Sync | contactSyncQueue.test.js prueba orden/chunks/errores | No hay suite de messageSyncQueue/chatStore ni integración de lote WA/historial live. |
| Telegram | telegram.test.js prueba config, clasificación y emisión admin con HTTPS falso | Sin crash/ack, entrega incierta, colisiones por chat ni prueba de exclusión del descubridor. |
| Memoria | test_memory.py: aislamiento bot, recortes, sweep y limpieza | No verifica humano -> contexto ni generación cancelada/entrega parcial. |
| API brain | test_main.py: health, profiles, history/reset y API key | No llama /chat; no cubre cascada de proveedores, cancelación o idempotencia. |
| IA/typing | humanSim.test.js prueba funciones puras | No hay suite directa de processAIChat, messageHandler ni aiQueue. |
| Cola | messageQueue.test.js: persistencia/reload, límites, flush y fallo | El handler de flush del test es un stub; no comprueba políticas reales al reanudar IA. |
| Campañas | broadcastService.test.js: cursor/reload, límite, exclusión de ticks | No demuestra un servicio de envío común ni política de interacción con takeover. |
| Admin/API | internalBus.test.js, adminPairing.test.js, adminProfiles.test.js | No hay contratos v1, actor firmado o control versionado. Pairing usa mocks. |
| Eventos | adminLogs.test.js y adminPairing.test.js prueban SSE existentes | Sin snapshot/watermark, replay durable o recuperación de timeline. |
| Seguridad/UI | panelSecurity.test.js comprueba función de origen | Sin navegación/browser, accesibilidad, login completo ni compositor/E2E. |
| Audio | stt.test.js: cliente HTTP falso, 4xx/5xx/timeout/texto vacío | No ejecuta faster-whisper ni garantiza persistir audio antes de STT. |
| Reset | factoryReset.test.js, resetCleanFlow.test.js | Sin inventario futuro ni ensayo de migración/restauración de conversaciones. |

Estas brechas se identificaron por inventario de archivos/casos, no mediante un
informe instrumentado de cobertura. Una prueba con nombre similar no demuestra
la propiedad completa del flujo. No se añadieron tests que congelen bugs como
comportamiento deseado ni se modificó el runtime en esta unidad.

## 8. Orden recomendado a partir de esta evidencia

1. **F0.2:** spike SQLite con worker, transacciones, constraints y backup en Node 22.
   Verificar versión mínima real por separado y documentar Windows/Termux pendientes.
2. **F0.3:** congelar contratos de identidad, acceso/control, retención y corte de
   datos. Conservar semántica legacy explícita hasta migrar.
3. **Fases 1–2:** contratos, repositorios e ingesta antes de diseñar una bandeja sobre
   datos incompletos. Inyectar dependencias para probar sin importar el bootstrap.
   Cubrir lote completo, sockets obsoletos, aliases exactos y ack durable; eliminar
   la competencia indirecta de getUpdates antes de conectar ese flujo a historial.
4. **Fase 5:** control/outbox/contexto como unidad coherente. No habilitar el botón
   de envío humano con el handoff actual porque no protege la salida en curso.

No cambió el alcance del producto ni se autorizó una migración de producción por
ejecutar esta baseline. Las puertas de aceptación siguen en [ROADMAP.md](ROADMAP.md).

## 9. Cómo reproducir el aislamiento

Prerequisitos: dependencias instaladas según AGENTS, Python 3.12 y Node compatible.
Desde la raíz, crear una copia sin runtime y enlazar solo dependencias:

```python
from pathlib import Path
import shutil, subprocess, tempfile

root = Path.cwd()
base = Path(tempfile.mkdtemp(prefix="sdkbot-baseline-"))
checkout = base / "repo"
for name in subprocess.check_output(["git", "ls-files", "-z"], text=True).split("\0"):
    if not name:
        continue
    src = root / name
    if src.is_file():
        dst = checkout / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
for name in ("gateway/node_modules", "brain/venv"):
    (checkout / name).symlink_to(root / name, target_is_directory=True)
print(checkout)
```

Ejecutar los comandos de la tabla inicial dentro de esa copia. Los archivos nuevos
no versionados de runtime que una implementación futura necesite deberán añadirse
al snapshot por lista explícita, nunca copiando toda la carpeta con secretos.

Para repetir el smoke sin canales, crear fuera del checkout este preload CJS,
establecer SDK_BASELINE_REPO_PATH a la copia y cargarlo mediante NODE_OPTIONS
(`--require=/ruta/al/preload.cjs`). Usar settings temporal sin token, SDK_BOT_TEST=1
y las rutas SDK_CONTACTS_DB_PATH, SDK_SETTINGS_DB_PATH, SDK_AUTH_DIR,
SDK_MESSAGE_QUEUE_PATH y SDK_BROADCAST_DB_PATH en un directorio temporal.

```javascript
const Module = require('node:module');
const path = require('node:path');
const target = path.join(process.env.SDK_BASELINE_REPO_PATH,
  'gateway/adapters/whatsappAdapter.js');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  const value = load.apply(this, arguments);
  if (request.includes('whatsappAdapter') &&
      Module._resolveFilename(request, parent) === target) {
    value.prototype.connect = async function() {
      this.setStatus('standby', 'baseline_offline');
    };
  }
  return value;
};
```

Este hook es solo un fixture de verificación local, no forma parte del producto
ni debe usarse en despliegues. Comprobar PID/puertos antes y después; si existen
servicios ajenos, omitir ese smoke y registrar el motivo sin detenerlos.
