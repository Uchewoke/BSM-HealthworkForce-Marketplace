# ADR 0002: Credentials, review states and private documents

Status: accepted (2026-10-30)

## Decisions
- **One `credentials` table** with `kind` (`license` | `certification`) instead of separate `licenses` / `certifications` tables, so documents, review history and the review queue are uniform. Split later if the shapes diverge.
- **Stored vs. effective status.** The stored status is the last review outcome. `effective_status` turns anything past its expiration date into `expired` (except `revoked` / `rejected`). Expiry is never a transition and needs no cron.
- **"Verified" always carries a method.** `verified` requires `document_review` or `primary_source`. `primary_source` requires a recorded reference to the source checked. API labels say "Documents reviewed (not verified with the primary source)" for document review. `verification_in_progress` is reserved for a future external integration and is unreachable today.
- **Credential numbers** are AES-256-GCM encrypted with `FIELD_ENCRYPTION_KEY` (separate from the MFA key). Professionals only ever see the last 4 characters; reviewers see the full number and each view is audited.
- **Documents** live behind a `PrivateFileStorage` interface (local filesystem for development; a private-bucket adapter is needed for production). Uploads are raw bodies (no multipart dependency), limited to PDF/JPEG/PNG, 10 MB, 5 per credential, with magic-byte checks. Names are display-only.
- **Malware scanning** is an adapter. Without one, documents are stored as `not_scanned`; the system never claims `clean` on its own. Infected files are rejected.
- **Access** is owner or credential-review platform role with a verified MFA session. Facilities have no access path (a business-purpose access grant is an open product decision). Links are 60-second HMAC-signed tokens bound to the requesting user; authorization is re-checked at download and every access is audited.

## Known limits
- Availability is recurring weekly windows only (no date exceptions, no overlap checks).
- Preferred work locations are stored as states in `professional_preferences`.
- `state_configurations` (per-state licensing rules) is not built; the launch states are an open decision.
- PDFs can carry active content; they are served as attachments with a sandboxing CSP, but scanning is still required before production.
