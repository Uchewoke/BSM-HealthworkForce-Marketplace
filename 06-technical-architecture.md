# 06 — Recommended Technical Architecture

Keep the existing platform architecture unless the repository has changed materially.

| Component | Recommended technology |
|---|---|
| Facility and professional portals | Next.js and React |
| Administrative portal | Next.js and React |
| Backend API | Express with TypeScript |
| Primary database | PostgreSQL |
| Background jobs | Queue-based processing |
| Document storage | Secure object storage |
| Authentication and authorization | Role-based and organization-based access controls |
| Notifications | Email and optional SMS |
| Matching engine | Rules-based eligibility checks plus weighted ranking |
| AI assistance | Natural-language search and workflow assistance |
| Monitoring | Centralized logging, error monitoring and audit trails |

## Architecture Style: Modular Monolith

Start with a **modular monolith** instead of unnecessary microservices. The first release is easier to build, test, deploy and maintain that way. Module boundaries follow the five core components (see [02](02-core-components.md)), so modules can be split out later if needed.

## Security, Privacy and Compliance

- Address healthcare-related security, privacy and contractual requirements from the start.
- **HIPAA applicability depends on the data handled and the parties' roles.** Not every workforce record is protected health information.
- Keep audit logs on credential reviews, placements and administrative actions.
- A nationwide launch means multi-state licensing data and jurisdiction-aware verification are part of the core data model.
