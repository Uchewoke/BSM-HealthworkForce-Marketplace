import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { DevConsoleEmailSender, ResendEmailSender } from '../src/integrations/email.js';
import { ClamAvScanner, NotConfiguredScanner } from '../src/integrations/malware.js';
import { LocalFsStorage, S3PrivateStorage } from '../src/integrations/storage.js';
import { createRuntimeDeps } from '../src/runtime.js';
import type { Db } from '../src/db/index.js';

const keys = () => ({ MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'), FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
const db = {} as Db; // never touched by createRuntimeDeps
const fullProduction = {
  EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'BSM <no-reply@example.com>', RESEND_API_KEY: 're_x',
  STORAGE_BUCKET: 'bsm-private', STORAGE_REGION: 'us-east-1', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_SECRET_ACCESS_KEY: 's',
  UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't',
};

describe('runtime wiring', () => {
  it('in production, refuses to start until email, storage and a shared rate-limit store are configured, naming each', () => {
    const config = loadConfig({ NODE_ENV: 'production', WEB_URL: 'https://app.example.com', ADMIN_URL: 'https://app.example.com/admin', ...keys() } as NodeJS.ProcessEnv);
    expect(() => createRuntimeDeps(config, db, {})).toThrow(/EMAIL_PROVIDER[\s\S]*STORAGE_BUCKET[\s\S]*UPSTASH_REDIS_REST_URL/);
    expect(() => createRuntimeDeps(config, db, { EMAIL_PROVIDER: 'console' })).toThrow(/production/);
    expect(() => createRuntimeDeps(config, db, { ...fullProduction, STORAGE_BUCKET: '' })).toThrow(/STORAGE_BUCKET/);
  });

  it('in production with everything set, wires the real adapters and never the development ones', () => {
    const config = loadConfig({ NODE_ENV: 'production', WEB_URL: 'https://app.example.com', ADMIN_URL: 'https://app.example.com/admin', ...keys() } as NodeJS.ProcessEnv);
    const deps = createRuntimeDeps(config, db, { ...fullProduction, CLAMAV_HOST: 'clamd.internal' });
    expect(deps.email).toBeInstanceOf(ResendEmailSender);
    expect(deps.storage).toBeInstanceOf(S3PrivateStorage);
    expect(deps.scanner).toBeInstanceOf(ClamAvScanner);
    expect(deps.limits).toBeDefined();
    expect(deps.assistant.configured).toBe(false);
  });

  it('in production, allows the per-process limiter only when asked for explicitly (single long-running server)', () => {
    const config = loadConfig({ NODE_ENV: 'production', WEB_URL: 'https://app.example.com', ADMIN_URL: 'https://app.example.com/admin', ...keys() } as NodeJS.ProcessEnv);
    const { UPSTASH_REDIS_REST_URL: _u, UPSTASH_REDIS_REST_TOKEN: _t, ...noRedis } = fullProduction;
    const deps = createRuntimeDeps(config, db, { ...noRedis, RATE_LIMIT_STORE: 'memory' });
    expect(deps.limits).toBeUndefined();
    expect(deps.scanner).toBeInstanceOf(NotConfiguredScanner);
  });

  it('in development, falls back to the console sender and local disk with no settings at all', () => {
    const config = loadConfig({ NODE_ENV: 'development', ...keys() } as NodeJS.ProcessEnv);
    const deps = createRuntimeDeps(config, db, {});
    expect(deps.email).toBeInstanceOf(DevConsoleEmailSender);
    expect(deps.storage).toBeInstanceOf(LocalFsStorage);
    expect(deps.limits).toBeUndefined();
  });

  it('refuses local-disk storage in production even if constructed directly', () => {
    expect(() => new LocalFsStorage('./x', 'production')).toThrow(/production/);
  });
});
