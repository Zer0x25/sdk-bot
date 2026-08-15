#!/usr/bin/env bash
# Smoke test del instalador Linux sin tocar systemd ni procesos del host.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

FAKE_BIN="$TMP_DIR/bin"
FAKE_HOME="$TMP_DIR/home"
CALLS="$TMP_DIR/calls.log"
mkdir -p "$FAKE_BIN" "$FAKE_HOME"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$INSTALL_SMOKE_CALLS"
EOF

cat > "$FAKE_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

chmod +x "$FAKE_BIN/systemctl" "$FAKE_BIN/pgrep"

PATH="$FAKE_BIN:$PATH" \
HOME="$FAKE_HOME" \
XDG_CONFIG_HOME="$FAKE_HOME/config" \
INSTALL_SMOKE_CALLS="$CALLS" \
bash "$REPO_DIR/deploy/linux/install.sh" >/dev/null

UNIT_DIR="$FAKE_HOME/config/systemd/user"
for unit in sdk-bot-brain.service sdk-bot-gateway.service sdk-bot-panel.service; do
    test -f "$UNIT_DIR/$unit"
done

grep -Fq 'systemctl --user enable sdk-bot-brain' "$CALLS"
grep -Fq 'systemctl --user enable sdk-bot-gateway' "$CALLS"
grep -Fq 'systemctl --user enable sdk-bot-panel' "$CALLS"
grep -Fq 'systemctl --user start sdk-bot-brain' "$CALLS"
grep -Fq 'systemctl --user start sdk-bot-gateway' "$CALLS"
grep -Fq 'systemctl --user start sdk-bot-panel' "$CALLS"

printf 'install smoke: OK\n'
