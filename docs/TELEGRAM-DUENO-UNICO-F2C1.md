# Dueño único de polling y descubrimiento Telegram — F2C.1

Fecha: 2026-10-19. Unidad implementada y probada con transporte sustituido y HTTP
local. Cierra BUG-004/038/039/040/041/042. **F2C sigue abierta:** archivo, cuenta
verificada, cursor durable y deduplicación Telegram corresponden a F2C.2 y siguientes.
No se habilita bandeja, control humano ni otra API v1.

## Un lector y descubrimiento por observación

[ADR-003](adr/003-transporte-unico-por-canal.md) se aplica también al descubrimiento.
El único constructor de una petición getUpdates está en TelegramAdapter.
telegramService deja de exportar testAndGetChatId y no consulta updates. El gateway
inyecta setTelegramChatIdResolver en el bus; el callback llama a discoverChatId del
mismo adapter configurado. Sin callback no hay fallback de red.

- Un token sin guardar o distinto del activo debe guardarse primero. No se abre
  un lector temporal para probar borradores ni se cambia configuración al descubrir.
- El adapter conserva solo el ID del último chat observado durante cinco minutos,
  dentro del ciclo/token actual. Si no existe, espera hasta 1,5 s un mensaje del
  poll normal. Máximo 64 esperas; cada una limpia timer/listener al terminar,
  cancelar, vencer o cambiar conexión. Cancelar una prueba no cancela el poll.
- Observar no consume mensajes, no modifica offset, no programa IA ni concede
  administración. El update continúa al consumidor legacy, incluso si el panel
  usa su Chat ID. Texto/audio/marcadores pueden aportar el ID; no depende de STT.
- Reconectar/desconectar invalida caché y observadores. Una instancia reiniciada
  espera una observación nueva; no abre otra consulta para recuperar metadatos.
- La selección es un chat reciente, no prueba de identidad del operador ni lista
  íntegra de chats. El usuario debe comprobar y guardar el ID explícitamente.

Descubrimiento devuelve decimal como string, incluido signo. Acepta IDs remotos
que ya sean strings canónicos o números seguros; no inventa precisión perdida.
El parser de Bot API todavía usa JSON.parse: IDs JSON numéricos no seguros y
resolución/namespace de mensajes siguen siendo puerta F2C.2/BUG-008/009.

## Ciclo de vida y HTTP

connect/disconnect invalidan de inmediato la generación y abortan el request.
Las transiciones se serializan y esperan el cierre real del request local antes
de iniciar otro. Un connect superado no instala un loop; poll repetido sobre la
misma generación tampoco inicia una segunda lectura. Token y señal se capturan
por ciclo, no desde propiedades mutables después de una espera.

El cursor RAM se conserva al reconectar el mismo token y se reinicia al cambiarlo:
antes podía mandar el offset del bot A al bot B. Esto evita ese cruce, pero no
identifica una cuenta ni hace durable el cursor. Rotación de token/mismo bot y
reinicios necesitan el getMe/cursor por cuenta de F2C.2.

- Poll: long-poll 30 s, deadline absoluto HTTP 35 s, además de cancelación explícita.
  El helper espera cierre del request; timeout no se presenta como lote vacío.
- Respuesta limitada a 8 MiB. Se acumulan bytes y decodifica UTF-8 estricto una vez,
  después JSON: caracteres divididos entre chunks no se corrompen. JSON/UTF-8
  inválidos o exceso rechazan sin entregar esa respuesta al loop.
- 401/404 dejan standby/token_invalido; otros 4xx dejan standby/error_polling.
  No hay reintento inmediato de 4xx. Fallos de red/timeout/5xx aplican pausa de
  recuperación de 5 s cancelable entre consultas del servicio de polling.
- Audio legacy captura token/generación/señal y revalida tras esperas. No emite una
  transcripción tardía ni continúa getFile/descarga con el token del reemplazo.
  Envío/presencia/menú y salida durable completos conservan puertas BUG-010/F5.

La garantía de cierre es del HTTP local; no implica retractar procesamiento ya
iniciado en Telegram. No hay exactly-once ni ACK durable por tener un único lector.
El loop legacy todavía adelanta lastUpdateId en RAM antes del consumidor async:
**BUG-005 abierto**. La validación de update_id/identidad y el archivo deben preceder
al offset siguiente en F2C.2. No se añadió un ACK en el descubrimiento.

## Panel y prueba de notificaciones

El recorrido ahora es: guardar token con Chat ID vacío → enviar /start al bot →
Probar y obtener Chat ID → comprobar y volver a guardar. El setup parcial conserva
el token al recargar y mantiene edición/prueba habilitadas. Desconectar limpia los
campos; una configuración completa conserva su presentación protegida actual.

Con Chat ID explícito puede probarse un token borrador sin descubrir nada. El bus
valida el ID decimal, manda el mensaje de prueba una sola vez y devuelve chatId
como string. La ruta usa 2 s para sendMessage y cancela al cerrar el cliente;
descubrir + enviar queda dentro de 3,5 s una vez recibido el body. Timeout no
acredita que el proveedor no lo haya entregado; no hay reintento automático.

Sin callback/owner, token no guardado o ausencia de mensaje reciente, devuelve un
error útil en la forma legacy existente. No modifica OAuth/proxy/grants ni concede
roles nuevos; BUG-024 sigue antes de operadores limitados/F3.

## Verificación y bugs

| Entorno | Resultado |
|---|---|
| Gateway npm run check, Node 24.19.0 Linux | Lint/tipos y 233 tests pasan. |
| Gateway npm run check, mínimo Node 22.13.0 Linux | Lint/tipos y 233 tests pasan. |
| Docker Node22.23.3, dependencias de producción, --network none | 97 tests pasan. |

233 = 218 anteriores +10 ownership/bus +4 HTTP +1 setup de panel. Las 10 pruebas
Telegram existentes se mantienen, actualizadas para la prueba manual/HTTP con cierre.
Se probaron observadores concurrentes, ausencia de lecturas/ACK añadidos, entrega al
pipeline, cancelación individual, límite/TTL/reinicio, auth/backoff, token/offset,
connect superado, desconexión y STT tardío. HTTP local comprueba cierre al abortar o
vencer sin headers/body, respuesta excesiva/dañada y POST sin retry. VM del panel
prueba el setup parcial; no sustituye aceptación visual en navegador real.

Reproducción aislada del código 42b8321: dos lectores simultáneos; request anterior
vivo tras reconnect; bot B recibe offset 124 después del 123 de A; error 500 provoca
consulta inmediata; emoji fragmentado se vuelve caracteres de reemplazo. UI previa
pierde token parcial al recargar y bloquea edición/prueba al guardar sin Chat ID.

BUG-043 nuevo P1/F5: sendMessage legacy puede reintentar Markdown usando this.token
mutable y mandar el retry al bot reemplazante. Inspección; no es la lectura/poll ni
se presenta reparado por las guardas de entrada. Requiere token/cuenta inmutables y
barrera de salida en F5 antes de cerrar envío v1.

Copias independientes sin secretos/DB del workspace; dependencias instaladas
solo enlazadas. Manifiestos/contratos/brain no cambian: no nuevo npm ci ni sus suites.
Docker reutiliza sdkbot-f2b3:local, montando código afectado/tests readonly y profiles
como Compose. Prueba dependencias/layout con código actual; no es imagen nueva ni
compose up. Evidencia efímera: /tmp/sdkbot-f2c1-d6sse47d.

Fixture de 75 expectativas y logs previos conservados. No launcher global, canales,
getUpdates/getMe/envíos/STT/OAuth reales, push ni despliegue. Windows/Termux y carga
completa pendientes. Cierre: commit local `git log --grep="close F2C.1"`.
