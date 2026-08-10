#!/usr/bin/env bash
# update-termux.sh — Actualización rutinaria en Termux.
# Hace pull de main y reinicia los servicios SIN tocar tus secretos:
#   - brain/.env  (API keys)  → nunca se sobreescribe
#   - gateway/auth_info_baileys/ (sesión WhatsApp) → nunca se borra
#
# Uso: bash deploy/termux/update-termux.sh   (desde ~/SDK-Bot o con ruta completa)
set -euo pipefail

REPO="${1:-$HOME/SDK-Bot}"
BACKUP_DIR="$HOME/.sdk-bot-secrets"

cd "$REPO"

# Detectar si package.json / requirements cambiaron (comparando hash antes/después del pull)
pkg_before=$(sha256sum gateway/package.json 2>/dev/null | cut -d' ' -f1)
req_before=$(sha256sum brain/requirements-termux.txt 2>/dev/null | cut -d' ' -f1)

echo "📥 Pull de main..."
git fetch origin
git pull --ff-only origin main

pkg_after=$(sha256sum gateway/package.json 2>/dev/null | cut -d' ' -f1)
req_after=$(sha256sum brain/requirements-termux.txt 2>/dev/null | cut -d' ' -f1)

echo "🔄 Reinstalando dependencias si cambiaron..."
if [ "$pkg_before" = "$pkg_after" ]; then
    echo "    gateway: package.json sin cambios — npm install omitido."
else
    echo "    gateway: package.json cambió — npm install..."
    (cd gateway && npm install)
fi
if [ "$req_before" = "$req_after" ]; then
    echo "    brain: requirements sin cambios — pip omitido."
else
    echo "    brain: requirements cambiaron — pip install..."
    (cd brain && pip install -r requirements-termux.txt)
fi

echo "🔄 Reiniciando servicios..."
sv down sdk-brain sdk-gateway 2>/dev/null || true
sleep 2
sv up sdk-brain sdk-gateway 2>/dev/null || true

# Mantener el backup de secretos al día
echo "🗄 Backup de secretos actualizado en $BACKUP_DIR"
[ -f brain/.env ] && cp -f brain/.env "$BACKUP_DIR/.env"
[ -d gateway/auth_info_baileys ] && rm -rf "$BACKUP_DIR/auth_info_baileys" && cp -r gateway/auth_info_baileys "$BACKUP_DIR/"

echo ""
echo "✅ Actualizado. Estado:"
sv status sdk-brain sdk-gateway
