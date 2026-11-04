import { randomBytes } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createPgDb, createPgliteDb, migrate, type Db } from '../src/db/index.js';
import { NotConfiguredAssistant, type AssistantProvider } from '../src/integrations/assistant.js';
import { OutboxEmailSender } from '../src/integrations/email.js';
import type { MalwareScanner } from '../src/integrations/malware.js';
import { MemoryStorage } from '../src/integrations/storage.js';
import { createAuthService } from '../src/modules/auth/service.js';
import { base32Decode, totpCode, totpStep } from '../src/shared/crypto.js';
import type { AppDeps } from '../src/shared/deps.js';
import type { PlatformRole } from '@bsm/permissions';

export const PASSWORD = 'correct horse battery staple';

/** Flags any file containing the marker as infected; never claims anything is clean. */
export class StubScanner implements MalwareScanner {
  async scan(bytes: Buffer) { return bytes.includes('EICAR-TEST') ? ('infected' as const) : ('not_scanned' as const); }
}

/**
 * The embedded database by default. With TEST_DATABASE_URL set (a server where the user may create databases), every call gets its
 * own freshly created schema on that real PostgreSQL server, so the same tests also prove behaviour on the production engine.
 */
export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();
  // A schema per app, not a database: creating a database forces a checkpoint, which is very slow when several test files start
  // at once. The connection's search_path points at the new schema, so the migrations land there and tests cannot see each other.
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  const u = new URL(url); u.searchParams.set('options', `-c search_path=${name}`);
  return createPgDb(u.toString());
}

export async function makeTestApp(opts: Pick<AppDeps, 'logger' | 'globalLimit' | 'billing' | 'now'> & { db?: Db; assistant?: AssistantProvider; billingEnabled?: boolean } = {}) {
  const db = opts.db ?? await freshDb();
  await migrate(db);
  const email = new OutboxEmailSender();
  const storage = new MemoryStorage();
  const config = loadConfig({
    NODE_ENV: 'test',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ...(opts.billingEnabled ? { BILLING_SUBSCRIPTIONS_ENABLED: 'true' } : {}),
  } as NodeJS.ProcessEnv);
  const deps: AppDeps = { db, config, email, storage, scanner: new StubScanner(), assistant: opts.assistant ?? new NotConfiguredAssistant(), logger: opts.logger, globalLimit: opts.globalLimit, billing: opts.billing, now: opts.now };
  const app = createApp(deps);
  const svc = createAuthService(deps);

  /** Creates a verified user directly (bypasses signup rate limits) and signs in; returns the session cookie. */
  async function userWithSession(address: string, platformRole?: PlatformRole) {
    const id = await svc.createUser({ email: address, password: PASSWORD, fullName: 'Test User', platformRole, verified: true });
    const res = await request(app).post('/api/v1/auth/login').send({ email: address, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return { id, cookie };
  }

  /** Platform user with MFA enrolled and verified on the returned session. */
  async function adminSession(address: string, role: PlatformRole = 'platform_admin') {
    const s = await userWithSession(address, role);
    const setup = await request(app).post('/api/v1/auth/mfa/setup').set('Cookie', s.cookie);
    const code = totpCode(base32Decode(setup.body.secret), totpStep(Date.now()));
    const ok = await request(app).post('/api/v1/auth/mfa/confirm').set('Cookie', s.cookie).send({ code });
    if (ok.status !== 200) throw new Error('mfa confirm failed');
    return s;
  }

  return { app, db, email, storage, deps, svc, userWithSession, adminSession };
}
