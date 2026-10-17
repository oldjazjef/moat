#!/bin/sh
# Starts a built Moat Cloud image with a signing key and runs the two flows against it: the Cloud's
# own (smoke-cloud-flow.mjs) and the real PHP gate against the Cloud (smoke-gate-interop.mjs, when
# php and the built gate file are there). Run `pnpm install` (and `pnpm build:gate-php`) first.
#   scripts/smoke-flow-image.sh moat-cloud:local
set -eu
image="${1:?usage: smoke-flow-image.sh <image>}"
cd "$(dirname "$0")/.."
name="moat-flow-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

random() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
origin="https://moat.example.test"
docker run -d --name "$name" -p 127.0.0.1:0:3000 --read-only \
  --tmpfs /tmp:size=16m,noexec,nosuid,nodev --tmpfs /data:uid=1000,gid=1000,mode=0700 \
  --cap-drop ALL --security-opt no-new-privileges \
  -e MOAT_PUBLIC_ORIGIN="$origin" -e MOAT_ACCOUNT_KEY="$(random)" -e MOAT_SIGNING_KEY="$(random)" \
  "$image" >/dev/null
port="$(docker port "$name" 3000/tcp | head -n1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
for _ in $(seq 1 30); do
  curl -fsS "$base/readyz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$base/readyz" >/dev/null

node scripts/smoke-cloud-flow.mjs "$base" "$origin"
if command -v php >/dev/null 2>&1 && [ -f gates/php/dist/moat-gate.php ]; then
  node scripts/smoke-gate-interop.mjs "$base" "$origin"
else
  echo "smoke-flow-image: php or the built gate is missing; the gate interop was skipped" >&2
fi
