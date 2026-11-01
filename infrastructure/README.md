# infrastructure

Placeholder. No deployment, monitoring or storage infrastructure exists yet.

| Folder | Intended content |
|---|---|
| `deployment/` | Environment definitions and pipelines (production needs PostgreSQL via `DATABASE_URL`) |
| `monitoring/` | Alerting and dashboards (alerting is not wired; see `documentation/operations/runbook.md`) |
| `storage/` | Private object-storage setup for credential documents (the API refuses to start in production without an adapter) |

Do not commit secrets here.
