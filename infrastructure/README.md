# infrastructure

Deployment configuration and storage requirements are documented below; monitoring is still to be set up.

| Folder | Intended content |
|---|---|
| `deployment/` | Vercel layout for the apps; `deployment/droplet/` runs the API on a DigitalOcean Droplet with Docker Compose (Caddy, API, clamd) |
| `monitoring/` | Alerting and dashboards (alerting is not wired; see `documentation/operations/runbook.md`) |
| `storage/` | Private object-storage requirements for credential documents (S3-compatible adapter in `backend/src/integrations/storage.ts`) |

Do not commit secrets here.
