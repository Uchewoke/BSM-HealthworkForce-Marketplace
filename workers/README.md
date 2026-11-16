# workers

Placeholder. Nothing here is built or wired in yet.

Intended home for background processing that should not run inside the API request path, for example:

- email retries beyond the in-request attempts (the Resend/Postmark senders in `backend/src/integrations/email.ts` retry three times inline)
- malware scanning off the request path (today `ClamAvScanner` scans inline during upload when `CLAMAV_HOST` is set)
- credential-expiry and notification jobs
- the unfilled-shift recovery pass (today a timer inside the API process, which assumes a single API instance)

This folder is deliberately **not** listed in the root `package.json` `workspaces`. When the first worker is added, give it a `package.json` (`@bsm/workers`), add it to `workspaces`, and record the decision in `documentation/decisions/`.
