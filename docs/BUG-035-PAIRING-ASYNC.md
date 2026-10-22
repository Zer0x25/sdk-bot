# BUG-035 — Espera asíncrona del pairing WhatsApp

Fecha: 2026-10-22. La unidad corrige el ciclo de conexión antes de solicitar
código de pairing y conserva la protección de un QR vigente.

## Cambio

- `createWhatsappPairingCallbacks` centraliza los callbacks conectados al bus.
  Al pedir un código, si el socket está cerrado, espera `whatsapp.connect()` antes
  de llamar `requestPairingCode`. Un rechazo de `loadAuth` o de `connect` sube al
  requester y el bus lo presenta como fallo de pairing.
- El refresh devuelve la promesa de `connect({ freshQr: true })`; el bus puede
  observar el fallo. Si la ventana de QR sigue abierta, el callback termina sin
  reemplazar el socket.
- El adaptador mantiene su guarda adicional para evitar crear sockets mientras
  una ventana QR está activa.

## Verificación

- `tests/whatsappPairing.test.js` usa auth/socket sustituidos. Demuestra que una
  auth suspendida no permite solicitar el código antes de crear el socket, que
  un error de auth se propaga, que refresh espera a connect y que refresh durante
  una ventana activa conserva el socket existente.
- `tests/adminPairing.test.js` y `tests/whatsappCapture.test.js` también pasan.
- Ejecución focal: 45/45 tests; Gateway lint y typecheck pasan; `git diff --check`
  limpio.
- No se usó cuenta ni transporte WhatsApp real. Esto cierra la carrera de
  promesas del código, no valida el pairing real ni el flujo F6.4.
