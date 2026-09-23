#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PORTS_INSTALL_DIR:-/opt/ports}"
ENV_FILE="$INSTALL_DIR/.env"
SERVICE_USER="ports"

fail() { echo "Fehler: $*" >&2; exit 1; }

run_as_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Für die Installation werden root-Rechte oder sudo benötigt."
  fi
}

env_value() {
  local key="$1"
  [[ -r "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

echo "Ports – Installation für Debian/Ubuntu-LXC"
echo

[[ -r /etc/os-release ]] || fail "Das Betriebssystem konnte nicht erkannt werden."
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ;;
  *) fail "Unterstützt werden Debian und Ubuntu (erkannt: ${ID:-unbekannt})." ;;
esac

echo "Installiere Systempakete …"
run_as_root apt-get update
run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git gnupg openssl smbclient

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
fi
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 20 )); then
  echo "Installiere Node.js 22 …"
  nodesource_key="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$nodesource_key"
  run_as_root mkdir -p /usr/share/keyrings
  run_as_root gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg "$nodesource_key"
  rm -f "$nodesource_key"
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' | \
    run_as_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  run_as_root apt-get update
  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

node_major="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
(( node_major >= 20 )) || fail "Benötigt wird Node.js 20 oder neuer; installiert ist $(node --version 2>/dev/null || echo unbekannt)."

if [[ "$PROJECT_DIR" != "$INSTALL_DIR" ]]; then
  echo "Kopiere die Anwendung nach $INSTALL_DIR …"
  run_as_root install -d -m 755 "$INSTALL_DIR"
  run_as_root cp -a "$PROJECT_DIR/." "$INSTALL_DIR/"
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  run_as_root useradd --system --user-group --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
run_as_root install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR/data"

secret_key="$(env_value PORTS_SECRET_KEY)"
if [[ -z "$secret_key" || "$secret_key" == "CHANGE_ME" ]]; then
  secret_key="$(openssl rand -hex 32)"
fi
repository="$(env_value PORTS_GITHUB_REPOSITORY)"
repository="${repository:-BenAhrdt/ports}"

temporary_env="$(mktemp)"
chmod 600 "$temporary_env"
{
  printf 'PORTS_API_HOST=0.0.0.0\n'
  printf 'PORTS_API_PORT=8787\n'
  printf 'PORTS_DATA_DIR=%s/data\n' "$INSTALL_DIR"
  printf 'PORTS_GITHUB_REPOSITORY=%s\n' "$repository"
  printf 'PORTS_SECRET_KEY=%s\n' "$secret_key"
} > "$temporary_env"
run_as_root install -m 640 -o root -g "$SERVICE_USER" "$temporary_env" "$ENV_FILE"
rm -f "$temporary_env"

echo "Installiere Node-Abhängigkeiten und erzeuge den Produktions-Build …"
run_as_root npm --prefix "$INSTALL_DIR" ci
run_as_root npm --prefix "$INSTALL_DIR" run build

run_as_root chown -R root:root "$INSTALL_DIR"
run_as_root chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data"
run_as_root chmod 700 "$INSTALL_DIR/data"
run_as_root chown root:"$SERVICE_USER" "$ENV_FILE"
run_as_root chmod 640 "$ENV_FILE"

service_file="$(mktemp)"
cat > "$service_file" <<EOF
[Unit]
Description=Ports Workflow-Editor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data

[Install]
WantedBy=multi-user.target
EOF
run_as_root install -m 644 "$service_file" /etc/systemd/system/ports.service
rm -f "$service_file"

update_service_file="$(mktemp)"
cat > "$update_service_file" <<EOF
[Unit]
Description=Ports sicher aktualisieren
After=network-online.target

[Service]
Type=oneshot
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/update.sh
TimeoutStartSec=infinity
EOF
run_as_root install -m 644 "$update_service_file" /etc/systemd/system/ports-update.service
rm -f "$update_service_file"

update_path_file="$(mktemp)"
cat > "$update_path_file" <<EOF
[Unit]
Description=Ports Updateanforderung überwachen

[Path]
PathExists=$INSTALL_DIR/data/.update-requested
Unit=ports-update.service

[Install]
WantedBy=multi-user.target
EOF
run_as_root install -m 644 "$update_path_file" /etc/systemd/system/ports-update.path
rm -f "$update_path_file"

run_as_root systemctl daemon-reload
run_as_root systemctl enable --now ports-update.path
run_as_root systemctl enable --now ports.service
run_as_root systemctl restart ports.service
sleep 2
if ! run_as_root systemctl is-active --quiet ports.service; then
  echo "Fehler: ports.service konnte nicht gestartet werden." >&2
  run_as_root systemctl status ports.service --no-pager --full >&2 || true
  run_as_root journalctl -u ports.service -n 50 --no-pager >&2 || true
  exit 1
fi

echo
echo "Ports wurde erfolgreich installiert."
echo "Aufruf: http://<IP-DIESES-LXC>:8787"
echo "Status: systemctl status ports"
echo "Logs:   journalctl -u ports -f"
