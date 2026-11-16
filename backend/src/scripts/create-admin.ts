/**
 * Creates a platform user. Usage:
 *   BSM_ADMIN_PASSWORD='<12+ chars>' npm run create-admin -w backend -- you@example.com "Full Name" platform_super_admin
 * The password comes from the environment so it never lands in shell history or process args.
 * MFA must be enrolled at first sign-in before any admin endpoint works.
 */
import { PLATFORM_ROLES, type PlatformRole } from '@bsm/permissions';
import { loadConfig } from '../config/env.js';
import { createPgDb, createPgliteDb, migrate } from '../db/index.js';
import type { EmailSender } from '../integrations/email.js';
import { createAuthService } from '../modules/auth/service.js';
import { emailSchema, passwordSchema } from '../modules/auth/schemas.js';

const [rawEmail, fullName, role] = process.argv.slice(2);
if (!rawEmail || !fullName || !PLATFORM_ROLES.includes(role as PlatformRole)) {
  console.error(`Usage: create-admin <email> "<full name>" <${PLATFORM_ROLES.join('|')}>`);
  process.exit(1);
}
const password = passwordSchema.parse(process.env.BSM_ADMIN_PASSWORD);
const config = loadConfig();
const db = process.env.DATABASE_URL ? createPgDb(process.env.DATABASE_URL) : await createPgliteDb('./.data/pglite');
await migrate(db);
// This script never sends mail (the account is created verified), so no provider is needed, in production either.
const noMail: EmailSender = { send: async () => ({ status: 'not_delivered' as const }) };
const svc = createAuthService({ db, config, email: noMail });
const id = await svc.createUser({ email: emailSchema.parse(rawEmail), password, fullName, platformRole: role as PlatformRole, verified: true });
console.log(`Created ${role} ${id}. Sign in and enroll MFA (POST /api/v1/auth/mfa/setup).`);
await db.close();
