import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { makeTestApp } from './helpers.js';

const SECRET = 'scheduler-secret-0123456789';
const withConfig = (ctx: Awaited<ReturnType<typeof makeTestApp>>, extra: Partial<typeof ctx.deps.config>) =>
  createApp({ ...ctx.deps, config: { ...ctx.deps.config, ...extra } });

describe('scheduled routes (external scheduler instead of in-process timers)', () => {
  it('refuse until CRON_SECRET is configured, and then without the exact bearer secret; a session is not enough', async () => {
    const ctx = await makeTestApp();
    expect((await request(ctx.app).post('/api/v1/scheduled/shift-recovery')).status).toBe(503);

    const app = withConfig(ctx, { cronSecret: SECRET });
    expect((await request(app).post('/api/v1/scheduled/shift-recovery')).status).toBe(401);
    expect((await request(app).post('/api/v1/scheduled/shift-recovery').set('Authorization', `Bearer ${SECRET}x`)).status).toBe(401);
    expect((await request(app).post('/api/v1/scheduled/match-retention').set('Authorization', `Bearer ${SECRET.slice(0, -1)}`)).status).toBe(401);
    const admin = await ctx.adminSession('ops@example.com', 'platform_super_admin');
    expect((await request(app).post('/api/v1/scheduled/match-retention').set('Cookie', admin.cookie)).status).toBe(401);
    // Not a browser flow: a GET must not run anything either.
    expect((await request(app).get('/api/v1/scheduled/shift-recovery').set('Authorization', `Bearer ${SECRET}`)).status).toBe(404);
  });

  it('run each pass with the secret, report what happened, and are idempotent', async () => {
    const ctx = await makeTestApp();
    const app = withConfig(ctx, { cronSecret: SECRET });
    const auth = (p: string) => request(app).post(`/api/v1/scheduled/${p}`).set('Authorization', `Bearer ${SECRET}`);

    const rec = await auth('shift-recovery');
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe('ran');
    expect(rec.body.summary).toBeTypeOf('object');
    expect((await auth('shift-recovery')).body.status).toBe('ran'); // the lease is released after each pass

    const ret = await auth('match-retention');
    expect(ret.status).toBe(200);
    expect(ret.body.status).toBe('ran');
    expect(ret.body.summary.runsDeleted).toBe(0);
    // A scheduled pass is recorded exactly like one from the timer.
    const rows = await ctx.db.query<{ mode: string }>(`SELECT mode FROM retention_runs ORDER BY started_at DESC LIMIT 1`);
    expect(rows[0]?.mode).toBe('scheduled');
  });

  it('honour the same off switches as the timers', async () => {
    const ctx = await makeTestApp();
    const app = withConfig(ctx, { cronSecret: SECRET, shiftRecoveryIntervalMinutes: 0, matchRetentionIntervalHours: 0 });
    const auth = (p: string) => request(app).post(`/api/v1/scheduled/${p}`).set('Authorization', `Bearer ${SECRET}`);
    expect((await auth('shift-recovery')).body).toEqual({ status: 'disabled' });
    expect((await auth('match-retention')).body).toEqual({ status: 'disabled' });
    expect((await ctx.db.query(`SELECT 1 FROM retention_runs`)).length).toBe(0);
  });
});

describe('deployment configuration', () => {
  const base = { NODE_ENV: 'test', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') } as NodeJS.ProcessEnv;

  it('allows the deployment hostnames Vercel sets, deduplicated, and nothing else by default', () => {
    expect(loadConfig(base).allowedOrigins).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    const c = loadConfig({ ...base, WEB_URL: 'https://app.example.com', ADMIN_URL: 'https://app.example.com/admin', VERCEL_URL: 'bsm-abc123.vercel.app', VERCEL_BRANCH_URL: 'bsm-git-main.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'app.example.com' });
    expect(c.allowedOrigins).toEqual(['https://app.example.com', 'https://bsm-abc123.vercel.app', 'https://bsm-git-main.vercel.app']);
  });

  it('treats an empty CRON_SECRET as unset, rejects a short one, and reads the scheduler switches', () => {
    expect(loadConfig({ ...base, CRON_SECRET: '' }).cronSecret).toBeUndefined();
    expect(() => loadConfig({ ...base, CRON_SECRET: 'short' })).toThrow();
    const c = loadConfig({ ...base, CRON_SECRET: SECRET, SHIFT_RECOVERY_INTERVAL_MINUTES: '0', MATCH_RETENTION_INTERVAL_HOURS: '12' });
    expect(c.cronSecret).toBe(SECRET);
    expect(c.shiftRecoveryIntervalMinutes).toBe(0);
    expect(c.matchRetentionIntervalHours).toBe(12);
    expect(loadConfig(base)).toMatchObject({ shiftRecoveryIntervalMinutes: 5, matchRetentionIntervalHours: 24 });
  });
});
