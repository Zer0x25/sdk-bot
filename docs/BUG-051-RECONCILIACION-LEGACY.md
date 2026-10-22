# BUG-051 — Reconciliación de mensajes sin recibo legacy

Fecha: 2026-10-22. El archivo v2 no contiene evidencia durable de si cada
mensaje antiguo llegó al handler legacy. La ausencia de una fila en
`legacy_dispatch` se informa como **entrega desconocida**; por sí sola no autoriza
el replay.

## Informe offline

Con Gateway detenido y una copia cerrada del archivo:

```bash
cd apps/gateway
npm run conversations:legacy-reconcile -- --db /ruta/privada/conversations.db > /ruta/privada/reporte.json
```

El comando requiere que no existan `-wal`, `-shm` ni `-journal`, valida integridad
y claves foráneas, acepta archivos v2 y v3–v17, abre SQLite con `immutable=1` y
comprueba que el SHA-256 del archivo no cambie durante la lectura. Rechaza el
Gateway activo mediante `SDK_GATEWAY_LOCK_PATH` (o la ruta local predeterminada).
El informe omite texto, nombres, teléfonos e identidades remotas.

`reviewTemplate` contiene los IDs de los mensajes sin recibo. Completa `reviewedBy`,
`reviewedAt` en UTC y una decisión con referencia de evidencia por cada ID:

- `confirmed_not_dispatched`: la evidencia revisada confirma que no llegó al
  handler; queda identificado para una acción posterior controlada.
- `confirmed_processed`: la evidencia confirma que el handler ya lo procesó.
- `uncertain`: no se puede determinar sin riesgo.

Guarda el objeto como JSON privado y genera el informe revisado:

```bash
npm run conversations:legacy-reconcile -- --db /ruta/privada/conversations.db \
  --reconciliation /ruta/privada/reconciliacion.json > /ruta/privada/reporte-revisado.json
```

La reconciliación debe cubrir exactamente los candidatos y queda vinculada al hash
de la base. El informe cuenta las decisiones y deja claro que no encola ni ejecuta
replays. Una base real solo se debe migrar después de revisar el informe; cualquier
replay identificado requiere una acción operativa separada y explícita.

## Verificación

`apps/gateway/tests/legacyDispatch.test.js` ejecuta ambas pasadas sobre un fixture
v2 sintético antes de abrir el worker migrador. Comprueba detección, privacidad del
informe, rechazo de sidecars, hash y referencias de evidencia, y que la versión
permanece en v2 después de informar. Luego el worker migra el fixture y conserva
cero despachos históricos pendientes. No se abrió ni modificó un archivo runtime
real.
