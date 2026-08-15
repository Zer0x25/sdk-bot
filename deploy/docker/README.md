# Producción con Docker Compose

La producción Linux usa tres contenedores: `brain`, `gateway` y `panel`. El
código es el mismo que en desarrollo; Docker aporta aislamiento, reinicio
automático y persistencia mediante volúmenes.

## Preparar Y Arrancar

1. Crea `brain/.env` con las API keys. No lo versiones.
2. Desde la raíz ejecuta:

```bash
docker compose -f deploy/docker/compose.yml build
docker compose -f deploy/docker/compose.yml up -d
docker compose -f deploy/docker/compose.yml ps
docker compose -f deploy/docker/compose.yml logs -f gateway
```

El panel queda en `http://127.0.0.1:5201`. No se publican el brain, el bus ni
el status server. Si se necesita acceso remoto, usa un reverse proxy o cambia
explícitamente el bind del puerto del panel y protégelo en la red.

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

El modo desarrollo no usa Compose: arranca brain, gateway y panel manualmente
con `bash deploy/linux/dev.sh manual ...`.
