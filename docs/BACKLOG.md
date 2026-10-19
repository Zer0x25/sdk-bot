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
| BUG-010 | P2 | Envíos/presencia/helpers HTTPS TG sin timeout propio. Proxy reparado en F1B, parte Telegram abierta. | panel/proxy.js ya acota recepción, respuesta y SSE; test de POST detenido confirma un intento. | F5 envío: TG sin respuesta termina acotado; sin retry ciego de envío ambiguo. Evidencia F1B en FRONTERA-AUTENTICADA-V1. |
| BUG-011 | P2 | /humano rechaza un permitido en ignored_all; /ia establece neutro y puede dejarlo sin respuesta. | handlers/commands/chatControl.js, runHumano/runIa. | F5: control independiente de permisos; comandos legacy preservan elegibilidad o explican bloqueo. |
| BUG-012 | P2 | /notify conserva payload/socket legacy aunque activeSock recibe adapter; compatibilidad no comprobada. | internalBus /notify frente a index.setSock(whatsapp) y adapter.sendMessage. | F5: prueba del payload real; reconducir al puerto de envío común sin pérdida ni duplicados. |
| BUG-013 | P1 | Cerrado F1B: /history del brain eximía API key aunque contenía contexto privado. | main.require_api_key ya exige credencial; test_main verifica denegación y lectura autorizada. | 401 sin/con clave incorrecta, 200 con correcta; health público. Ver registro de cierre. |
| BUG-014 | P2 | Tests brain usan un nombre /tmp fijo y no cierran todas las conexiones al sustituirlas; ejecuciones simultáneas pueden interferir. | test_main.setup_module/teardown_module y test_memory._nueva_db. | Antes de paralelizar suites: tmp_path único y cierre explícito; dos ejecuciones no comparten DB. |
| BUG-024 | P1 | Grants v1 no limitan al administrador legacy: una sesión con solo lectura v1 conserva rutas de administración anteriores. | panel/index.js aplica grants solo al prefijo /api/v1; proxy legacy usa identidad técnica sin capacidades de chat y conserva autorización previa. Inspección; alcance explícito, sin operador limitado habilitado. | F3, antes de incorporar operadores limitados/exponer archivo con roles: denegar rutas legacy a sujetos sin autorización administrativa expresa; probar lectura v1 sin poder enviar comandos/reset ni consultar QR/logs privados. No bloquea la sesión v1 F1B sin archivo/mutaciones. |

## Clasificación para la unidad activa

F1B cierra autenticación/sesión y BUG-013; repara la parte proxy de BUG-010.
BUG-001 a 012 y BUG-014 siguen abiertos, además de BUG-024 antes de roles limitados.
BUG-008 tiene formatos exactos, no resolución/índices runtime (F2/F5).
BUG-019 a 023 y BUG-025 bloquearon la frontera y se repararon antes del cierre.

## Cerrados

- **BUG-025 — cerrado (P1, F1B):** Docker copiaba gateway completo y .dockerignore
  no excluía panel/.env, pudiendo incluir credenciales OAuth/cookie/servicio en la
  imagen. Inspección de COPY y exclusiones; se añadió gateway/panel/.env.
  Verificación con canary ficticio de build, sin archivos de usuario. Evidencia
  de exclusión en imagen en FRONTERA-AUTENTICADA-V1. Commit F1B:
  `git log --grep=BUG-025`.

- **BUG-013 — cerrado (P1, F1B):** /history estaba exento de API key. Se retiró la
  exención y se sustituyó la prueba que la exigía por lectura de contenido real
  con credencial y 401 sin/con clave incorrecta; / y /health continúan públicos.
  Ruff y 21 tests brain pasan en copia temporal, sin llamadas IA. Commit F1B:
  `git log --grep=BUG-013`. Evidencia: [FRONTERA-AUTENTICADA-V1](FRONTERA-AUTENTICADA-V1.md).

- **BUG-019 — cerrado (P2, F1B):** decodeURIComponent de cookie y parseo de Referer
  estaban fuera de try; datos dañados lanzaban excepción. Reproducido contra panel
  de f0d2b13. Ahora cookie inválida devuelve 401 y Referer inválido deniega origen.
  La cookie se busca por nombre exacto y se comprueba expiración finita. Regresiones
  panelBoundary pasan. Commit F1B: `git log --grep=BUG-019`.

- **BUG-020 — cerrado (P1, F1B):** OAuth aceptaba userinfo sin verificar ID estable,
  HTTP OK ni correo verificado; requests sin timeout y error crudo en respuesta.
  Versión anterior acepta fixture verified_email=false con 302/cookie. Ahora exige
  ID/correo confirmado, rechaza con 401, timeout explícito de 10s por fetch y error
  saneado. Test OAuth simulado valida rechazo/éxito/state de un uso, sin Google real.
  Commit F1B: `git log --grep=BUG-020`.

- **BUG-021 — cerrado (P1, F1B):** faltaban ';' entre cookieFlags y Expires/Max-Age;
  `Secure Expires=...` y `Secure Max-Age=0` no son atributos Secure válidos.
  Reproducido contra salida anterior; ahora se delimitan correctamente los atributos
  de login/logout. Regresión comprueba cookie HttpOnly/Lax/Path/Secure/Expires y
  logout Max-Age=0. Prueba HTTP Node, sin afirmar comportamiento de navegador real.
  Commit F1B: `git log --grep=BUG-021`.

- **BUG-022 — cerrado (P1, F1B):** request-target absoluto no perdía su host al
  reemplazar el prefijo /api; new URL lo usaba como upstream fuera del gateway.
  Reproducido: HTTP absolute-form al panel alcanza segundo servidor local.
  Reparación: usar pathname/query normalizados y permitir solo origen HTTP del
  gateway configurado en el proxy. Regresión alcanza interno y cero veces externo.
  Commit F1B: `git log --grep=BUG-022`.

- **BUG-023 — cerrado (P1, F1B):** producción/auth forzada sin OAuth caía al panel
  abierto; bus trataba red/loopback como autorización, incluso en bind expuesto.
  Ahora panel requerido sin credenciales devuelve 503; v1 no concede dev como
  fallback. Bus requiere firma en producción/bind no loopback y siempre para v1.
  Sin secreto solo persiste compatibilidad legacy de desarrollo en loopback.
  Test prueba ambas puertas y acceso local anterior. Compose exige secreto común.
  Commit F1B: `git log --grep=BUG-023`.

- **BUG-015 — cerrado (P2, F0.2):** el primer prototipo del experimento podía ocultar
  la excepción original con otra durante cleanup. Detectado por lint y corregido:
  errores agregados tras cerrar workers/temporales. Lint limpio; fallo simulado
  tras escribir conserva el error, termina con código 1 y no deja estado temporal,
  probado en Node 22.13.0 y 24.19.0. Evidencia: [SQLITE-SPIKE.md](SQLITE-SPIKE.md).
  Commit: `f69ac1d` (F0.2).

- **BUG-016 — cerrado en diseño (P1, F0.3):** la clave de deduplicación propuesta
  usaba rawChatId mientras el mismo hilo puede observarse por JID/LID. Un mismo
  providerMessageId con esos dos valores produciría dos claves. Reparación: usar
  canonicalIdentityId por cuenta, con aliases verificados y conflicto bloqueante;
  rawChatId queda como procedencia. ARCHITECTURE/ADR/SPEC alineados y escenario
  DEDUP-01 revisado (clave vieja distinta, clave canónica idéntica). No es una
  reparación de DB runtime: F2 debe ejecutar el caso contra captura/repositorio.
  Commit: cierre F0.3, identificado por `git log --grep=BUG-016`.

- **BUG-017 — cerrado (P2, F1A):** openapi-typescript convertía propiedades
  opcionales con default (overrideOwner/resumePolicy/limit) en obligatorias, mientras
  AJV aceptaba omitirlas. Reproducido con compilación de `{expectedVersion:'2'}`
  como ReleaseRequest. Reparación: defaultNonNullable=false; schema es autoridad,
  sin aplicar defaults ni mutar input. Regresión TS positiva de omisión y pruebas
  runtime con objetos congelados. Se ensayó reactivar la opción: typecheck falla;
  también se comprobó que --check rechaza un artefacto alterado. Evidencia:
  [CONTRATOS-V1.md](CONTRATOS-V1.md). Commit F1A: `git log --grep=BUG-017`.

- **BUG-018 — cerrado (P2, F1A):** el validador compartido de bytes dependía del
  global Buffer de Node y fallaba al faltar ese global, lo que impediría consumirlo
  en el frontend previsto. Reproducido: OutgoingText lanza TypeError en vez de
  validar. Reparación: TextEncoder estándar. Regresión sin Buffer acepta el límite
  Unicode y rechaza exceso UTF8. Es simulación del global ausente en Node, no prueba
  de bundle/navegador; esa integración sigue en F4. Evidencia:
  [CONTRATOS-V1.md](CONTRATOS-V1.md). Commit F1A: `git log --grep=BUG-018`.

BUG-001 a BUG-012 (010 parcialmente reparado), BUG-014 y BUG-024 siguen abiertos.
Checks actuales en verde no demuestran esos escenarios pendientes.
