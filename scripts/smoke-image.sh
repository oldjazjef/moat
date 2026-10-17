#!/bin/sh
# Starts a built Moat Cloud image once with a throwaway key and checks that it serves: /readyz, the
# dashboard, the generated env.js, and that a bad configuration is refused. Used by CI and release.
#   scripts/smoke-image.sh moat-cloud:local
set -eu
image="${1:?usage: smoke-image.sh <image>}"
name="moat-smoke-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

key="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
docker run -d --name "$name" -p 127.0.0.1:0:3000 --read-only \
  --tmpfs /tmp:size=16m,noexec,nosuid,nodev --tmpfs /data:uid=1000,gid=1000,mode=0700 --cap-drop ALL --security-opt no-new-privileges \
  -e MOAT_PUBLIC_ORIGIN=https://moat.example.test -e MOAT_ACCOUNT_KEY="$key" "$image" >/dev/null
port="$(docker port "$name" 3000/tcp | head -n1 | sed 's/.*://')"
base="http://127.0.0.1:$port"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "$base/readyz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "smoke: /readyz never answered" >&2
  docker logs "$name" 2>&1 | tail -20 >&2
  exit 1
fi
curl -fsS -H 'Accept: text/html' "$base/" | grep -qi '<mt-root' || { echo "smoke: dashboard not served" >&2; exit 1; }
curl -fsS "$base/env.js" | grep -q "authMode: 'cloud'" || { echo "smoke: env.js wrong" >&2; exit 1; }
curl -fsS "$base/api/health" | grep -q '"ok"' || { echo "smoke: /api/health wrong" >&2; exit 1; }
[ "$(docker exec "$name" id -u)" = 1000 ] || { echo "smoke: not running as user 1000" >&2; exit 1; }

# A bad configuration must stop the process, naming variables only.
if out="$(docker run --rm -e MOAT_PUBLIC_ORIGIN=http://evil.example -e MOAT_ACCOUNT_KEY=short "$image" 2>&1)"; then
  echo "smoke: a bad configuration was accepted" >&2
  exit 1
fi
echo "$out" | grep -q 'Invalid API environment: MOAT_PUBLIC_ORIGIN, MOAT_ACCOUNT_KEY' \
  || { echo "smoke: the refusal does not name the variables" >&2; exit 1; }
echo "$out" | grep -q 'evil.example' && { echo "smoke: the refusal echoes a value" >&2; exit 1; }
echo "smoke: ok ($image)"
