# Frontera autenticada v1 — F1B

Fecha inicial: 2026-10-19; actualización de permisos legacy: 2026-10-22. Sesión y
autenticación implementadas; conserva procesos/transportes únicos de ADR-001/002/003.

## Identidad y permisos

GET /api/v1/session pasa por panel → bus /v1/session. Ambos validan
SessionResponse/ErrorResponse con contracts. Actor/capacidades vienen del servidor,
nunca de headers/body del navegador. El panel crea requestId UUID por solicitud;
gateway conserva ese ID tras verificar firma. Respuesta sin correo, tokens, cookie,
sub Google ni claves de servidor. Cache-Control: no-store.

OAuth conserva state server-side, TTL 10 minutos, consumo único y cookie
sdkbot_session HttpOnly; SameSite=Lax; Secure tras HTTPS, Expires y Max-Age 12h.
Comprueba estado HTTP de Google, ID estable y verified_email=true. Cada petición
OAuth tiene timeout 10s, sin retry ni excepciones crudas en respuestas.
Cookies anteriores siguen válidas para legacy; para v1 necesitan un nuevo login
que incorpore sub/verified firmados.
Producción o PANEL_REQUIRE_AUTH sin ambas credenciales OAuth falla cerrada;
no abre legacy ni concede actor dev para suplir configuración faltante (BUG-023).

Actor.id es UUID v8 derivado por SHA-256 del namespace fijo
`sdk-bot/actor/v1/google:<sub>`, independiente de correo y claves rotables.
No es registro de usuarios ni prueba de pertenencia a varias cuentas. Cambiar
namespace/issuer exige migración expresa; no regenerar propietarios.

PANEL_ACTOR_GRANTS es JSON de servidor por google:<sub>:

```json
{
  "google:123456": ["conversations:read", "messages:send", "control:write", "conversations:write", "admin:write"]
}
```

Sin entrada: solo conversations:read; [] deniega todo v1 y el acceso al panel legacy.
Grants inválidos dan 503. control:override es capacidad expresa, no viene por
defecto. Las rutas v1 tienen puertas de capacidad y alcance independientes.
La UI React `/inbox/*` requiere sesión; las rutas `/api/*` legacy y la UI legacy
requieren además `admin:write` explícito. El proxy legacy conserva su identidad
técnica; el panel valida el grant antes de firmar y reenviar la solicitud. Esta
puerta cierra BUG-024; no añade roles parciales a los endpoints legacy.
Takeover, liberación y envío v1 están implementados en F5–F6; la capacidad
correspondiente sigue exigida por cada ruta. Ver [F6.4](F6.4-SMOKE-CANAL.md).

Dev v1 exige NODE_ENV=development, OAuth desactivado y PANEL_DEV_ACTOR=true.
Identidad estable dev:local y grants de esa clave. No hay fallback por IP,
X-Status-Token, ausencia de credenciales ni producción. Legacy dev sigue abierto.
No publicar ese modo local en redes no confiables. Para probar la bandeja v1 en
loopback, el launcher admite fijar los tres hosts:

```bash
BRAIN_HOST=127.0.0.1 ADMIN_WEB_HOST=127.0.0.1 STATUS_HOST=127.0.0.1 PANEL_DEV_ACTOR=true bash deploy/linux/dev.sh up all
```

Con ese actor, no usar `0.0.0.0` ni un túnel/reverse proxy sin autenticación.

## Firma y bus

SDK_PANEL_GATEWAY_SECRET >=32 bytes UTF8 debe llegar a ambos procesos, distinto
de PANEL_SESSION_SECRET y claves IA. Sin él v1 falla cerrada con 503; sin sesión
válida, panel devuelve 401. No se genera secreto efímero de servicio. Compose exige
variable común: definirla solo en panel/.env no configura gateway.

HMAC-SHA256, dominio sdkbot-panel-v1, payload base64url con versión,
issuer=panel, audience=gateway, Actor, requestId, issuedAt/expiresAt, método,
ruta con query exacta y SHA-256 de bytes de cuerpo. TTL máximo 30s; adelanto de
reloj máximo 5s. Firma comparada en tiempo constante. Sin logs de payload/firma,
cuerpos ni secretos. Requiere relojes sincronizados. HTTP del bus es privado:
la firma autentica integridad, no cifra tráfico.

Cache por instancia rechaza requestId repetido: 10000 nonces vigentes, limpieza por
expiración; al llenarse da 503 sin expulsar entradas válidas. Cache volátil: reiniciar
permite replay dentro de los 30s de vida de un token. No es anti-replay durable ni
idempotencia de efectos; F5 requiere ledger antes de activar mutaciones de chat.

Con secreto también se firma/verifica cada ruta legacy. Panel usa identidad técnica
legacy sin capacidades v1, ligada a método/ruta/cuerpo: no permite invocar v1.
Los formatos legacy se conservan; su parser reutiliza bytes verificados en lugar de
leer dos veces el stream. Sin secreto solo queda legacy en desarrollo y loopback;
producción/bind expuesto falla cerrado (BUG-023).
Bus/status nunca deben publicarse.

## Límites HTTP

- Lista positiva de headers: Accept, Content-Type, Last-Event-ID, Idempotency-Key.
  Content-Length recalculado. No propaga Cookie/Authorization/X-Status-Token,
  actor/requestId/contexto/firma del navegador.
- Destino fijo GATEWAY_INTERNAL_URL HTTP: una URL absoluta de cliente no puede
  convertirlo en proxy hacia otro host. URL inválida se rechaza.
- Recepción máximo 1 MiB/5s; límite de texto de dominio sigue en contracts/F5.
  Respuesta HTTP: deadline absoluto 5s, sin extenderse por goteo de bytes.
  JSON v1: máximo 64 KiB y validación de DTO esperado.
- Sin retries. Desconectar HTTP no demuestra cancelación de una mutación ya
  aceptada; F5 debe reconciliar por idempotencia.
- SSE solo en GET QR/logs/events y Content-Type apropiado: headers antes de 5s,
  idle 45s contando heartbeat, máximo 12h o caducidad de sesión. Cliente reconecta
  o renueva. Cierre cliente destruye upstream; timeout tras headers cierra stream
  sin insertar JSON. Events sigue sin servicio de eventos implementado.
- Errores propios de frontera: ErrorResponse saneado 401/403/422/503. Legacy
  conserva respuestas del bus; error propio del proxy es 503 sin excepción de red.
  X-Status-Token no reemplaza sesión ni evita origen de escritura v1.

Revocar capacidad no cierra inmediatamente un stream ya abierto: queda acotado por
sesión. Antes de SSE de conversaciones F3 debe resolver revocación/alcance activo y
reautorizar al reconectar. QR/logs actuales conservan autorización legacy.

## Snapshot bootstrap y puerta de persistencia

**Actualización F2A:** gateway ya usa snapshot durable de SQLite y devuelve 503 si
el archivo falla. Ver [archivo F2A](ARCHIVO-CONVERSACIONES-F2A.md). La descripción
siguiente conserva el comportamiento histórico de F1B; policyVersion sigue volátil.

SessionResponse devuelve política efectiva y snapshot bootstrap: dataEpoch UUID por
instancia de bus, seq="0" porque aún no hay archivo/eventos v1. policyVersion decimal
aumenta en cada cambio efectivo de pausa/modo/perfil global, incluso ida/vuelta
entre lecturas; reasignar el mismo valor no aumenta versión. Valores siguen siendo
legacy: no se crea otra autoridad de permisos/control.

Snapshot/versiones son volátiles, describen ese proceso y no prometen replay ni
sirven como cursor de historial disponible. **F2 debe sustituir época/watermark por
snapshot transaccional SQLite antes de consultas/SSE. F5 hará durable policyVersion
junto con migración de autoridad.** Futuras rutas también deben validar cuerpos,
idempotencia, control/owner y ámbito de recursos. Capacidad sola no autoriza todo chat.

## Instalación y verificación

Gateway sigue independiente con manifest/lock propios. file:../packages/contracts
y gateway/.npmrc install-links=true crean copia empaquetada con AJV/formatos,
sin symlink a workspace. Docker copia contracts antes de npm ci --omit=dev;
no necesita instalar raíz para ejecutar gateway/panel.

Tras cambiar contracts, generar/verificar en raíz y repetir npm ci en gateway.
Launchers Linux/Termux/Windows detectan ausencia/cambio de index/schema.
Updater Termux detecta también cambios del paquete/lock/tipos de contracts y
repite npm ci antes de reiniciar runit, que arranca node directamente.
CI verifica gateway en Node 22.22.2/24, necesario para la versión de jsdom
usada por las pruebas del panel. El runtime de producción sigue compatible con
Node 22.13.0. Windows/Termux tienen scripts actualizados, sin afirmar ejecución
en esas plataformas.

Verificación en copia temporal de versionados actuales más nuevos explícitos,
sin .env, sesiones ni DB originales. npm ci limpio. Brain usa ejecutable de venv
existente desde copia y suite secuencial por BUG-014. Evidencia efímera:
`/tmp/sdkbot-f1b-1xfiq0qs`, no requerida para continuar otra sesión.

panelBoundary prueba contexto/metadata/hash/firma, vencimiento, replay/cache,
permisos, OAuth/dev, panel+bus reales, GET/POST legacy, headers falsos, cookies
dañadas/vencidas, OAuth simulado, atributos de cookie, política, timeout sin retry,
DTO inválido, URL absoluta, uploads y cierre de SSE por cliente/idle/sesión.
OAuth usa respuestas falsas, sin llamar Google.

Contra panel/index.js de f0d2b13, con built-ins/fakes, se reprodujeron:
cookie/referer dañados lanzan; Google no verificado recibe cookie; faltan separadores
Secure/Expires y Secure/Max-Age; URL absoluta lleva proxy a otro servidor.
Regresiones reparadas: BUG-019/020/021/022/023. BUG-013 cierra con lectura autenticada,
rechazo sin/con clave incorrecta y health público. BUG-010 cierra solo proxy;
Telegram sigue hasta F5. Resultados finales: [SESSION-STATE](SESSION-STATE.md).
Sin llamadas IA, conexión real de canales, migración, push ni despliegue.

## Imagen de producción

Build de instalación verificado en Node 22.23.3 con npm ci --omit=dev. Se usó un
Dockerfile temporal que conserva instrucciones reales y solo monta CA pública del
proxy durante npm ci, con TLS verificado; no modifica la imagen con ese certificado.
Sin node_modules raíz ni symlink de contracts. La imagen pasa 15 tests de frontera
con --network none, ejecutando HTTP loopback y OAuth ficticio, no el gateway live.

BUG-025: .dockerignore omitía gateway/panel/.env. Canary falso demuestra que las
exclusiones anteriores permitían COPY del archivo y las actuales lo rechazan;
la imagen de producción también se verificó sin ese archivo aunque estuviera en
el contexto temporal. Nunca se usó un .env real para esa prueba.
Compose config exige secreto común y conserva entrada panel/puertos privados;
se validó con env_files vacíos temporales, sin arrancar servicios de producción.
