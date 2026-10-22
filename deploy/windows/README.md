# SDK-Bot — Deploy en Windows (PC)

En Windows no hay supervisor (como systemd o runit): los dos procesos corren
en terminales que tú mantienes abiertas. Para producción real en Windows usa
el **Programador de tareas** de Windows (arrancar al inicio, reiniciar en fallo).

> El código del bot es IDÉNTICO en Linux, Windows y Termux (instancia única,
> logs rotados, pool de concurrencia, reconnect con backoff).

## Setup (una sola vez)

```powershell
cd C:\ruta\a\SDK-Bot\brain
python -m venv venv
venv\Scripts\pip install -r ..\apps\brain\requirements.txt
cd ..\apps\gateway
npm install
cd ..\panel
npm install
# crear brain\.env con las API keys (copia de brain\.env.example si existe)
```

## Arranque

Abre **las terminales necesarias** (PowerShell o CMD):

```powershell
# Terminal 1 — Brain (primero siempre, puerto :5100)
cd C:\ruta\a\SDK-Bot
deploy\windows\startBrain.bat

# Terminal 2 — Gateway (después del brain, bus interno :5400)
deploy\windows\startGateway.bat

# Terminal 3 — Panel Web (opcional, puerto :5201)
cd C:\ruta\a\SDK-Bot\apps\panel
$env:NODE_PATH = (Resolve-Path ..\gateway\node_modules).Path
node index.js
# Acceso en el navegador: http://localhost:5201
```

- **Ctrl+C** detiene cada proceso (libera el lock de instancia única).
- Si arrancas un segundo gateway/brain mientras el primero corre, se bloqueará
  solo con un mensaje claro (protección de instancia única).
- Logs: `gateway\logs\gateway.log` y `brain\logs\brain.log` (rotación 5MB × 3).

## Producción: Programador de tareas

1. `win+R` → `taskschd.msc` → Crear tarea
2. **Disparadores:** Al iniciar sesión
3. **Acciones:** Programa = `deploy\windows\startBrain.bat` / `startGateway.bat`
   (dos tareas, una por proceso; Carpeta de inicio = `C:\ruta\a\SDK-Bot`)
4. **Configuración:** marcar "Reiniciar si falla" (cada 1 min) — esto sustituye
   al `Restart=always` de systemd

## Re-sincronizar libreta (QR nuevo)

```powershell
cd C:\ruta\a\SDK-Bot\apps\gateway
npm run reset
```
