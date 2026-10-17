#!/bin/sh
# Creates ./secrets for docker-compose.yml: the account key, the database password and URL, and a
# small private CA with the database server's certificate (TLS with a verified certificate is
# required by the Cloud towards any host but this machine). Nothing is overwritten: delete a file
# yourself to renew it (see README.md before renewing the account key or the password).
#
# The files are mode 0444 inside a 0700 folder: Docker bind-mounts each file with its own mode and
# the unprivileged users in the containers (uid 1000 for Moat, postgres) must be able to read it,
# while other users of this machine cannot enter the folder. Needs: openssl, head, base64, tr.
set -eu

cd "$(dirname "$0")"
umask 077
mkdir -p secrets
chmod 0700 secrets

random() {
  head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
}

keep() {
  if [ -e "secrets/$1" ]; then
    echo "kept     secrets/$1"
    return 0
  fi
  return 1
}

if ! keep moat_account_key; then
  # 32 random bytes, base64url without padding (MOAT_ACCOUNT_KEY).
  random 32 >secrets/moat_account_key
  echo "created  secrets/moat_account_key"
fi

if ! keep moat_signing_key; then
  # 32 random bytes (an Ed25519 seed): the key Moat Cloud signs managed gates' bundles with
  # (MOAT_SIGNING_KEY). Gates pin its public half; keep a copy, a new key needs every gate re-pinned.
  random 32 >secrets/moat_signing_key
  echo "created  secrets/moat_signing_key"
fi

if ! keep db_password; then
  random 32 >secrets/db_password
  echo "created  secrets/db_password"
fi

if ! keep db_ca.crt; then
  openssl ecparam -name prime256v1 -genkey -noout -out secrets/db_ca.key
  openssl req -x509 -new -key secrets/db_ca.key -sha256 -days 3650 \
    -subj "/CN=Moat Cloud database CA" -out secrets/db_ca.crt
  echo "created  secrets/db_ca.crt (+ db_ca.key: keep it off the server, or delete it)"
fi

if ! keep db_server.crt; then
  openssl ecparam -name prime256v1 -genkey -noout -out secrets/db_server.key
  openssl req -new -key secrets/db_server.key -subj "/CN=postgres" -out secrets/db_server.csr
  printf 'subjectAltName=DNS:postgres\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n' \
    >secrets/db_server.ext
  openssl x509 -req -in secrets/db_server.csr -CA secrets/db_ca.crt -CAkey secrets/db_ca.key \
    -CAcreateserial -days 825 -sha256 -extfile secrets/db_server.ext -out secrets/db_server.crt
  rm -f secrets/db_server.csr secrets/db_server.ext secrets/db_ca.srl
  echo "created  secrets/db_server.crt, db_server.key (host name: postgres, 825 days)"
fi

if ! keep moat_database_url; then
  # The password is base64url: no character that needs escaping in a URL.
  printf 'postgresql://moat:%s@postgres:5432/moat?sslmode=verify-full' "$(cat secrets/db_password)" \
    >secrets/moat_database_url
  echo "created  secrets/moat_database_url"
fi

chmod 0444 secrets/moat_account_key secrets/db_password secrets/moat_database_url \
  secrets/db_ca.crt secrets/db_server.crt secrets/db_server.key
# The CA's private key is only needed to sign a new server certificate.
[ ! -e secrets/db_ca.key ] || chmod 0400 secrets/db_ca.key
echo "done. Next: create .env with MOAT_PUBLIC_ORIGIN (README.md), then docker compose up -d --build"
