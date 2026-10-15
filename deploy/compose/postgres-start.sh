#!/bin/sh
# Entry point of the postgres service (docker-compose.yml): PostgreSQL insists that its TLS key is
# owned by the postgres user (or root) and not readable by others, which a mounted secret is not.
# The key is copied into a tmpfs (/run/tls, memory only) with that owner and mode, then the image's
# own entrypoint runs with TLS switched on. Runs as root until the image drops to `postgres`.
set -eu

install -d -m 0755 /run/tls
cp /run/secrets/db_tls_cert /run/tls/server.crt
cp /run/secrets/db_tls_key /run/tls/server.key
chown postgres:postgres /run/tls/server.crt /run/tls/server.key
chmod 0644 /run/tls/server.crt
chmod 0600 /run/tls/server.key

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/run/tls/server.crt \
  -c ssl_key_file=/run/tls/server.key \
  -c ssl_min_protocol_version=TLSv1.2 \
  -c password_encryption=scram-sha-256
