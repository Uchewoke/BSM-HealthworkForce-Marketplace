#!/usr/bin/env bash
# Deploys the API on the Droplet from the checked-out repository: pull, rebuild the image, swap the container, verify.
# Usage (on the Droplet, as the deploy user):  /opt/bsm/infrastructure/deployment/droplet/deploy.sh [git-ref]
# The API applies pending migrations when it starts (backend/src/server.ts), so take a database backup first (runbook §3).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
ref="${1:-main}"

[ -f "$here/.env" ] || { echo "missing $here/.env (copy env.example)"; exit 1; }
mkdir -p "$here/certs"
# A DATABASE_URL that names a private CA (DigitalOcean Managed PostgreSQL) needs that file; Neon's public CA needs none.
ca="$(grep -E '^DATABASE_URL=' "$here/.env" | grep -oE 'sslrootcert=/run/ca/[^&"]+' | sed 's|sslrootcert=/run/ca/||' || true)"
if [ -n "$ca" ] && [ ! -f "$here/certs/$ca" ]; then echo "DATABASE_URL names sslrootcert but $here/certs/$ca is missing"; exit 1; fi

cd "$repo"
git fetch --prune origin
git checkout -q "$ref"
git pull -q --ff-only origin "$ref" 2>/dev/null || true
echo "deploying $(git rev-parse --short HEAD) ($ref)"

cd "$here"
docker compose build --pull api
docker compose up -d --remove-orphans

# Wait for the new container to report healthy (migrations run during start-up).
for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q api)" 2>/dev/null || echo starting)"
  [ "$status" = healthy ] && break
  sleep 3
done
if [ "${status:-}" != healthy ]; then
  echo "api is $status; last log lines:"; docker compose logs --tail 50 api; exit 1
fi

api_domain="$(grep -E '^API_DOMAIN=' .env | cut -d= -f2- | tr -d '[:space:]')"
curl -fsS "https://${api_domain}/api/v1/ready" && echo
docker image prune -f >/dev/null
echo "deployed $(git -C "$repo" rev-parse --short HEAD)"
