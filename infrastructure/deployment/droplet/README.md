# API on a DigitalOcean Droplet (Docker Compose)

The two Next.js apps stay on Vercel. The API runs as one long-running container on a Droplet, behind Caddy for TLS. A private
clamd for virus scanning can run beside it; it is **off for now** (decided 2026-11-17) and turned on with one setting (below). Everything the API stores lives elsewhere (PostgreSQL on Neon, documents in Spaces), so the Droplet holds no data
and can be rebuilt from this folder.

| File | Purpose |
|---|---|
| `Dockerfile` | The API image: Node 22, the backend plus `@bsm/permissions`, run with tsx (build context is the repository root) |
| `compose.yml` | `caddy` (ports 80/443), `api`, and `clamav` (private network only, `scanner` profile, off by default) |
| `Caddyfile` | TLS for `API_DOMAIN`, HTTP to HTTPS redirect, 12 MB body cap, JSON access log |
| `env.example` | Template for `.env` on the Droplet (the only file with secrets; never commit it) |
| `cloud-init.yml` | First-boot hardening: deploy user, key-only SSH, ufw, fail2ban, unattended upgrades, Docker |
| `deploy.sh` | Pull, rebuild, restart, wait for healthy, check `/ready` |

## One-time setup

1. **Resources.** A Neon project (free plan) on AWS in the region nearest the Droplet (for DigitalOcean NYC, `us-east-1`);
   copy the **pooled** connection string. A private DigitalOcean Space with its own access key (`infrastructure/storage/README.md`),
   and the Droplet: Ubuntu 24.04, **2 GB RAM** (4 GB once the scanner is on: clamd uses about 1.3 GB), with `cloud-init.yml` pasted into *User data* after
   replacing the SSH key. (DigitalOcean Managed PostgreSQL works too: same region as the Droplet, the Droplet as its only
   trusted source, the connection-pool endpoint, and its CA certificate in `certs/`; see `env.example`.) DNS: an A record for `API_DOMAIN`
   (for example `api.example.com`) pointing at the Droplet's IP, before the first start, so Caddy can obtain the certificate.
2. **Clone and configure** on the Droplet:
   ```bash
   ssh deploy@<ip>
   git clone <repository url> /opt/bsm && cd /opt/bsm/infrastructure/deployment/droplet
   cp env.example .env && chmod 600 .env && nano .env        # fill every value
   ```
   With Neon, `DATABASE_URL` is the pooled string with `sslmode=require`; this `pg` version verifies Neon's public certificate
   and host name, and no CA file is needed. With DigitalOcean Managed PostgreSQL, save its CA as `certs/db-ca.crt` and use
   `sslmode=verify-full&sslrootcert=/run/ca/db-ca.crt`.
3. **First start:** `./deploy.sh`. It builds the image (two or three minutes), starts the three containers, waits until the
   API is healthy and calls `/api/v1/ready`. The API applies pending migrations when it starts. Then create the first administrator
   inside the container:
   ```bash
   docker compose exec -e BSM_ADMIN_PASSWORD='<12+ chars>' api node --import tsx src/scripts/create-admin.ts you@example.com "Your Name" platform_super_admin
   ```
4. **Point the apps at the API.** On Vercel set `NEXT_PUBLIC_API_URL=https://api.example.com/api/v1` for production and redeploy.
   The apps call the API cross-origin with credentials; the API allows exactly `WEB_URL` and `ADMIN_URL` (CORS and the Origin
   check), and the session cookie is `SameSite=Lax`, which browsers send between `app.example.com` and `api.example.com` because
   they are the same site. Vercel preview deployments (`*.vercel.app`) are a different site and cannot sign in against this
   API; point previews at a staging Droplet with their own `WEB_URL`, or do not use previews for signed-in flows.
5. **Verify** (record the results in the production checklist): sign in from the real web app, upload a document and confirm it
   is stored and labelled not scanned, send one real verification email, and confirm `curl -I http://api.example.com` redirects
   to HTTPS. The API logs a warning at start-up that no scanner is configured; that is expected until the scanner is on.

## Turning on virus scanning later

1. Resize the Droplet to 4 GB RAM (DigitalOcean: the Droplet, Resize, CPU and RAM only; it powers off for a minute or two).
2. In `.env` uncomment `COMPOSE_PROFILES=scanner` and `CLAMAV_HOST=clamav`, then run `./deploy.sh`. The first start of `clamav`
   downloads signatures for a few minutes; `docker compose ps` shows it healthy when ready.
3. Upload the EICAR test file and confirm it is rejected as infected, and confirm port 3310 on the Droplet's public IP is closed
   from outside (`nc -zv <droplet ip> 3310` must fail).

## Every deploy

```bash
ssh deploy@<ip> /opt/bsm/infrastructure/deployment/droplet/deploy.sh          # main
ssh deploy@<ip> /opt/bsm/infrastructure/deployment/droplet/deploy.sh v1.2.0   # a tag
```

Take a database backup first when the release carries a migration (runbook §3; migrations are forward-only). The old container
keeps serving until the new image is built; the swap itself is a few seconds of downtime, which is acceptable for this API at
the current scale. Roll back by deploying the previous ref; if a migration was applied, restore the backup instead.

## Operating

- Logs: `docker compose logs -f api` (JSON lines from pino), `docker compose logs caddy` (access log). Ship them off the box
  (`infrastructure/monitoring/README.md`); the json-file driver keeps 100 MB per container locally.
- Health: `GET /api/v1/health` (process up) and `/ready` (database answers) through Caddy; use them for the external uptime monitor.
- Signatures (scanner on): the `clamav` container refreshes them itself (freshclam); `docker compose logs clamav` shows the updates.
- OS patches apply automatically with a reboot at 04:30 UTC when needed; `restart: unless-stopped` brings the stack back.
- Image updates: `docker compose pull caddy clamav && docker compose up -d` monthly, after reading their release notes.
- Scaling out (a second API instance or server) is not covered here: the rate limiter runs in memory (`RATE_LIMIT_STORE=memory`),
  which only counts correctly on one process. Before adding an instance, switch to a shared store (Upstash, or a Redis store to
  be added) and remove that variable.

## Why these choices

- **tsx at runtime, no compile step.** The backend's `build` script only typechecks, and `@bsm/permissions` ships TypeScript
  source; running the source with tsx is what `npm run dev` already does and avoids a second module layout to maintain.
- **Caddy** obtains and renews certificates with no configuration beyond the domain. Its `X-Forwarded-For` is the single
  proxy hop that `trust proxy = 1` in `backend/src/app.ts` expects, so per-IP rate limits see the real client address.
- **clamd on an internal network** only. It has no authentication; the `internal` network has no route to the host's public
  interface, and the port is not published.
- **Read-only API container**, no capabilities, memory limit: the process writes nothing locally in production (local disk
  storage is refused), so a compromise cannot persist anything on the box.
