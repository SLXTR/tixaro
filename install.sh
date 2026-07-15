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

set_env_value APP_BASE_URL "$frontend_url"
set_env_value TIXARO_PROXY_NETWORK "$proxy_network"
set_env_value TIXARO_SERVER_NAME "$nginx_server_name"

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
sed -e "s/tickets.example.com/${nginx_server_name}/g" -e 's#127.0.0.1:3000#tixaro-app:3000#g' deploy/nginx.conf > "$generated_dir/nginx-container.conf"

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

set_env_value TIXARO_DEPLOYMENT_MODE "$deployment_mode"

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
