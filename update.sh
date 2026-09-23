#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${PORTS_DATA_DIR:-$PROJECT_DIR/data}"
STATUS_FILE="$DATA_DIR/update-status.json"
MARKER_FILE="$DATA_DIR/.update-requested"

write_status() {
  local state="$1" progress="$2" step="$3"
  mkdir -p "$DATA_DIR"
  printf '{"state":"%s","progress":%s,"step":"%s","updated_at":"%s"}\n' \
    "$state" "$progress" "$step" "$(date --iso-8601=seconds)" > "$STATUS_FILE"
  chmod 644 "$STATUS_FILE"
}

on_error() {
  write_status failed 0 "Das Update ist fehlgeschlagen. Bitte die Serverlogs prüfen."
}
trap on_error ERR

cd "$PROJECT_DIR"
rm -f "$MARKER_FILE"

if [[ ! -d .git ]]; then
  write_status failed 0 "Updates benötigen eine Installation aus einem Git-Repository."
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  write_status failed 0 "Im Projekt liegen lokale Änderungen."
  exit 1
fi

write_status running 10 "Suche nach einer veröffentlichten Version …"
git fetch --tags --prune origin
latest_tag="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -n 1)"
if [[ -z "$latest_tag" ]]; then
  write_status current 100 "Im Repository ist noch kein veröffentlichtes Release vorhanden."
  exit 0
fi

current_version="v$(tr -d '[:space:]' < VERSION)"
if [[ "$current_version" == "$latest_tag" ]]; then
  write_status current 100 "Ports $current_version ist bereits aktuell."
  exit 0
fi

write_status running 30 "Aktualisiere den Quellcode auf $latest_tag …"
git checkout --detach "$latest_tag"

write_status running 60 "Installiere die aktualisierten Abhängigkeiten …"
npm ci

write_status running 82 "Erzeuge den neuen Produktions-Build …"
npm run build

write_status running 94 "Starte Ports mit der neuen Version neu …"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ports.service; then
  systemctl restart ports.service
fi

write_status complete 100 "Ports $latest_tag wurde erfolgreich installiert."
echo "Update auf Ports $latest_tag abgeschlossen."
