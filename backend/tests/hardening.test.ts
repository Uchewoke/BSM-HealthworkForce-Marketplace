import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPgliteDb, migrate } from '../src/db/index.js';
import { createLogger } from '../src/shared/logger.js';
import { makeTestApp, PASSWORD } from './helpers.js';

const WEB = 'http://localhost:3000';

describe('response headers, CORS and cookies', () => {
  it('sets API security headers, and HSTS plus Secure cookies in production mode', async () => {
    const ctx = await makeTestApp();
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined(); // not in dev/test

    await ctx.svc.createUser({ email: 'prod@example.com', password: PASSWORD, fullName: 'Prod', verified: true });
    const prod = createApp({ ...ctx.deps, config: { ...ctx.deps.config, nodeEnv: 'production', cookieSecure: true } });
    const login = await request(prod).post('/api/v1/auth/login').send({ email: 'prod@example.com', password: PASSWORD });
    expect(login.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(login.body)).not.toContain(cookie.split(';')[0]!.split('=')[1]!); // session token is never in the body
  });

  it('allows credentialed CORS only for the web and admin origins', async () => {
    const ctx = await makeTestApp();
    const ok = await request(ctx.app).options('/api/v1/auth/login').set('Origin', WEB).set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(WEB);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['access-control-allow-methods']).toContain('PATCH');
    expect(ok.headers['vary']).toMatch(/Origin/);
    expect((await request(ctx.app).get('/api/v1/health').set('Origin', 'http://localhost:3001')).headers['access-control-allow-origin']).toBe('http://localhost:3001');

    const evil = await request(ctx.app).options('/api/v1/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.status).toBe(204);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(evil.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await request(ctx.app).get('/api/v1/health').set('Origin', 'https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(ctx.app).post('/api/v1/auth/logout').set('Origin', 'https://evil.example')).status).toBe(403); // CSRF guard
  });
});

describe('abuse protection and availability', () => {
  it('rate limits per IP across the whole API with the standard error shape', async () => {
    const ctx = await makeTestApp({ globalLimit: { max: 5, windowMs: 60_000 } });
    for (let i = 0; i < 5; i++) expect((await request(ctx.app).get('/api/v1/health')).status).toBe(200);
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: 'RATE_LIMITED', requestId: res.headers['x-request-id'] });
  });

  it('reports not-ready when the database is unreachable, without leaking details', async () => {
    const ctx = await makeTestApp();
    const down = createApp({ ...ctx.deps, db: { ...ctx.db, query: async () => { throw new Error('connection refused to 10.0.0.5:5432'); } } });
    const res = await request(down).get('/api/v1/ready');
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.5|refused/);
    expect((await request(down).get('/api/v1/health')).status).toBe(200); // liveness is independent of the database
  });
});

describe('every protected endpoint rejects anonymous callers', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  const routes: [string, string][] = [
    ['get', '/auth/me'], ['post', '/auth/logout'], ['post', '/auth/mfa/setup'], ['post', '/auth/mfa/confirm'],
    ['get', '/organizations'], ['post', '/organizations'], ['get', `/organizations/${ID}`], ['patch', `/organizations/${ID}`], ['post', `/organizations/${ID}/submit`],
    ['get', `/organizations/${ID}/members`], ['post', `/organizations/${ID}/invitations`], ['get', `/organizations/${ID}/facilities`],
    ['get', `/organizations/${ID}/jobs`], ['post', `/organizations/${ID}/jobs`], ['get', `/organizations/${ID}/applications`], ['get', `/organizations/${ID}/jobs/${ID}/candidates`],
    ['post', '/invitations/accept'], ['post', '/professionals'], ['get', '/professionals/me'], ['get', '/professionals/me/credentials'],
    ['post', `/professionals/me/credentials/${ID}/documents`], ['get', '/professionals/me/applications'], ['get', '/taxonomies/professions'],
    ['get', '/jobs'], ['get', `/jobs/${ID}`], ['post', `/jobs/${ID}/apply`], ['get', '/credential-documents/download?token=x'],
    ['get', '/notifications'], ['put', '/notifications/preferences'], ['get', '/support/tickets'], ['post', '/support/tickets'],
    ['get', '/admin/dashboard'], ['get', '/admin/audit-logs'], ['get', '/admin/users?q=ab'], ['get', `/admin/users/${ID}`], ['get', '/admin/users/lookup?email=a@b.co'],
    ['get', '/admin/organizations'], ['get', `/admin/organizations/${ID}`], ['post', `/admin/organizations/${ID}/status`], ['get', '/admin/credentials'], ['post', `/admin/credentials/${ID}/status`],
    ['get', '/admin/jobs'], ['get', '/admin/states'], ['put', '/admin/states/GA'], ['get', '/admin/metrics'], ['get', '/admin/settings/ranking-weights'],
    ['post', '/admin/taxonomies/professions'], ['get', '/admin/support/tickets'],
  ];
  it.each(routes)('%s /api/v1%s → 401', async (method, path) => {
    const ctx = shared ?? (shared = await makeTestApp());
    const res = await (request(ctx.app) as any)[method](`/api/v1${path}`).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
let shared: Awaited<ReturnType<typeof makeTestApp>> | undefined;

describe('logging never contains secrets or private content', () => {
  it('keeps passwords, tokens, cookies, TOTP secrets, credential numbers, document bytes and search terms out of logs', async () => {
    let logs = '';
    process.env.LOG_LEVEL = 'info';
    const logger = createLogger(new Writable({ write(chunk, _enc, cb) { logs += chunk.toString(); cb(); } }));
    delete process.env.LOG_LEVEL;
    const ctx = await makeTestApp({ logger });
    const api = () => request(ctx.app);
    const secrets: string[] = [];

    // register → verify → login → reset password
    const pw1 = 'Sup3r-Secret-Passphrase-123', pw2 = 'Another-Secret-Phrase-456';
    await api().post('/api/v1/auth/register').send({ email: 'logs@example.com', password: pw1, fullName: 'Log Check' });
    const verify = ctx.email.last('logs@example.com', 'verify_email')!.token!;
    await api().post('/api/v1/auth/verify-email').send({ token: verify });
    const login = await api().post('/api/v1/auth/login').send({ email: 'logs@example.com', password: pw1 });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    await api().post('/api/v1/auth/password/forgot').send({ email: 'logs@example.com' });
    const reset = ctx.email.last('logs@example.com', 'password_reset')!.token!;
    await api().post('/api/v1/auth/password/reset').send({ token: reset, password: pw2 });
    const login2 = await api().post('/api/v1/auth/login').send({ email: 'logs@example.com', password: pw2 });
    const cookie2 = (login2.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const mfa = await api().post('/api/v1/auth/mfa/setup').set('Cookie', cookie2);
    secrets.push(pw1, pw2, verify, reset, cookie.split('=')[1]!, cookie2.split('=')[1]!, mfa.body.secret);

    // credential number and document upload, secure download link, search term
    const rn = (await api().get('/api/v1/taxonomies/professions').set('Cookie', cookie2)).body.professions.find((p: any) => p.code === 'rn').id;
    await api().post('/api/v1/professionals').set('Cookie', cookie2).send({ professionId: rn });
    const cred = (await api().post('/api/v1/professionals/me/credentials').set('Cookie', cookie2).send({ kind: 'license', credentialType: 'RN', jurisdiction: 'GA', number: 'RN-SECRET-998877' })).body.credential;
    const pdf = Buffer.from('%PDF-1.4\nSECRET-DOC-CONTENT-XYZ\n');
    const up = await api().post(`/api/v1/professionals/me/credentials/${cred.id}/documents`).set('Cookie', cookie2).set('Content-Type', 'application/pdf').send(pdf);
    const link = (await api().post(`/api/v1/professionals/me/credentials/${cred.id}/documents/${up.body.document.id}/access`).set('Cookie', cookie2)).body.url as string;
    await api().get(link).set('Cookie', cookie2);
    await api().get('/api/v1/jobs?q=confidential-search-term').set('Cookie', cookie2);
    secrets.push('RN-SECRET-998877', 'SECRET-DOC-CONTENT-XYZ', link.split('token=')[1]!, 'confidential-search-term');

    for (const s of secrets) expect(logs, `log contains ${s.slice(0, 12)}…`).not.toContain(s);
    expect(logs).not.toMatch(/cookie|authorization/i);
    // ...but the logs are still useful: structured, with route patterns, status codes, request ids and user ids.
    const lines = logs.trim().split('\n').map((l) => JSON.parse(l));
    const loginLine = lines.find((l) => l.route === '/api/v1/auth/login' && l.status === 200);
    expect(loginLine).toMatchObject({ method: 'POST', msg: 'request' });
    expect(loginLine.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.some((l) => l.userId && l.route === '/api/v1/professionals/me/credentials/:id/documents')).toBe(true);
    expect(lines.every((l) => !('body' in l) && !('query' in l) && !('headers' in l))).toBe(true);
  });
});

describe('backup and restore (embedded database)', () => {
  it('a dumped data directory restores with schema, data, constraints and sign-in intact', async () => {
    const source = await createPgliteDb();
    const a = await makeTestApp({ db: source });
    const user = await a.userWithSession('backup@example.com');
    const org = (await request(a.app).post('/api/v1/organizations').set('Cookie', user.cookie).send({ name: 'Backup Org', type: 'facility' })).body.organization.id;
    const counts = async (db: typeof source) => Object.fromEntries(await Promise.all(['users', 'organizations', 'organization_members', 'audit_logs', 'schema_migrations'].map(
      async (t) => [t, Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`))[0]!.n)] as const)));
    const before = await counts(source);

    const snapshot = await source.dump!();
    await source.close();
    const restored = await createPgliteDb(undefined, snapshot);
    expect(await migrate(restored)).toEqual([]); // the migration ledger came back: nothing to re-apply
    expect(await counts(restored)).toEqual(before);

    await expect(restored.query('UPDATE audit_logs SET action = $1', ['tampered'])).rejects.toThrow(/append-only/); // trigger survived
    await expect(restored.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, gen_random_uuid(), 'read_only')`, [org])).rejects.toThrow(); // FKs survived

    const b = await makeTestApp({ db: restored });
    const login = await request(b.app).post('/api/v1/auth/login').send({ email: 'backup@example.com', password: PASSWORD });
    expect(login.status).toBe(200); // password hashes restored
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    expect((await request(b.app).get(`/api/v1/organizations/${org}`).set('Cookie', cookie)).body.organization.name).toBe('Backup Org');
  });
});
