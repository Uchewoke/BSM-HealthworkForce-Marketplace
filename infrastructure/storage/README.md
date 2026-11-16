# storage

Credential documents live in a private S3-compatible bucket through `backend/src/integrations/storage.ts` (`S3PrivateStorage`).
Any of AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage (S3 endpoint) or MinIO works; configure it with the `STORAGE_*`
variables in `.env.example`.

Bucket requirements:
- **Block all public access.** Objects are only ever read by the API after its own authorization check; nothing is served from the bucket URL.
- **Encryption at rest** as the bucket default (SSE-S3 or KMS). `STORAGE_SSE` can add a per-object header, but bucket default encryption is simpler and cannot be forgotten.
- **Versioning on**, and a lifecycle rule that keeps noncurrent versions for at least the backup retention period (14+ days).
- **Replication or scheduled backup** to a second region/account on the database backup schedule, so a database restore has matching files.
- **Least-privilege credentials:** an access key limited to `GetObject`, `PutObject` and `DeleteObject` on this bucket (and prefix) only; no list, no bucket admin.
- Keys are server-generated UUIDs under `STORAGE_PREFIX` (default `credential-documents/`); a bucket browser shows no file names or owners.
