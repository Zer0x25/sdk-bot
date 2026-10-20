# Producción con Docker Compose

La producción Linux usa tres contenedores: `brain`, `gateway` y `panel`. El
código es el mismo que en desarrollo; Docker aporta aislamiento, reinicio
automático y persistencia mediante volúmenes.

## Preparar Y Arrancar

1. Crea `brain/.env` con las API keys. No lo versiones.
2. Configura `gateway/panel/.env` con OAuth. Proporciona a Compose la variable
   `SDK_PANEL_GATEWAY_SECRET` (secreto servidor >=32 bytes, diferente del de cookie
   y de claves IA) mediante el entorno del servicio o un archivo de entorno privado
   pasado con `--env-file`. Compose la exige y la inyecta a gateway/panel; definirla
   solo en el env_file del panel no la entrega al gateway. No versionar secretos.
3. Desde la raíz ejecuta:

```bash
docker compose -f deploy/docker/compose.yml build
docker compose -f deploy/docker/compose.yml up -d
docker compose -f deploy/docker/compose.yml ps
docker compose -f deploy/docker/compose.yml logs -f gateway
```

Compose sirve el panel en `:3005` interno a través de la red externa `proxy_net`
para Caddy; no publica puertos del panel, brain, bus ni status en el host.
El panel ejecuta `node panel/index.js`, sin abrir otra sesión de WhatsApp.
Contratos se empaquetan como dependencia local del gateway, sin workspace raíz
instalado en la imagen. Configuración y límites:
[frontera F1B](../../docs/FRONTERA-AUTENTICADA-V1.md).

La nueva base React/Vite se construye en una etapa Docker separada y el mismo
proceso del panel puede servirla en `/inbox`. Para verla durante esta transición,
define `PANEL_CONVERSATIONS_UI_ENABLED=true` en el entorno de Compose; por defecto
permanece apagada y la interfaz legacy sigue en `/`. Esta primera entrega es solo
el sistema visual y la navegación: todavía no conecta el historial ni habilita
filtros, envío o control humano.

## Estado Y Operación

- `sdk-bot-production-state` conserva la sesión de WhatsApp, agenda, settings,
  cola, broadcasts y memoria SQLite.
- `brain/profiles/` se monta desde el repositorio para que los perfiles SOUL
  editados por el panel no desaparezcan al recrear la imagen.
- Los volúmenes `sdk-bot-production-gateway-logs` y
  `sdk-bot-production-brain-logs` conservan los logs que consume el panel.
- Para detener sin borrar datos: `docker compose -f deploy/docker/compose.yml down`.
- Para actualizar: `docker compose -f deploy/docker/compose.yml build --pull && docker compose -f deploy/docker/compose.yml up -d`.
- `docker compose down -v` es destructivo: borra el estado persistente y exige
  volver a vincular WhatsApp.

El modo desarrollo no usa Compose: arranca brain, gateway y panel con
`bash deploy/linux/dev.sh up all` (o por componente `up brain`, `up gateway panel`).
