# workers

Placeholder. Nothing here is built or wired in yet.

Intended home for background processing that should not run inside the API request path, for example:

- sending email through a real provider (replaces the dev console sender)
- malware scanning of credential documents (documents stay `not_scanned` until this exists)
- credential-expiry and notification jobs

This folder is deliberately **not** listed in the root `package.json` `workspaces`. When the first worker is added, give it a `package.json` (`@bsm/workers`), add it to `workspaces`, and record the decision in `documentation/decisions/`.
