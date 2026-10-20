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

# La dependencia file: se empaqueta: un cambio de contracts también exige instalar.
gateway_dependency_hash() {
    sha256sum gateway/package.json gateway/package-lock.json gateway/.npmrc \
        packages/contracts/package.json packages/contracts/index.js \
        packages/contracts/index.d.ts packages/contracts/generated.d.ts \
        packages/contracts/schema.json packages/contracts/openapi.json | sha256sum | cut -d' ' -f1
}
pkg_before=$(gateway_dependency_hash)
req_before=$(sha256sum brain/requirements-termux.txt 2>/dev/null | cut -d' ' -f1)

echo "📥 Pull de main..."
git fetch origin
git pull --ff-only origin main

pkg_after=$(gateway_dependency_hash)
req_after=$(sha256sum brain/requirements-termux.txt 2>/dev/null | cut -d' ' -f1)

echo "🔄 Reinstalando dependencias si cambiaron..."
if [ "$pkg_before" = "$pkg_after" ]; then
    echo "    gateway: manifests/contratos sin cambios — npm ci omitido."
else
    echo "    gateway: manifests/contratos cambiaron — npm ci..."
    (cd gateway && npm ci)
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
