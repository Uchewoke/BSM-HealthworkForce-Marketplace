# Backend

Prerequisites: Node 22+ (developed on 24). Docker/Postgres optional: without `DATABASE_URL`, development uses embedded PGlite in `backend/.data`.

```bash
npm install                                   # from the repo root
cp ../.env.example .env                       # then set MFA_ENCRYPTION_KEY (openssl rand -base64 32)
npm run migrate -w backend
npm run dev -w backend                        # http://localhost:4000/api/v1/health
npm run typecheck && npm test                 # per package if root scripts hang on Windows
```

First platform admin (never seed a default password):

```bash
BSM_ADMIN_PASSWORD='<12+ chars>' npm run create-admin -w backend -- you@example.com "Your Name" platform_super_admin
```

Sign in, then `POST /api/v1/auth/mfa/setup` and `/mfa/confirm`; admin endpoints stay blocked until MFA is verified.

In development, verification/reset links are printed to the terminal (`[DEV EMAIL - not delivered]`); nothing is actually emailed.
