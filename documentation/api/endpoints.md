# API endpoint index (`/api/v1`)

Hand-maintained index of the backend routes. **A machine-readable OpenAPI document has not been produced yet**; until it is,
treat the zod schemas next to each route (`backend/src/modules/*/`) and the tests as the contract.

Conventions: JSON bodies; session cookie `bsm_session` (HttpOnly, SameSite=Lax, Secure in production); errors are
`{ "error": { "code", "message", "requestId", "details"? } }` with codes `BAD_REQUEST 400`, `UNAUTHENTICATED 401`, `FORBIDDEN 403`,
`NOT_FOUND 404`, `CONFLICT 409`, `PAYLOAD_TOO_LARGE 413`, `UNSUPPORTED_MEDIA_TYPE 415`, `VALIDATION_FAILED 422`, `RATE_LIMITED 429`, `INTERNAL 500`.
Lists are paginated with `page` / `pageSize` (max 50, audit max 200) and allowlisted `sort` fields.
"Non-members get 404" means another tenant's resources are indistinguishable from missing ones.
**Org** = organization-scoped permission (role in that organization). **Platform** = platform role + verified MFA session.

## Public / operational
| Method & path | Notes |
|---|---|
| `GET /health` | Liveness |
| `GET /ready` | Readiness (database reachable), 503 otherwise |

## Auth (`/auth`)
`POST /register`, `POST /verify-email`, `POST /login` (TOTP code when MFA is enabled), `POST /logout`, `GET /me`, `POST /password/forgot`, `POST /password/reset`, `POST /mfa/setup`, `POST /mfa/confirm`.

## Organizations (`/organizations`)
| Path | Permission |
|---|---|
| `GET /`, `POST /` | signed in |
| `GET /:orgId`, `GET /:orgId/reviews`, `GET /:orgId/members` | Org read / members.read |
| `PATCH /:orgId` (draft or needs_information only), `POST /:orgId/submit` | org.update / org.submit_for_review |
| `PATCH /:orgId/members/:memberId`, `DELETE /:orgId/members/:memberId` | members.manage (no escalation) |
| `GET/POST /:orgId/invitations`, `DELETE /:orgId/invitations/:invitationId` | members.invite |
| `GET/POST /:orgId/facilities`, `PATCH /:orgId/facilities/:facilityId` | locations.read / manage (+ approved) |
| `GET/POST /:orgId/facilities/:facilityId/locations`, `PATCH …/locations/:locationId` | same |
| `GET/POST …/locations/:locationId/departments`, `PATCH …/departments/:departmentId` | same |
| `GET/POST /:orgId/jobs`, `GET/PATCH /:orgId/jobs/:jobId`, `PUT …/requirements` | jobs.read / jobs.manage (+ approved) |
| `POST/PATCH/DELETE /:orgId/jobs/:jobId/shifts[/:shiftId]` | jobs.manage (+ approved) |
| `POST /:orgId/jobs/:jobId/status` | jobs.manage; publishing/resuming needs jobs.publish |
| `GET /:orgId/jobs/:jobId/candidates` | applications.read; eligible candidates ranked, others listed with reasons |
| `GET /:orgId/applications`, `GET /:orgId/applications/:appId` | applications.read |
| `POST /:orgId/applications/:appId/status` | applications.manage; offers require eligibility |

`POST /invitations/accept` (signed in; the invited address only).

## Professionals (`/professionals`, own data only)
`POST /`, `GET|PATCH /me`, `PUT /me/specialties`, `GET|POST /me/education`, `PUT|DELETE /me/education/:id`, same for `/me/experience`, `GET|PUT /me/preferences`, `GET|PUT /me/availability`.
Credentials: `GET|POST /me/credentials`, `GET|PATCH|DELETE /me/credentials/:id`, `POST …/:id/submit`, `GET|POST …/:id/documents` (raw body, PDF/JPEG/PNG ≤ 10 MB), `DELETE …/:id/documents/:docId`, `POST …/:id/documents/:docId/access` (60-second signed link).
Applications: `GET /me/applications`, `GET /me/applications/:id`, `POST /me/applications/:id/status` (withdrawn | accepted | declined).
`GET /credential-documents/download?token=` streams a document to the owner or a credential reviewer (re-authorized, audited).

## Opportunities (`/jobs`, signed in)
`GET /` (filters: `q`, `professionId`, `specialtyId`, `state`, `employmentType`, `payUnit`, `minPayCents`, `shiftFrom`, `shiftTo`; `sort` = published_at | pay_max | next_shift), `GET /:id`, `POST /:id/apply`.
`GET /taxonomies/professions` (professions with specialties).

## Talent search and invitations (privacy contract: ADR 0005)
| Path | Permission |
|---|---|
| `GET /organizations/:orgId/talent` (filters: `professionId`, `specialtyId`, `state`, `employmentType`, `licenseType`, `licenseState`, `verifiedOnly`, `minYears`, `jobId`, `sort`; 25 per page, first 300 results only) | professionals.search + approved organization; anonymized cards of opted-in professionals; audited, rate limited |
| `POST /organizations/:orgId/talent/invitations` , `GET …/invitations` , `DELETE …/invitations/:id` | applications.manage / applications.read |
| `GET` / `PUT /professionals/me/discoverability` | the professional (off by default) |
| `GET /professionals/me/invitations` , `POST …/invitations/:id/decline` | the professional |

## Notifications and support (signed in, own data only)
`GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read-all`, `POST /notifications/:id/read`, `GET|PUT /notifications/preferences`.
`POST|GET /support/tickets`, `GET /support/tickets/:id`, `POST /support/tickets/:id/messages`, `POST /support/tickets/:id/close`.

## Platform administration (`/admin`, Platform + MFA)
| Path | Platform permission |
|---|---|
| `GET /dashboard` | any platform role (sections filtered by permission) |
| `GET /organizations`, `GET /organizations/:orgId`, `POST /organizations/:orgId/status`, `GET /organization-lookup` | facility_review |
| `GET /credentials`, `GET /credentials/:id`, `POST /credentials/:id/status`, `POST /credential-documents/:id/access` | credential_review |
| `GET /users`, `GET /users/:id`, `GET /users/lookup?email=` | user_lookup |
| `POST /users/:id/status` | user_manage (platform users: super admin only) |
| `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/status` (pause/close/cancel with reason) | marketplace_oversight |
| `GET /audit-logs` (filters: actorUserId, actorEmail, action prefix, targetType, targetId, organizationId, from, to) | audit_read |
| `POST|PATCH /taxonomies/professions[/:id]`, `POST|PATCH /taxonomies/specialties[/:id]`, `GET /states`, `PUT /states/:state` | taxonomy_manage |
| `GET|PUT /settings/ranking-weights`, `GET /metrics` | settings_manage |
| `GET /support/tickets[/:id]`, `POST …/messages`, `POST …/assign`, `POST …/status` | support |
