import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createPgliteDb, migrate, type Db } from '../src/db/index.js';
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

export async function makeTestApp(opts: Pick<AppDeps, 'logger' | 'globalLimit'> & { db?: Db; assistant?: AssistantProvider } = {}) {
  const db = opts.db ?? await createPgliteDb();
  await migrate(db);
  const email = new OutboxEmailSender();
  const storage = new MemoryStorage();
  const config = loadConfig({
    NODE_ENV: 'test',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  } as NodeJS.ProcessEnv);
  const deps: AppDeps = { db, config, email, storage, scanner: new StubScanner(), assistant: opts.assistant ?? new NotConfiguredAssistant(), logger: opts.logger, globalLimit: opts.globalLimit };
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
