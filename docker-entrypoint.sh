#!/bin/sh
set -eu

data_dir="${TIXARO_DATA_DIR:-/app/data}"
secrets_file="$data_dir/runtime-secrets.env"
temporary_file="$secrets_file.tmp"

mkdir -p "$data_dir"
umask 077

if [ ! -s "$secrets_file" ]; then
  node -e 'const { randomBytes } = require("node:crypto"); console.log(`SESSION_SECRET=${randomBytes(48).toString("hex")}`); console.log(`MAIL_SECRET_KEY=${randomBytes(32).toString("hex")}`);' > "$temporary_file"
  mv "$temporary_file" "$secrets_file"
fi

. "$secrets_file"
export SESSION_SECRET MAIL_SECRET_KEY

exec "$@"
