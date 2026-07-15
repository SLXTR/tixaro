#!/bin/sh
set -eu

env_file=".env"
generated_dir=".tixaro"

get_env_value() {
  key="$1"
  [ -f "$env_file" ] || return 0
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

set_env_value() {
  key="$1"
  value="$2"
  temporary_file="${env_file}.tmp.$$"
  if [ -f "$env_file" ]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { found = 0 }
      index($0, key "=") == 1 { print key "=" value; found = 1; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$env_file" > "$temporary_file"
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary_file"
  fi
  mv "$temporary_file" "$env_file"
  chmod 600 "$env_file"
}

valid_frontend_url() {
  printf '%s' "$1" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$'
}

port_is_used() {
  port="$1"
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"; then
    return 0
  fi
  docker ps --format '{{.Ports}}' | grep -Eq "[:.]${port}->" 2>/dev/null
}

find_free_port() {
  port="$1"
  while port_is_used "$port"; do
    port=$((port + 1))
  done
  printf '%s' "$port"
}

host_nginx_is_running() {
  if command -v pgrep >/dev/null 2>&1 && pgrep -x nginx >/dev/null 2>&1; then
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    return 0
  fi
  return 1
}

wait_for_app_health() {
  attempt=1
  while [ "$attempt" -le 45 ]; do
    app_container_id="$(docker compose ps -q app)"
    if [ -n "$app_container_id" ]; then
      app_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_container_id" 2>/dev/null || true)"
      case "$app_health" in
        healthy|running) return 0 ;;
        unhealthy|exited|dead)
          echo "Der neue Tixaro-Container ist nicht fehlerfrei gestartet (Status: ${app_health})."
          return 1
          ;;
      esac
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "Der neue Tixaro-Container wurde nicht rechtzeitig betriebsbereit."
  return 1
}

reload_nginx_container() {
  nginx_container="$1"
  [ -n "$nginx_container" ] || return 1
  attempt=1
  while [ "$attempt" -le 15 ]; do
    if docker exec "$nginx_container" nginx -t >/dev/null 2>&1 && docker exec "$nginx_container" nginx -s reload >/dev/null 2>&1; then
      echo "Nginx im Container '$nginx_container' wurde auf den neuen Tixaro-Container umgeschaltet."
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "Nginx im Container '$nginx_container' konnte nicht geprüft oder neu geladen werden."
  return 1
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

mark_host_updater_ready() {
  attempt=1
  while [ "$attempt" -le 10 ]; do
    if docker compose exec -T app node -e 'require("node:fs").writeFileSync("/app/data/host-updater-ready", "ready\n", { mode: 0o600 })' >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

install_host_updater() {
  command -v systemctl >/dev/null 2>&1 || return 0
  install_dir="$(pwd -P)"
  install_user="${SUDO_USER:-$(id -un)}"
  if printf '%s' "$install_dir" | grep -Eq '[^A-Za-z0-9_./-]' || ! printf '%s' "$install_user" | grep -Eq '^[A-Za-z_][A-Za-z0-9_-]*$'; then
    echo "Ein-Klick-Updates konnten für diesen Installationspfad nicht sicher eingerichtet werden."
    return 0
  fi

  expected_exec="ExecStart=/bin/sh ${install_dir}/deploy/update-host.sh ${install_dir}"
  if systemctl is-enabled --quiet tixaro-update.timer 2>/dev/null && systemctl cat tixaro-update.service 2>/dev/null | grep -Fq "$expected_exec"; then
    mark_host_updater_ready || true
    return 0
  fi

  enable_updates="${TIXARO_ENABLE_UI_UPDATES:-$(get_env_value TIXARO_ENABLE_UI_UPDATES)}"
  if [ -z "$enable_updates" ] && [ -t 0 ]; then
    printf 'Ein-Klick-Updates im Admin-Center aktivieren? [J/n]: '
    IFS= read -r enable_updates
    [ -n "$enable_updates" ] || enable_updates="yes"
  fi
  case "$enable_updates" in
    yes|YES|Yes|ja|JA|Ja|j|J|1|true|TRUE) ;;
    *) set_env_value TIXARO_ENABLE_UI_UPDATES no; return 0 ;;
  esac

  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    echo "Ein-Klick-Updates wurden nicht aktiviert, weil sudo fehlt."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "Ein-Klick-Updates wurden nicht aktiviert, weil curl fehlt."
    return 0
  fi

  sed -e "s|__INSTALL_DIR__|${install_dir}|g" -e "s|__INSTALL_USER__|${install_user}|g" deploy/tixaro-update.service.template > "$generated_dir/tixaro-update.service"
  if ! run_as_root install -m 0644 "$generated_dir/tixaro-update.service" /etc/systemd/system/tixaro-update.service; then
    echo "Ein-Klick-Updates konnten nicht aktiviert werden."
    return 0
  fi
  if ! run_as_root install -m 0644 deploy/tixaro-update.timer /etc/systemd/system/tixaro-update.timer; then
    echo "Ein-Klick-Updates konnten nicht aktiviert werden."
    return 0
  fi
  if ! run_as_root systemctl daemon-reload || ! run_as_root systemctl enable --now tixaro-update.timer; then
    echo "Ein-Klick-Updates konnten nicht aktiviert werden."
    return 0
  fi
  run_as_root rm -f /usr/local/libexec/tixaro-update 2>/dev/null || true
  set_env_value TIXARO_ENABLE_UI_UPDATES yes
  if mark_host_updater_ready; then
    echo "Ein-Klick-Updates wurden im Admin-Center aktiviert."
  else
    echo "Der Update-Helfer läuft, konnte aber noch nicht mit Tixaro verbunden werden."
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker wurde nicht gefunden. Installiere zuerst Docker mit Compose-Unterstützung."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose wurde nicht gefunden. Installiere das Docker-Compose-Plugin."
  exit 1
fi

if [ ! -f "$env_file" ]; then
  database_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  umask 077
  printf 'POSTGRES_PASSWORD=%s\n' "$database_password" > "$env_file"
  echo "Sichere interne Zugangsdaten wurden erzeugt."
fi

current_url="$(get_env_value APP_BASE_URL)"
frontend_url="${TIXARO_URL:-}"
while ! valid_frontend_url "$frontend_url"; do
  if [ ! -t 0 ]; then
    echo "Die öffentliche URL fehlt. Starte das Skript interaktiv oder setze TIXARO_URL=https://tickets.example.com."
    exit 1
  fi
  echo ""
  echo "Unter welcher URL soll das Tixaro-Frontend erreichbar sein?"
  if [ -n "$current_url" ]; then
    printf 'Öffentliche URL [%s]: ' "$current_url"
  else
    printf 'Öffentliche URL (z. B. https://tickets.example.com): '
  fi
  IFS= read -r frontend_url
  [ -n "$frontend_url" ] || frontend_url="$current_url"
  frontend_url="${frontend_url%/}"
  if ! valid_frontend_url "$frontend_url"; then
    echo "Bitte gib eine vollständige HTTP- oder HTTPS-Adresse ohne Unterpfad ein."
  fi
done

frontend_url="${frontend_url%/}"
frontend_scheme="${frontend_url%%://*}"
frontend_authority="${frontend_url#*://}"
frontend_host="$(printf '%s' "$frontend_authority" | sed -E 's/:[0-9]+$//')"
case "$frontend_host" in
  *[!A-Za-z0-9._-]*) nginx_server_name="_" ;;
  *) nginx_server_name="$frontend_host" ;;
esac

proxy_network="${TIXARO_PROXY_NETWORK:-$(get_env_value TIXARO_PROXY_NETWORK)}"
[ -n "$proxy_network" ] || proxy_network="tixaro_proxy"
case "$proxy_network" in
  [A-Za-z0-9]* ) ;;
  * ) echo "Der Name des Proxy-Netzwerks ist ungültig."; exit 1 ;;
esac
if printf '%s' "$proxy_network" | grep -Eq '[^A-Za-z0-9_.-]'; then
  echo "Der Name des Proxy-Netzwerks ist ungültig."
  exit 1
fi

update_repository="${TIXARO_UPDATE_REPOSITORY:-$(get_env_value TIXARO_UPDATE_REPOSITORY)}"
[ -n "$update_repository" ] || update_repository="SLXTR/tixaro"
if ! printf '%s' "$update_repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
  echo "Das GitHub-Repository für Updates ist ungültig."
  exit 1
fi

set_env_value APP_BASE_URL "$frontend_url"
set_env_value TIXARO_PROXY_NETWORK "$proxy_network"
set_env_value TIXARO_SERVER_NAME "$nginx_server_name"
set_env_value TIXARO_UPDATE_REPOSITORY "$update_repository"

if ! docker network inspect "$proxy_network" >/dev/null 2>&1; then
  docker network create "$proxy_network" >/dev/null
  echo "Gemeinsames Proxy-Netzwerk '$proxy_network' wurde angelegt."
fi

echo ""
echo "Laufende Docker-Container:"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'

previous_deployment_mode="$(get_env_value TIXARO_DEPLOYMENT_MODE)"
proxy_container="${TIXARO_PROXY_CONTAINER:-$(get_env_value TIXARO_PROXY_CONTAINER)}"
proxy_candidates=""
if [ "$previous_deployment_mode" != "bundled-nginx" ] || [ -n "$proxy_container" ]; then
  proxy_candidates="$(docker ps --format '{{.Names}}|{{.Image}}' | awk -F'|' 'tolower($0) ~ /(nginx|swag)/ { print $1 }')"
fi

if [ -z "$proxy_container" ] && [ -n "$proxy_candidates" ]; then
  candidate_count="$(printf '%s\n' "$proxy_candidates" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [ "$candidate_count" -eq 1 ]; then
    proxy_container="$proxy_candidates"
    echo "Reverse Proxy erkannt: $proxy_container"
  elif [ -t 0 ]; then
    echo ""
    echo "Mehrere Reverse-Proxys wurden erkannt:"
    printf '%s\n' "$proxy_candidates" | awk 'NF { printf "  %d) %s\n", NR, $0 }'
    while [ -z "$proxy_container" ]; do
      printf 'Welcher Container soll Tixaro bereitstellen? '
      IFS= read -r selection
      case "$selection" in
        ''|*[!0-9]*) echo "Bitte eine Nummer aus der Liste eingeben." ;;
        *) proxy_container="$(printf '%s\n' "$proxy_candidates" | sed -n "${selection}p")";
           [ -n "$proxy_container" ] || echo "Diese Auswahl existiert nicht." ;;
      esac
    done
  else
    echo "Mehrere Reverse-Proxys wurden gefunden. Setze TIXARO_PROXY_CONTAINER auf den gewünschten Containernamen."
    exit 1
  fi
fi

mkdir -p "$generated_dir"
sed -e "s|\${TIXARO_SERVER_NAME}|${nginx_server_name}|g" deploy/nginx-container.conf.template > "$generated_dir/nginx-container.conf"

if [ -n "$proxy_container" ]; then
  if ! docker inspect "$proxy_container" >/dev/null 2>&1 || [ "$(docker inspect -f '{{.State.Running}}' "$proxy_container")" != "true" ]; then
    echo "Der ausgewählte Proxy-Container '$proxy_container' läuft nicht."
    exit 1
  fi
  set_env_value TIXARO_PROXY_CONTAINER "$proxy_container"
  if ! docker inspect -f '{{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}' "$proxy_container" | tr ' ' '\n' | grep -Fxq "$proxy_network"; then
    docker network connect "$proxy_network" "$proxy_container"
    echo "'$proxy_container' wurde mit dem Netzwerk '$proxy_network' verbunden."
  fi
  docker compose up -d --build
  deployment_mode="container-proxy"
elif host_nginx_is_running; then
  app_port="$(get_env_value APP_PORT)"
  case "$app_port" in ''|*[!0-9]*) app_port="3000" ;; esac
  app_port="$(find_free_port "$app_port")"
  set_env_value APP_PORT "$app_port"
  sed -e "s/tickets.example.com/${nginx_server_name}/g" -e "s/127.0.0.1:3000/127.0.0.1:${app_port}/g" deploy/nginx.conf > "$generated_dir/nginx-host.conf"
  docker compose -f docker-compose.yml -f docker-compose.host-nginx.yml up -d --build
  deployment_mode="host-nginx"
else
  http_port="$(get_env_value TIXARO_HTTP_PORT)"
  case "$http_port" in ''|*[!0-9]*) http_port="8080" ;; esac
  http_port="$(find_free_port "$http_port")"
  set_env_value TIXARO_HTTP_PORT "$http_port"
  docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d --build
  deployment_mode="bundled-nginx"
fi

if ! wait_for_app_health; then
  exit 1
fi

case "$deployment_mode" in
  container-proxy)
    if ! reload_nginx_container "$proxy_container"; then
      echo "Der Reverse Proxy konnte nicht auf den neuen Tixaro-Container umgeschaltet werden."
      exit 1
    fi
    ;;
  bundled-nginx)
    bundled_nginx_container="$(docker compose -f docker-compose.yml -f docker-compose.nginx.yml ps -q nginx)"
    if ! reload_nginx_container "$bundled_nginx_container"; then
      echo "Der mitgelieferte Nginx konnte nicht auf den neuen Tixaro-Container umgeschaltet werden."
      exit 1
    fi
    ;;
esac

set_env_value TIXARO_DEPLOYMENT_MODE "$deployment_mode"
install_host_updater

echo ""
echo "Tixaro wurde gestartet."
echo "Öffentliche URL: ${frontend_url}"
case "$deployment_mode" in
  container-proxy)
    echo "Der vorhandene Reverse Proxy '$proxy_container' bleibt bestehen."
    echo "Richte dort '${frontend_host}' mit dem Ziel 'tixaro-app' und Port '3000' ein."
    echo "Für einen klassischen Nginx-Container liegt eine Vorlage unter $generated_dir/nginx-container.conf."
    ;;
  host-nginx)
    echo "Der auf dem Host laufende Nginx wurde erkannt."
    echo "Installiere $generated_dir/nginx-host.conf in dessen Server-Konfiguration und lade Nginx neu."
    echo "Interner Tixaro-Port: 127.0.0.1:${app_port}"
    ;;
  bundled-nginx)
    echo "Es wurde kein vorhandener Reverse Proxy erkannt. Ein eigener Nginx läuft auf Host-Port ${http_port}."
    if [ "$frontend_scheme" = "https" ]; then
      echo "Für HTTPS muss davor noch TLS für '${frontend_host}' eingerichtet werden."
    fi
    ;;
esac
echo "Öffne ${frontend_url}/setup und schließe die Ersteinrichtung ab."
