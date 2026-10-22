# SDK-Bot — Deploy en Termux (Android)

Este README describe **cómo correr SDK-Bot en un teléfono Android con Termux**.
Todo vive en la rama `main` (única fuente de verdad): este directorio
(`deploy/termux/`) contiene el deploy de Android; `deploy/linux/` el de
servidores con systemd; `deploy/windows/` el de PC Windows.

> El código del bot es IDÉNTICO en las 3 plataformas (incluye instancia única,
> logs rotados, pool de concurrencia y reconnect con backoff). Solo cambia el
> "supervisor" que lo mantiene vivo: **runit** en Termux, **systemd** en Linux,
> scripts manuales en Windows.

## Arranque rápido (una sola vez)

```bash
pkg install -y git
git clone https://github.com/Zer0x25/SDK-Bot.git
cd SDK-Bot && bash deploy/termux/setup-termux.sh
# luego edita brain/.env con tus API keys
```

O directo sin clonar:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Zer0x25/SDK-Bot/main/deploy/termux/setup-termux.sh)
```

El script es idempotente: instala dependencias, registra los servicios en
runit, crea el boot automático (Termux:Boot) y levanta todo. Los detalles
están en la sección "Replicar el deploy" al final.

## Actualizaciones (nunca re-pa\u0301stees keys ni re-vincules WhatsApp)

```bash
cd ~/SDK-Bot && bash deploy/termux/update-termux.sh
```

El `update-termux.sh` hace `git pull --ff-only origin main`, reinstala
dependencias SOLO si cambiaron y reinicia los servicios. **No toca** `brain/.env`
ni `gateway/auth_info_baileys/` (ambos están en `.gitignore` y jamás viajan en git).

### Secretos a prueba de re-clon (backup fuera del repo)

El `setup-termux.sh` mantiene una copia automática en `~/.sdk-bot-secrets/`
(`.env` + `auth_info_baileys/`). Si algún día borras el repo y reclonas:

1. `git clone https://github.com/Zer0x25/SDK-Bot.git`
2. `cd SDK-Bot && bash deploy/termux/setup-termux.sh`

El script restaura keys y sesión desde el backup **antes** de arrancar: no
vuelves a pegar nada ni a escanear el QR.

---

## 1. Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│  Android + Termux                                          │
│                                                           │
│  runit (runsvdir)  ← supervive como hijo de init          │
│   ├── sdk-brain      → python main.py  (FastAPI :5100)     │
│   ├── sdk-gateway    → node index.js  (WhatsApp/Baileys)   │
│   ├── sshd                                                │
│   └── ssh-agent                                           │
│                                                           │
│  brain/  (FastAPI "cerebro" IA)  ← escucha 127.0.0.1:5100  │
│  gateway/ (Baileys WhatsApp)      ← llama a BRAIN_API_URL  │
└─────────────────────────────────────────────────────────┘
```

El gateway se conecta al brain por HTTP local (`http://127.0.0.1:5100/chat`).
El brain enruta la respuesta entre varios proveedores de IA con fallbacks.

---

## 2. Rutas absolutas (importante)

Todo usa rutas hardcodeadas de Termux. Si mueves el repo, actualízalas en:
- `deploy/termux/startBrain.sh` / `deploy/termux/startGateway.sh`
- `/data/data/com.termux/files/usr/var/service/sdk-*/run`

Raíz del proyecto: `/data/data/com.termux/files/home/SDK-Bot`

---

## 3. Servicios con runit

Los servicios viven en `$PREFIX/var/service/` (en Termux eso es
`/data/data/com.termux/files/usr/var/service/`).

Para ver el estado:
```bash
sv status sdk-brain
sv status sdk-gateway
```

Para controlarlos:
```bash
sv up sdk-brain        # arrancar
sv down sdk-brain      # detener
sv restart sdk-gateway # reiniciar
```

### `sdk-brain/run`
```sh
#!/bin/sh
exec 2>&1
cd /data/data/com.termux/files/home/SDK-Bot/brain
export PYTHONPATH=/data/data/com.termux/files/home/SDK-Bot/brain:$PYTHONPATH
# Usar el python del sistema (tiene fastapi/uvicorn/openai). El venv local está vacío.
exec /data/data/com.termux/files/usr/bin/python main.py
```

> Nota: el brain usa el **python del sistema**, no el venv (el venv local está vacío).
> Si reinstalas dependencias, instálalas en el python global de Termux.

### `sdk-gateway/run`
```sh
#!/bin/sh
LOG=/data/data/com.termux/files/home/logs/sdk-gateway.log
mkdir -p /data/data/com.termux/files/home/logs
cd /data/data/com.termux/files/home/SDK-Bot/apps/gateway
export NODE_PATH=/data/data/com.termux/files/home/SDK-Bot/apps/gateway/node_modules:$NODE_PATH
exec node index.js 2>&1 | awk '{ print strftime("%Y-%m-%d %H:%M:%S"), $0; fflush() }' >> "$LOG"
```

El log del gateway queda en: `~/logs/sdk-gateway.log`

---

## 4. Dependencias

### Brain (Python)
```bash
cd ~/SDK-Bot/brain
pip install -r requirements.txt
# Paquetes clave: fastapi, uvicorn, openai, python-dotenv, pydantic
```
> `google-genai` (Gemini) **NO está instalado** en Termux: no compila en
> bionic (librerías nativas muy pesadas). Por eso `main.py` lo trata como fallback
> opcional — si falta, el bot simplemente salta ese proveedor.

### Gateway (Node)
```bash
cd ~/SDK-Bot/apps/gateway
npm install
# Dependencias: @whiskeysockets/baileys, pino, qrcode, qrcode-terminal
```

---

## 5. Variables de entorno

El brain lee `.env` (NO versionado — está en `.gitignore`). Crea `brain/.env`:

```env
OPENROUTER_API_KEY=sk-or-...
GROQ_API_KEY=gsk-...
GEMINI_API_KEY=...        # opcional, ignorado si no está instalado google-genai
BRAIN_API_KEY=...         # RECOMENDADO (F2): protege el brain con header X-API-Key
# BRAIN_HOST=127.0.0.1    # por defecto solo local; 0.0.0.0 SOLO si sabes lo que haces
# (otros proveedores según el router en main.py)
```

> ⚠️ **Seguridad (F2):** si defines `BRAIN_API_KEY`, TODA ruta del brain (menos
> `/`) exige el header `X-API-Key` → 401. El gateway la lee automáticamente del
> MISMO `brain/.env`, así que solo hay que pegar la key una vez. Sin key, el
> brain corre en modo legacy (sin auth) y sigue escuchando solo en `127.0.0.1`.

El gateway NO usa `.env` propio; lee la URL del brain y la API key de
`brain/.env` (`config.js` → `getBrainApiKey()`).

---

## 6. Vinculación de WhatsApp (sesión)

La sesión de Baileys se guarda en `gateway/auth_info_baileys/` (SENSITIVE, en
`.gitignore`). Para volver a vincular el número:

- El QR por `index.js` es frágil en Baileys 7.0.0-rc14.
- En este deploy existían `qr.js` y `pair.js` (scripts sueltos en disco, NO
  incluídos en el repo porque no funcionaron de forma fiable). Si necesitas
  re-vincular, genera el QR como PNG y cópialo a `/sdcard/Download/` para
  escanearlo desde el teléfono. No borres `auth_info_baileys/` a menos que
  quieras volver a hacer todo el flujo de vinculación.

---

## 7. Mantener vivo el proceso

- `termux-wake-lock` debe estar activo para que Android no duerma/mate los procesos.
- runit corre como hijo de `init` (PPID 1), así que minimizar Termux no lo mata.
- Si haces swipe-away de la app de Termux, el proceso puede morir y los servicios
  se detienen.
- **No hay boot script**: si reinicias el celular, runit NO arranca solo. Hay que
  levantarlo manualmente (o instalar `termux-boot`).

Para arrancar manualmente los servicios sin runit (debug):
```bash
bash ~/SDK-Bot/deploy/termux/startBrain.sh   # en un terminal
bash ~/SDK-Bot/deploy/termux/startGateway.sh # en otro terminal
```

---

## 8. Qué es específico de Termux

Desde la unificación (todo vive en `main`), lo único exclusivo de Android es:

| Archivo | Por qué es de Termux |
|---|---|
| `deploy/termux/startBrain.sh` / `startGateway.sh` | scripts de arranque manual con rutas de Termux |
| `deploy/termux/setup-termux.sh` | bootstrap idempotente (dependencias + runit + boot) |
| `brain/requirements-termux.txt` | sin `google-genai` (no compila en bionic) |
| `brain/.env` (local, NO versionado) | keys de API sin Gemini obligatorio |

Todo lo demás (instancia única, backoff de reconexión, logs rotados, pool de
concurrencia, retry transitorio) es código común que ya corre igual en Linux,
Windows y Termux.

---

## 9. Replicar el deploy en un celular nuevo (paso a paso)

> Verificado en: Termux (Android 16), Python 3.13.13, Node v26.3.1, npm 11.17.0.

### 9.1 Prerequisitos en Termux
```bash
pkg update && pkg upgrade -y
pkg install -y python nodejs runit git
termux-wake-lock        # mantener vivo el proceso
```

### 9.2 Clonar main y usar el bootstrap
```bash
cd ~
git clone https://github.com/Zer0x25/SDK-Bot.git
cd SDK-Bot
bash deploy/termux/setup-termux.sh   # hace los pasos 9.3-9.7 automáticamente
```
> Todo el deploy vive en `main` (única fuente de verdad) bajo `deploy/termux/`.
> No hay rama separada: el código es idéntico en las 3 plataformas.

### 9.3 Dependencias del brain (Python)
El `requirements.txt` original incluye `google-genai`, que **NO compila
en Termux** (bionic, sin wheel precompilado). Por eso existe
`brain/requirements-termux.txt` SIN ese paquete. Úsalo:
```bash
cd ~/SDK-Bot/brain
pip install -r requirements-termux.txt
# fastapi, uvicorn, openai, python-dotenv, pydantic — todos instalan bien
# google-genai se OMITE a propósito:
#   - no compila en Termux
#   - providers.py ya lo trata como fallback opcional (try/except ImportError)
#   - el bot funciona sin él (usa OpenRouter/Groq como proveedores principales)
```
> Si algún día necesitas Gemini en Termux, la única vía fiable es `pip install
> google-genai` tras instalar `rustc`/`cargo` y las herramientas de
> compilación de Termux (`pkg install rust clang`), pero es lento y frágil.
> Mejor: dejar Gemini como fallback de escritorio y no en el celular.

### 9.4 Dependencias del gateway (Node)
```bash
cd ~/SDK-Bot/apps/gateway
npm install
# baileys, pino, qrcode, qrcode-terminal se instalan sin problema en Termux
```

### 9.5 Variables de entorno
```bash
cd ~/SDK-Bot/brain
cat > .env <<'EOF'
OPENROUTER_API_KEY=sk-or-...
GROQ_API_KEY=gsk-...
# GEMINI_API_KEY=...   # opcional, ignorado si no está google-genai
EOF
chmod 600 .env
```

### 9.6 Registrar los servicios en runit
```bash
SVDIR=$PREFIX/var/service
# (en Termux eso es /data/data/com.termux/files/usr/var/service)

mkdir -p $SVDIR/sdk-brain $SVDIR/sdk-gateway

cat > $SVDIR/sdk-brain/run <<'EOF'
#!/bin/sh
exec 2>&1
cd /data/data/com.termux/files/home/SDK-Bot/brain
export PYTHONPATH=/data/data/com.termux/files/home/SDK-Bot/brain:$PYTHONPATH
exec /data/data/com.termux/files/usr/bin/python main.py
EOF

cat > $SVDIR/sdk-gateway/run <<'EOF'
#!/bin/sh
LOG=/data/data/com.termux/files/home/logs/sdk-gateway.log
mkdir -p /data/data/com.termux/files/home/logs
cd /data/data/com.termux/files/home/SDK-Bot/apps/gateway
export NODE_PATH=/data/data/com.termux/files/home/SDK-Bot/apps/gateway/node_modules:$NODE_PATH
exec node index.js 2>&1 | awk '{ print strftime("%Y-%m-%d %H:%M:%S"), $0; fflush() }' >> "$LOG"
EOF

chmod +x $SVDIR/sdk-brain/run $SVDIR/sdk-gateway/run
sv up sdk-brain sdk-gateway
```
> Si runit no está corriendo: `runsvdir -P $SVDIR &` (o reinicia Termux con
> `termux-wake-lock` activo). runit arranca solo como hijo de init tras el
> primer `runsvdir`.

### 9.7 Verificar
```bash
sv status sdk-brain sdk-gateway
tail -f ~/logs/sdk-gateway.log
```

---

## 10. Problemas conocidos (bitácora del deploy real en Termux)

> Verificado en: Android 16, Python 3.13.13 (sistema, sin venv), Node v26.3.1,
> runit en `$PREFIX/var/service`. PyPI en bionic NO tiene wheels precompilados
> para muchas librerías nativas.

### 10.1 El brain muere al arrancar si `google-genai` falta (CORREGIDO en main)
**Síntoma:** `AttributeError: 'NoneType' object has no attribute 'Client'` al
importar `providers`.
**Causa:** `providers.py` hacía `from google import genai` y
`genai.Client(...)` al nivel superior del módulo. En Termux `google-genai` NO
tiene wheel para bionic, no se instala, y el import rompía TODO el brain aunque
Gemini solo sea un fallback opcional.
**Solución (commit `50a745c` en main):** imports envueltos en
`try/except ImportError` → `genai = None`; `gemini_client` solo se instancia si
`genai is not None and GEMINI_API_KEY`.
**Regla para futuros cambios:** cualquier dependencia opcional (Gemini, etc.)
debe quedar detrás de `try/except ImportError`. `requirements-termux.txt` omite
`google-genai` a propósito.

### 10.2 El gateway no arranca tras un pull: falta `npm install`
**Síntoma:** `Cannot find module 'pino-roll'` al arrancar el gateway.
**Causa:** `git pull` NO ejecuta `npm install`; un cambio en
`apps/gateway/package.json` (p.ej. `pino-roll` de F1) deja `node_modules` desincronizado.
**Solución:** `cd apps/gateway && npm install` antes de reiniciar. El
`update-termux.sh` ya lo hace solo (compara el hash de `package.json` antes y
después del pull). El `package-lock.json` versionado evita que el lock se
corrompa con la resolución de Termux.

### 10.3 Ruta del log del brain cambió (F1)
El brain ahora escribe con `RotatingFileHandler` a `brain/logs/brain.log`
(5 MB × 3 backups). Antes se monitorizaba `~/logs/sdk-brain.log`. El gateway
sigue en `~/logs/sdk-gateway.log`. `print()` directo NO llega al log del brain;
usar `safe_log()` o `make_logger()`.

### 10.4 Archivos legacy
`gateway/qr.js` y `gateway/pair.js` eran restos sin trackear en el working tree
(ya no se usan; el QR/pairing lo maneja `index.js` + `qrcode-terminal`).
Eliminar con `rm` si reaparecen tras un pull.

---

## 11. Sobre "deploy desde imagen" (aislar para evitar conflictos)

Termux **no tiene Docker** (no hay kernel containerizado en Android estándar),
pero hay dos formas de lograr un entorno reproducible y aislado:

### Opción A — Script de bootstrap (recomendada, simple)
El `setup-termux.sh` de este mismo directorio hace la sección 9 en un comando:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Zer0x25/SDK-Bot/main/deploy/termux/setup-termux.sh)
```
Ventaja: idempotente, fácil de versionar, no requiere root. Desventaja: sigue
usando el python/node del sistema (compartido con otras cosas de Termux).

### Opción B — `termux-chroot` + `proot` (aislamiento tipo contenedor)
```bash
pkg install -y proot
termux-chroot
# dentro del chroot tienes un filesystem pseudo-Linux aislado
# ahí clonas y corres SDK-Bot como si fuera un mini-servidor
```
Ventaja: aísla del resto de Termux (rutas, $PREFIX propias). Desventaja: runit
dentro del chroot necesita arrancarse a mano cada vez; no sobrevive solo al
reinicio del celular (igual que la Opción A).

### Opción C — `termux-boot` para arranque automático
Instala el APK `Termux:Boot` desde F-Droid. El `setup-termux.sh` ya crea
`~/.termux/boot/start-services.sh` automáticamente:
```bash
#!/bin/sh
termux-wake-lock
runsvdir -P $PREFIX/var/service &
```
Así los servicios vuelven solos tras reiniciar el celular.

### Recomendación
Para evitar el "conflicto en Termux" (versiones de python/node mezcladas,
`google-genai` roto, rutas hardcodeadas): usa la **Opción A** (el
bootstrap `deploy/termux/setup-termux.sh` versionado en `main`) como fuente
de verdad del deploy. En lugar de una imagen binaria, es un script idempotente
que reconstruye el entorno idéntico en cualquier celular.

---

## 12. Apéndice: problemas vistos durante el deploy

- **`pip install -r requirements.txt` falla** en Termux por `google-genai`.
  Solución: instalar dependencias selectivamente (sección 9.3). El bot igual
  funciona sin Gemini.
- **QR de WhatsApp frágil** en Baileys 7.0.0-rc14: el flujo por QR se queda
  pegado en "iniciando sesión". En este deploy los scripts `qr.js`/`pair.js`
  quedaron sueltos en disco y NO se incluyeron en el repo (no funcionaron de
  forma fiable). La sesión persistió vía `auth_info_baileys/`, así que no fue
  necesario re-vincular.
- **Sin boot script**: si el celular se reinicia, runit no arranca solo. Usa
  `termux-boot` (Opción C) para automatizarlo.
- **Cerrar Termux (swipe-away)** puede matar runit y detener los servicios.
  Minimizar (no cerrar) + `termux-wake-lock` mantiene todo vivo.
