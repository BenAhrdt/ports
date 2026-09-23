#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

fail() { echo "Fehler: $*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
Verwendung: ./release.sh patch|minor|major [--dry-run]

Erhöht die Version, aktualisiert CHANGELOG.md, testet und baut Ports,
erstellt Commit und Git-Tag und pusht beides nach origin/main.
EOF
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
BUMP_KIND="$1"
DRY_RUN=false
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--dry-run" ]] || usage
  DRY_RUN=true
fi
case "$BUMP_KIND" in
  patch|minor|major) ;;
  *) usage ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Das Skript muss innerhalb des Git-Repositories ausgeführt werden."
[[ -f VERSION ]] || fail "VERSION fehlt."
[[ -f CHANGELOG.md ]] || fail "CHANGELOG.md fehlt."
[[ -f package.json ]] || fail "package.json fehlt."
[[ -n "$(git remote get-url origin 2>/dev/null || true)" ]] || fail "Der Git-Remote 'origin' fehlt."
[[ -z "$(git status --porcelain)" ]] || fail "Das Arbeitsverzeichnis enthält lokale Änderungen."
[[ "$(git branch --show-current)" == "main" ]] || fail "Releases müssen aus dem Branch main erstellt werden."

current_version="$(tr -d '[:space:]' < VERSION)"
if [[ ! "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  fail "VERSION muss dem Format MAJOR.MINOR.PATCH entsprechen: $current_version"
fi
major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
case "$BUMP_KIND" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac
next_version="$major.$minor.$patch"
next_tag="v$next_version"

git rev-parse --verify --quiet "refs/tags/$next_tag" >/dev/null && fail "Der Tag $next_tag existiert bereits lokal."

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry-Run: $current_version -> $next_version ($BUMP_KIND)"
  echo "Dry-Run: würde VERSION, package.json, package-lock.json und CHANGELOG.md aktualisieren."
  echo "Dry-Run: würde testen, bauen, committen, $next_tag taggen und nach origin/main pushen."
  exit 0
fi

release_date="$(date +%Y-%m-%d)"
echo "Erhöhe Ports von $current_version auf $next_version …"
npm version "$next_version" --no-git-tag-version --ignore-scripts >/dev/null
printf '%s\n' "$next_version" > VERSION
sed -i "0,/^## Unveröffentlicht$/s//## Unveröffentlicht\\n\\n## [$next_version] - $release_date/" CHANGELOG.md

grep -q "^## \[$next_version\] - $release_date$" CHANGELOG.md \
  || fail "CHANGELOG.md enthält keinen Bereich für $next_version."

echo "Führe Tests und Produktions-Build aus …"
npm test
npm run build

git add VERSION package.json package-lock.json CHANGELOG.md
git diff --cached --check
git commit -m "Release $next_tag"
git tag -a "$next_tag" -m "Release $next_tag"

echo "Pushe main und $next_tag …"
git push origin main --follow-tags

echo
echo "Release $next_tag wurde angestoßen."
echo "GitHub Actions testet den Tag und erstellt anschließend das GitHub-Release."
