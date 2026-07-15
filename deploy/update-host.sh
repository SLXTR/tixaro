#!/bin/sh
set -u

project_root="${1:-}"
case "$project_root" in
  /*) ;;
  *) echo "Tixaro-Installationsverzeichnis fehlt oder ist nicht absolut."; exit 1 ;;
esac

if [ ! -d "$project_root/.git" ] || [ ! -f "$project_root/docker-compose.yml" ]; then
  echo "Unter '$project_root' wurde keine vollständige Tixaro-Installation gefunden."
  exit 1
fi

cd "$project_root"

write_status() {
  state="$1"
  tag="$2"
  attempts="${3:-1}"
  current_attempt=1
  while [ "$current_attempt" -le "$attempts" ]; do
    if docker compose exec -T app node -e '
      const fs = require("node:fs");
      fs.writeFileSync("/app/data/update-status.json", JSON.stringify({ state: process.argv[1], tagName: process.argv[2], updatedAt: new Date().toISOString() }), { mode: 0o600 });
    ' "$state" "$tag" >/dev/null 2>&1; then
      return 0
    fi
    current_attempt=$((current_attempt + 1))
    sleep 2
  done
  return 1
}

fail_update() {
  echo "$1"
  write_status failed "$request_tag" 3 || true
  exit 1
}

request_tag="$(docker compose exec -T app node -e '
  const fs = require("node:fs");
  try {
    const request = JSON.parse(fs.readFileSync("/app/data/update-request.json", "utf8"));
    process.stdout.write(String(request.tagName || ""));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
' 2>/dev/null)" || exit 0
request_tag="$(printf '%s' "$request_tag" | tr -d '\r\n')"
[ -n "$request_tag" ] || exit 0

if ! printf '%s' "$request_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  fail_update "Ungültiger Release-Tag in der Update-Anforderung."
fi

docker compose exec -T app node -e '
  const fs = require("node:fs");
  try { fs.unlinkSync("/app/data/update-request.json"); } catch (error) { if (error.code !== "ENOENT") throw error; }
' >/dev/null 2>&1 || fail_update "Die Update-Anforderung konnte nicht übernommen werden."
write_status running "$request_tag" 1 || fail_update "Der Update-Status konnte nicht gespeichert werden."

update_repository="$(sed -n 's/^TIXARO_UPDATE_REPOSITORY=//p' .env | tail -n 1)"
[ -n "$update_repository" ] || update_repository="SLXTR/tixaro"
if ! printf '%s' "$update_repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  fail_update "Das konfigurierte GitHub-Repository ist ungültig."
fi
published_tag="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "https://api.github.com/repos/${update_repository}/releases/latest" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" || fail_update "Das veröffentlichte GitHub-Release konnte nicht geprüft werden."
[ -n "$published_tag" ] || fail_update "Das veröffentlichte GitHub-Release konnte nicht geprüft werden."
[ "$published_tag" = "$request_tag" ] || fail_update "Die angeforderte Version ist nicht das aktuell veröffentlichte GitHub-Release."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail_update "Lokale Änderungen verhindern das automatische Update."
fi
update_remote="$(sed -n 's/^TIXARO_UPDATE_REMOTE=//p' .env | tail -n 1)"
[ -n "$update_remote" ] || update_remote="origin"
if ! printf '%s' "$update_remote" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  fail_update "Die konfigurierte GitHub-Updatequelle ist ungültig."
fi
git fetch --quiet --tags --prune "$update_remote" || fail_update "GitHub konnte nicht abgerufen werden."

tag_commit="$(git rev-parse --verify "refs/tags/${request_tag}^{commit}" 2>/dev/null)" || fail_update "Der Release-Tag wurde im Repository nicht gefunden."
git merge-base --is-ancestor HEAD "$tag_commit" || fail_update "Das Release ist kein sicheres Fast-Forward-Update."

package_version="$(git show "${tag_commit}:package.json" | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
[ "$package_version" = "${request_tag#v}" ] || fail_update "Release-Tag und Paketversion stimmen nicht überein."

git merge --ff-only "$tag_commit" || fail_update "Das Release konnte nicht übernommen werden."
frontend_url="$(sed -n 's/^APP_BASE_URL=//p' .env | tail -n 1)"
[ -n "$frontend_url" ] || fail_update "Die öffentliche Tixaro-URL fehlt in .env."

TIXARO_URL="$frontend_url" TIXARO_ENABLE_UI_UPDATES=yes sh install.sh || fail_update "Die Container konnten nicht aktualisiert werden."

container_id="$(docker compose ps -q app)"
attempt=1
while [ "$attempt" -le 30 ]; do
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  [ "$health" = "healthy" ] && break
  sleep 2
  attempt=$((attempt + 1))
done
[ "${health:-}" = "healthy" ] || fail_update "Der aktualisierte Tixaro-Container wurde nicht fehlerfrei gestartet."

write_status completed "$request_tag" 10 || true
echo "Tixaro ${package_version} wurde erfolgreich installiert."
