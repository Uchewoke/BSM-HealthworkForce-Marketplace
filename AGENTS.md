# AGENTS.md

Rules for coding agents on BSM HealthForce Marketplace.

- Inspect before changing; no broad refactors or major upgrades without a documented reason.
- Modular monolith: `backend/src/modules/<domain>`; thin controllers, business rules in services.
- Authorization is server-side only; check org membership for every org-owned record. Never trust a client `organizationId`.
- Never fake verification, payments or integrations; unconfigured providers return pending/manual states.
- Eligibility rules are never overridden by ranking or AI.
- Validate every input with shared zod schemas; consistent error shape `{ error: { code, message, requestId } }`.
- Never log passwords, tokens or document contents.
- Schema changes via migrations only. Ask before destructive actions.
- Before finishing a task run: lint, typecheck, test, build (whatever exists) and report failures honestly.
- Record unresolved product/legal decisions in `ASSUMPTIONS.md`; update `CHANGELOG.md` and docs.

Commands (once scaffolded): `npm run typecheck`, `npm test`, `npm run build`.
