# Lecciones de OAuth Google en el Panel Web

Documentación de los fallos reales encontrados al integrar login con Google
OAuth 2.0 en `gateway/panel/index.js` (SDK-Bot Panel) y cómo se resolvieron.
Útil para no repetir los mismos errores en futuros despliegues.

Fecha de resolución: 2026-08-15. Estado: funciona en producción
(`bot.zer0x.org`, Docker + Cloudflare Tunnel + Caddy).

---

## Contexto del flujo

El flujo OAuth es cross-site por naturaleza:

```
bot.zer0x.org/           (tu dominio)
  -> accounts.google.com/o/oauth2/v2/auth   (Google, otro origen)
  -> bot.zer0x.org/auth/callback?code=...&state=...   (vuelta a tu dominio)
```

Cualquier cookie que el panel intente usar en este viaje está expuesta a las
políticas de privacidad de los navegadores modernos (Chrome/Edge con
"bloquear cookies de terceros" o privacidad estricta). Ese fue el núcleo de
todos los síntomas.

---

## Síntoma 1 — "Estado OAuth inválido o faltante" (HTTP 400)

**Causa:** el `state` de OAuth se guardaba en una cookie
(`sdkbot_oauth_state`, `SameSite=None; Secure`). El navegador NO la reenviaba
en el callback, así que al llegar a `/auth/callback` el panel no encontraba el
state y rechazaba con 400.

Se comprobó empíricamente que, enviando la cookie manualmente en el header, el
panel SÍ avanzaba (llegaba al intercambio de token). O sea el código estaba
bien; el navegador simplemente no entregaba la cookie.

**Fix:** el `state` ya NO usa cookie. Se guarda **server-side** en memoria
(`Map` con TTL de 10 min) cuando se genera el link a Google, y en el callback
se valida contra ese registro y se consume. El navegador no participa en el
transporte del state.

Beneficios adicionales:
- Más seguro: el state no viaja en una cookie manipulable.
- Elimina el fallo de raíz sin depender del comportamiento de cookies.

Ver también: función `saveOAuthState` / `consumeOAuthState` en
`gateway/panel/index.js`.

---

## Síntoma 2 — "Ingreso el correo pero vuelve al login"

**Causa:** el login OAuth completaba (se obtenía token + userinfo), el panel
seteaba la cookie de **sesión** `sdkbot_session` con `SameSite=None; Secure` y
redirigía a `/`. El navegador no persistía esa cookie (mismo problema de
políticas de terceros), así que en la siguiente petición la sesión no existía
y el middleware volvía a mostrar el login.

**Fix:** la cookie de **sesión** pasó de `SameSite=None` a `SameSite=Lax`
(manteniendo `Secure` cuando venimos por HTTPS).

Por qué `Lax` funciona y `None` no:
- `Lax` permite que el navegador **setee** la cookie en la respuesta del
  callback (es una navegación top-level que el usuario inició, cross-site) y la
  **relea** luego en `bot.zer0x.org -> bot.zer0x.org` (mismo sitio).
- `None` la exponía al bloqueo de "cookies de terceros" sin necesidad, porque
  la sesión solo se usa en navegaciones same-site, no cross-site.

Ver también: función `cookieFlags` en `gateway/panel/index.js`.

---

## Reglas aplicadas (no las rompas)

Actualización F1B (2026-10-19): producción o auth forzada sin ambas credenciales
falla cerrada; no vuelve al modo abierto. La identidad nueva exige userinfo con
ID estable/correo verificado. Se preservan state server-side y Lax; se repararon
separadores faltantes de Secure/Expires/Max-Age. GET /api/v1/session necesita
login nuevo si la cookie anterior no contiene sub/verified. Configuración y pruebas:
[FRONTERA-AUTENTICADA-V1](FRONTERA-AUTENTICADA-V1.md).

1. **El `state` de OAuth es server-side** (memoria del panel), no cookie.
2. **La cookie de sesión es `SameSite=Lax; Secure`** (no `None`).
3. OAuth solo se activa en producción: requiere `NODE_ENV=production` (o
   `PANEL_REQUIRE_AUTH=***) **y** credenciales
   (`PANEL_GOOGLE_CLIENT_ID` / `PANEL_GOOGLE_CLIENT_SECRET`). En desarrollo el
   panel queda abierto aunque haya credenciales.
4. El dominio público usado para el `redirect_uri` debe coincidir con
   `PANEL_PUBLIC_URL` y estar autorizado en Google Cloud Console
   (`https://<dominio>/auth/callback`).

---

## Checklist de despliegue con OAuth (Google Cloud Console)

Proyecto: `celestial-sum-488304-c0`.

1. **Credenciales → OAuth client (Aplicación web):**
   - URIs de redirección autorizados: `https://bot.zer0x.org/auth/callback`
     (uno por dominio de producción).
2. **Pantalla de consentimiento OAuth:**
   - Tipo: Externo.
   - Dominios autorizados: `bot.zer0x.org`.
   - Usuarios de prueba: agregar la cuenta que va a entrar (mientras la app
     esté en estado *Prueba*).
3. **Variables de entorno del panel (producción, en `gateway/panel/.env`,
   git-ignored):**
   - `PANEL_GOOGLE_CLIENT_ID`
   - `PANEL_GOOGLE_CLIENT_SECRET`
   - `PANEL_SESSION_SECRET` (fijo, no generado por arranque)
   - `PANEL_PUBLIC_URL=https://bot.zer0x.org`
   - `PANEL_ALLOWED_EMAILS` (opcional, csv)

---

## Nota de robustez a futuro

Si algún día se requiere cero dependencia de cookies (soporte estricto de
"bloquear todo" en Chrome, o múltiples réplicas del panel detrás de un load
balancer), el siguiente paso sería sesión 100% server-side: guardar la sesión
en memoria/Redis y pasar un token en `localStorage` + header `Authorization`
desde el frontend, en lugar de cookie. Con `SameSite=Lax` se cubre el 99% de
los casos reales, así que no es necesario hoy.

---

## Cómo reproducir el fallo (para debug)

- Con cookie manual en el header el panel avanza; sin ella da 400. Eso confirma
  que el problema es transporte de cookie, no lógica.
- En modo dev (`NODE_ENV=development`) el panel corre abierto (sin OAuth) y se
  accede por `localhost` / LAN / Tailscale, NO por el dominio público.
