# Backlog de bugs — SDK-Bot

Actualización: 2026-10-19. Fuente inicial:
[baseline F0.1](BASELINE-CONVERSACIONES.md). Esta lista registra defectos concretos;
las funciones nuevas y sus dependencias siguen en [ROADMAP.md](ROADMAP.md).

## Política de trabajo acordada

- Registrar cada bug al detectarlo: ID, evidencia, impacto, prioridad, estado,
  fase de reparación y prueba de aceptación. Inspección no equivale a reproducción.
- Si impide cumplir la especificación o pasar la aceptación de la unidad actual,
  reproducirlo con una prueba enfocada, repararlo y verificar antes de cerrar.
- Si no bloquea la unidad actual, dejarlo abierto y priorizado aquí. La fase
  indicada no puede cerrarse sin resolverlo o acordar explícitamente otro alcance.
- Cerrar con evidencia de la prueba y commit de reparación. No eliminar el registro.
- Hacer un commit local por fase o unidad entregable probada, después de revisar
  el diff y actualizar roadmap/estado/backlog. No incluir secretos ni cambios ajenos.
  La publicación y el despliegue son acciones separadas.

Prioridad: P1 = pérdida de mensajes/control/aislamiento; P2 = resiliencia o flujo
incorrecto de alcance acotado. Estado inicial: **abierto, inspección de código**,
salvo indicación contraria. La evidencia detallada y líneas están en la baseline.

## Registro

| ID | Prioridad | Bug e impacto | Evidencia | Fase límite y aceptación |
|---|---|---|---|---|
| BUG-001 | P1 | WhatsApp procesa solo el primer mensaje de un lote live; omite los demás. | whatsappAdapter.js, messages.upsert usa m.messages[0]. | F2: lote de varios mensajes se captura íntegro y una sola vez. |
| BUG-002 | P1 | La precarga RAM no recibe mensajes live; el hilo usado como señal queda desactualizado. | chatStore.upsertMessage no tiene llamadas; solo seedMessages conectado en index. | F2: entrada live aparece en archivo/consulta tras sync inicial y después de reinicio. |
| BUG-003 | P1 | Callbacks WA de mensajes/contactos/historial/presencia no descartan sockets reemplazados. | Solo connection.update compara this.sock con sock capturado. | F2: emitir desde un socket viejo no cambia archivo, presencia ni contactos. |
| BUG-004 | P1 | Descubrir Chat ID puede consultar getUpdates mientras el adapter ya hace polling con ese token. | telegramService.testAndGetChatId llamado desde /telegram/test; no hay exclusión visible. | F2: prueba de descubrimiento con polling activo sin segundo consumidor. |
| BUG-005 | P1 | Cursor TG adelanta antes de persistir/procesar y vive solo en RAM. | poll asigna lastUpdateId antes de emitir; EventEmitter no espera consumidor async. | F2: crash antes/después de persistir no pierde ni duplica el mensaje al recuperar. |
| BUG-006 | P1 | Handoff/pausa no cancelan jobs admitidos ni protegen cada globo; cola puede responder después del cambio. | Debounce, processAIChat y flush sin validación final de control. | F5: takeover durante debounce/pool/generación/typing/globos bloquea nuevos despachos y sobrevive reinicio. |
| BUG-007 | P1 | Respuesta generada se guarda en memoria antes de entregarse; cancelación/fallo/retry puede producir contexto fantasma. | brain /chat llama append_exchange antes de devolver; gateway puede reintentar POST. | F5: generación cancelada o entrega parcial solo confirma contexto de lo realmente enviado. |
| BUG-008 | P1 | Resolución por dígitos/substrings e índices sin cuenta/canal puede mezclar identidades; TG pierde signo. | stateService, findKeyByDigits y phone/lid indexes. | F1 contratos exactos; F2/F5: IDs iguales en canales distintos y TG negativo no colisionan ni cambian otro contacto. |
| BUG-009 | P1 | Anti-bucle usa message_id global aunque TG lo limita a chat; puede descartar entrada de otro chat. | config.botSentMessageIds y telegramAdapter.isBotSentMessage. | F2: mismo ID de proveedor en chats/cuentas diferentes no se ignora por error. |
| BUG-010 | P2 | Envíos/presencia/helpers HTTPS TG y proxy HTTP del panel carecen de timeout propio. | Requests en telegramAdapter, telegramService y panel.proxy. | F1 frontera API/F5 envío: transporte que no responde termina con error acotado; sin retry ciego de envío ambiguo. |
| BUG-011 | P2 | /humano rechaza un permitido en ignored_all; /ia establece neutro y puede dejarlo sin respuesta. | handlers/commands/chatControl.js, runHumano/runIa. | F5: control independiente de permisos; comandos legacy preservan elegibilidad o explican bloqueo. |
| BUG-012 | P2 | /notify conserva payload/socket legacy aunque activeSock recibe adapter; compatibilidad no comprobada. | internalBus /notify frente a index.setSock(whatsapp) y adapter.sendMessage. | F5: prueba del payload real; reconducir al puerto de envío común sin pérdida ni duplicados. |
| BUG-013 | P1 | /history del brain no exige API key aunque contiene contexto privado. | main.require_api_key exime /history; test_main afirma esa exención. | F1 antes de exponer historial: lectura autorizada, tests sin/con credencial; conservar health público. |
| BUG-014 | P2 | Tests brain usan un nombre /tmp fijo y no cierran todas las conexiones al sustituirlas; ejecuciones simultáneas pueden interferir. | test_main.setup_module/teardown_module y test_memory._nueva_db. | Antes de paralelizar suites: tmp_path único y cierre explícito; dos ejecuciones no comparten DB. |

## Clasificación para la unidad activa

F0.2 ejecuta exclusivamente un experimento SQLite con fixtures locales. Ninguno
de BUG-001 a BUG-014 bloquea ese experimento: no usa adapters, handlers, HTTP del
producto, memoria del brain ni sus tests en paralelo. Siguen abiertos con las
puertas anteriores. Un fallo del experimento que impida worker/WAL/transacciones/
backup sí debe repararse antes de su commit; no se difiere como si hubiera pasado.

## Cerrados

Ningún bug de esta lista fue reparado todavía. No confundir checks actuales en
verde con cobertura de los escenarios pendientes.
