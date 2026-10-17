#!/bin/sh
# Creates ./secrets/moat_account_key and ./.env for docker-compose.yml. Nothing is overwritten.
#   ./init.sh moat.example.ch          the domain Caddy gets a certificate for
#   ./init.sh localhost                a test on this machine (Caddy's own CA; the browser warns)
set -eu
cd "$(dirname "$0")"
umask 077
domain="${1:-}"
case "$domain" in
  '' | *[!a-z0-9.-]* | .* | *.)
    echo "usage: ./init.sh <domain>   (lower case letters, digits, dots and dashes)" >&2
    exit 1
    ;;
esac
mkdir -p secrets
chmod 0700 secrets
if [ -e secrets/moat_account_key ]; then
  echo "kept     secrets/moat_account_key"
else
  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > secrets/moat_account_key
  # Readable by the container's user 1000 inside the 0700 folder (see ../compose/init-secrets.sh).
  chmod 0444 secrets/moat_account_key
  echo "created  secrets/moat_account_key  (keep a copy; without it TOTP accounts cannot be opened)"
fi
if [ -e .env ]; then
  echo "kept     .env"
else
  printf 'MOAT_DOMAIN=%s\n' "$domain" > .env
  echo "created  .env"
fi
echo "next: docker compose up -d"
