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
| `POST /:orgId/jobs/:jobId/match-runs` body `{scope: applicants|talent|both, shiftIds?}` | professionals.search + approved org; 20 runs/hour/user; advisory ranked shortlist, stored (ADR 0008). 404 for another org's job, 409 unless published/paused |
| `GET /:orgId/jobs/:jobId/match-runs`, `GET /:orgId/match-runs/:runId?group=eligible|all&page&pageSize` | applications.read; applicants by name, talent anonymized by `talentRef`; viewing is audited |
| `GET /:orgId/applications`, `GET /:orgId/applications/:appId` | applications.read |
| Admin, `/admin/match-retention`: `GET|PUT /settings {days}`, `POST /cleanup {dryRun}`, `GET /history?kind`, `GET|PUT /holds {runIds, reason}`, `DELETE /holds/:runId`, `POST /erasure {professionalId, dryRun (default true), reference?}` | platform `admin.settings_manage` (super admin) with MFA; ADR 0009 |
| `POST /:orgId/applications/:appId/status` | applications.manage; offers require eligibility |
| `POST /:orgId/applications/:appId/shift-offers` | applications.manage; shift-based offer, requires eligibility; body `shiftId`, optional `hourlyRateCents`, `message`, `expiresInHours` |
| `GET /:orgId/shift-offers` (filters `status`, `applicationId`), `POST /:orgId/shift-offers/:offerId/withdraw` | applications.read / applications.manage |
| `GET /:orgId/assignments`, `GET /:orgId/assignments/:id` | applications.read |
| `POST /:orgId/assignments/:id/status` | applications.manage; `completed`/`no_show` after start, `cancelled_by_facility` before start (reason required) |

`POST /invitations/accept` (signed in; the invited address only).

## Professionals (`/professionals`, own data only)
`POST /`, `GET|PATCH /me`, `PUT /me/specialties`, `GET|POST /me/education`, `PUT|DELETE /me/education/:id`, same for `/me/experience`, `GET|PUT /me/preferences`, `GET|PUT /me/availability`.
Credentials: `GET|POST /me/credentials`, `GET|PATCH|DELETE /me/credentials/:id`, `POST …/:id/submit`, `GET|POST …/:id/documents` (raw body, PDF/JPEG/PNG ≤ 10 MB), `DELETE …/:id/documents/:docId`, `POST …/:id/documents/:docId/access` (60-second signed link).
Applications: `GET /me/applications`, `GET /me/applications/:id`, `POST /me/applications/:id/status` (withdrawn | accepted | declined).

Shift offers and assignments: `GET /me/shift-offers[/:id]`, `POST /me/shift-offers/:id/respond` (`response`: accepted | declined; acceptance re-checks eligibility and capacity), `GET /me/assignments[/:id]`, `POST /me/assignments/:id/cancel` (reason required, before the shift starts).
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

## Staffing agencies
Agency organizations use `/organizations/:orgId/agency/*` (the organization must be an agency; roles `agency_*`).
| Path | Permission |
|---|---|
| `GET /roster` | agency.roster.read |
| `POST /roster/invitations` `{email}` (always 202), `DELETE /roster/:rosterId` | agency.roster.manage (approved organization) |
| `GET /jobs` (only jobs a facility granted) | agency.jobs.read |
| `POST /jobs/:jobId/submissions` `{professionalId, shiftIds?, coverNote?}` | agency.submissions.manage (approved organization) |
| `GET /submissions`, `GET /placements` | agency.submissions.read |

Facility side, under `/organizations/:orgId`: `GET /agencies?q=` (approved agencies, id and name only) and `GET /jobs/:jobId/agencies` (jobs.read); `POST /jobs/:jobId/agencies` `{agencyId}` and `DELETE /jobs/:jobId/agencies/:agencyId` (jobs.manage).

Professional side, under `/professionals/me`: `GET /agencies`, `POST /agencies/:id/respond` `{response: accept|decline}`, `DELETE /agencies/:id` (leave).

Admin: `GET /admin/organizations?type=agency|facility&status=` (default facility).

## Billing (manual invoicing)
Staff, under `/admin/billing` (platform permission `admin.billing_manage`, MFA):
| Path | Notes |
|---|---|
| `GET /fee`, `PUT /fee` `{bps}` | Platform fee in basis points; unset until staff configure it |
| `GET /organizations?q=` | Name search (id, name, type) |
| `GET /unbilled?organizationId&periodStart&periodEnd` | Preview of billable completed assignments |
| `GET /invoices`, `GET /invoices/:id`, `POST /invoices` `{organizationId, periodStart, periodEnd}` | Creates a draft; 409 if no fee or nothing to bill |
| `POST /invoices/:id/issue` `{dueInDays?}`, `POST /invoices/:id/payment` `{method, reference, paidOn?}`, `POST /invoices/:id/void` `{reason}` | draft→issued→paid; draft/issued→void |

Organizations, under `/organizations/:orgId/billing` (permission `billing.read`): `GET /invoices`, `GET /invoices/:id` (issued invoices only).

Agency job detail: `GET /organizations/:orgId/agency/jobs/:jobId` (agency.jobs.read).

## Subscription billing (ADR 0010)
Public: `GET /billing/plans?customerType=` (active, public plans; no provider ids). Provider webhook: `POST /api/v1/billing/webhooks/stripe` (raw body, `Stripe-Signature`; 400 on a bad signature, 200 on duplicates, 500 to request a retry).

Organizations, under `/organizations/:orgId/billing` (the manual-invoice routes above are unchanged):
| Path | Permission | Notes |
|---|---|---|
| `GET /`, `GET /subscription`, `GET /subscription-invoices` | billing.read | Overview with plans; local subscription (no provider ids); charges read live from Stripe |
| `GET /entitlements`, `GET /usage` | org.read | Presentation only; the server enforces on every request |
| `POST /checkout` `{planId}`, `POST /portal`, `POST /cancel`, `POST /resume` | billing.manage (owners) | 503 until billing is switched on; checkout needs an approved organization; 409 if already subscribed |

Gated features answer 403 with `details.code` `ENTITLEMENT_REQUIRED` (`reason`: no_subscription, not_in_plan, past_due_grace_ended, unpaid, canceled, paused, expired, incomplete) or `USAGE_LIMIT_EXCEEDED` (`limit`, `resetsAt`). Only organizations with `billing_mode = enforced` are gated.

Staff, under `/admin/billing` (admin.billing_manage, MFA): `GET|POST /plans`, `PATCH /plans/:planId`, `GET /subscriptions?status&customerType&page`, `GET /metrics?from&to`, `GET /organizations/:orgId`, `PUT /organizations/:orgId/mode` `{mode: exempt|enforced}`, `PUT /organizations/:orgId/customer` `{providerCustomerId}`, `POST /organizations/:orgId/resync`, `GET|POST /adjustments`, `POST /adjustments/:id/revoke` (discounts above 50% need platform_super_admin).

## Timesheets
Professional, under `/professionals/me`: `GET /timesheets` (started assignments with their timesheet), `GET /assignments/:id/timesheet`, `PUT /assignments/:id/timesheet` `{workedStart, workedEnd, breakMinutes, note?}` (creates, or resubmits after a return).

Facility, under `/organizations/:orgId`: `GET /timesheets?status=`, `GET /timesheets/:id` (applications.read); `POST /timesheets/:id/review` `{decision: approve|return, reason?}` (applications.manage; a reason is required to return).

Billing uses approved timesheet hours only; `GET /admin/billing/unbilled` also returns `awaitingTimesheet`.

## Reviews, reliability and disputes
Professional, under `/professionals/me`: `GET /reviews` (to review, written, received, own rating, reliability), `POST /assignments/:id/review` `{rating 1-5, comment?}`, `POST /reviews/:id/dispute` `{reason}`.

Facility, under `/organizations/:orgId`: `GET /ratings` (applications.read), `POST /assignments/:id/review`, `POST /reviews/:id/dispute` (applications.manage). The application detail includes `track` (reliability and rating).

Staff, under `/admin/reviews` (admin.support): `GET /disputes?status=open|upheld|removed`, `POST /disputes/:id/resolve` `{outcome: uphold|remove, note}`.

## Analytics
Facility: `GET /organizations/:orgId/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD` (jobs.read; default last 90 days, max 366). Cost figures (`costs`) are included only for roles with billing.read; `includesCosts` says which you received.

Agency: `GET /organizations/:orgId/agency/analytics?from&to` (agency.submissions.read).

## AI assistant
Facility: `GET /organizations/:orgId/assistant/status` -> `{configured}`; `POST /organizations/:orgId/assistant` `{messages: [{role: user|assistant, content}]}` (max 20 messages, 4,000 characters each, must start and end with the user; jobs.read; approved organization) -> `{reply, toolsUsed, draft, refused, incomplete}`. `draft` is a job posting proposal, never saved; post it to `POST /organizations/:orgId/jobs` to create it.

Agency: the same under `/organizations/:orgId/agency/assistant` (agency.jobs.read).

Returns 503 `UNAVAILABLE` when no API key is set or the provider fails, 429 after 30 requests per user per hour. Configuration: `ANTHROPIC_API_KEY`, optional `ASSISTANT_MODEL`, `ASSISTANT_EFFORT`.

## Demand forecast
Facility: `GET /organizations/:orgId/forecast?horizon=4..12` (jobs.read). Each of `overall` and `byProfession[]` is either `{status: "insufficient_history", reason}` or `{status: "ok", method, confidence, backtest, history, forecast: [{week, expected, low, high, alreadyPosted, expectedUnfilled}]}`.

## Regional float pool
Staff, `/admin/exchange` (admin.marketplace_oversight): `GET|POST /regions`, `PATCH /regions/:id`, `GET /participants`, `POST /participants/:id/status` `{status: suspended|active, reason}`.

Professional, `/professionals/me/float-pool`: `GET /` (regions and consent text), `POST /join` `{regionId, accept: true}`, `POST /leave` `{regionId}`, `GET /requests`, `POST /requests/:id/respond` `{response: accepted|declined}`.

Facility, `/organizations/:orgId/exchange`: `GET /regions` (org.read), `POST /participation` `{regionId, acceptTerms: true}` and `DELETE /participation/:regionId` (org.update); `GET /shifts?regionId`, `GET /pool/summary?regionId`, `GET /pool?regionId&shiftId&professionId&show=eligible|all` (professionals.search, approved, participating); `POST /requests` `{talentRef, shiftId, hourlyRateCents?, message?}` and `DELETE /requests/:id` (applications.manage); `GET /requests` (applications.read).

## Unfilled shift recovery
Facility, under `/organizations/:orgId/shift-recovery`: `GET /settings` (applications.read), `PUT /settings` `{enabled, maxOutreach, offerHours, escalateHours, minLeadHours, includeFloatPool}` (org.update, approved organization); `GET /` shifts in recovery with escalations (applications.read); `POST /shifts/:shiftId/start` and `/stop` (applications.manage); `POST /run` runs a pass for this organization now (applications.manage; 10 per hour).

Configuration: `SHIFT_RECOVERY_INTERVAL_MINUTES` (default 5; 0 disables the timer).

## Shift offers: details, one-tap accept, undo
Professional, under `/professionals/me`: `GET /shift-offers` and `GET /shift-offers/:id` now include `location_name`, `address_line1`, `shift_notes`, `requirements[]`, `eligibility` (for open offers), and the linked `assignment_*` fields. `POST /shift-offers/:id/respond` `{response}` returns, on acceptance, `undoUntil` and `nextSteps`. `POST /assignments/:id/undo` takes back an acceptance made within 5 minutes (no reason; does not count against reliability).

## Legal sign-off gate
Staff, `/admin/legal-signoffs` (super admin, settings_manage): `GET /` lists each gated feature (`float_pool`, `shift_recovery`) with its state; `PUT /:feature` `{signedOff, reference?, note?}` records or revokes sign-off (a reference of at least 3 characters is required to sign off).

While a feature is not signed off, its endpoints return 403 with `details: { code: "legal_signoff_required", feature }`. Responses include `available` where a screen needs to explain itself: `GET /professionals/me/float-pool`, `GET /organizations/:orgId/exchange/regions`, `GET /organizations/:orgId/shift-recovery/settings`.

## Undo reasons
`POST /professionals/me/assignments/:id/undo` takes an optional `{reason}`. After 3 undos in the last 30 days a reason is required (422, `fieldErrors.reason`). `GET /admin/users/:id` includes `professional.undoneLast30Days` and `undoneTotal`.
