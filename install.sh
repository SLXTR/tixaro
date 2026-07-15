#!/bin/sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker wurde nicht gefunden. Installiere zuerst Docker mit Compose-Unterstützung."
  exit 1
fi

if [ ! -f .env ]; then
  database_password="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nAPP_PORT=3000\n' "$database_password" > .env
  echo "Sichere interne Zugangsdaten wurden erzeugt."
fi

docker compose up -d --build

echo ""
echo "Tixaro wurde gestartet."
echo "Öffne http://127.0.0.1:3000/setup und schließe die Ersteinrichtung ab."
