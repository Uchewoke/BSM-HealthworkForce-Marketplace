import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totpCode, totpStep } from '../src/shared/crypto.js';
import { makeTestApp, PASSWORD } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
beforeAll(async () => { ctx = await makeTestApp(); });

describe('registration and email verification', () => {
  it('registers, requires verification before sign-in, then signs in', async () => {
    const email = 'new.user@example.com';
    const reg = await api().post('/api/v1/auth/register').send({ email, password: PASSWORD, fullName: 'New User' });
    expect(reg.status).toBe(202);

    const early = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(early.status).toBe(403);

    const msg = ctx.email.last(email, 'verify_email')!;
    expect(msg).toBeTruthy();
    expect((await api().post('/api/v1/auth/verify-email').send({ token: msg.token })).status).toBe(200);
    expect((await api().post('/api/v1/auth/verify-email').send({ token: msg.token })).status).toBe(400); // single use

    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it('does not reveal whether an address is already registered', async () => {
    const email = 'dupe@example.com';
    await ctx.svc.createUser({ email, password: PASSWORD, fullName: 'Dupe', verified: true });
    const before = ctx.email.messages.length;
    const res = await api().post('/api/v1/auth/register').send({ email, password: PASSWORD, fullName: 'Dupe' });
    expect(res.status).toBe(202);
    expect(ctx.email.messages.length).toBe(before);
  });

  it('rejects weak passwords and malformed email', async () => {
    expect((await api().post('/api/v1/auth/register').send({ email: 'a@example.com', password: 'short', fullName: 'A' })).status).toBe(422);
    expect((await api().post('/api/v1/auth/register').send({ email: 'nope', password: PASSWORD, fullName: 'A' })).status).toBe(422);
  });

  it('stores only a hash of the password', async () => {
    const rows = await ctx.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', ['dupe@example.com']);
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]!.password_hash).not.toContain(PASSWORD);
  });
});

describe('login, sessions, lockout', () => {
  it('gives the same error for wrong password and unknown user', async () => {
    await ctx.svc.createUser({ email: 'real@example.com', password: PASSWORD, fullName: 'Real', verified: true });
    const wrong = await api().post('/api/v1/auth/login').send({ email: 'real@example.com', password: 'wrong-password-123' });
    const unknown = await api().post('/api/v1/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    await ctx.svc.createUser({ email: 'lock@example.com', password: PASSWORD, fullName: 'Lock', verified: true });
    for (let i = 0; i < 5; i++) {
      expect((await api().post('/api/v1/auth/login').send({ email: 'lock@example.com', password: 'bad-password-xyz' })).status).toBe(401);
    }
    const res = await api().post('/api/v1/auth/login').send({ email: 'lock@example.com', password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('logout revokes the session; /me requires a session', async () => {
    const { cookie } = await ctx.userWithSession('session@example.com');
    expect((await api().get('/api/v1/auth/me').set('Cookie', cookie)).body.user.email).toBe('session@example.com');
    expect((await api().post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await api().get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
  });

  it('blocks cross-origin state-changing requests', async () => {
    const res = await api().post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ email: 'x@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('password reset', () => {
  it('resets the password, revokes existing sessions, and tokens are single use', async () => {
    const email = 'reset@example.com';
    const { cookie } = await ctx.userWithSession(email);
    expect((await api().post('/api/v1/auth/password/forgot').send({ email })).status).toBe(202);
    expect((await api().post('/api/v1/auth/password/forgot').send({ email: 'nobody@example.com' })).status).toBe(202);
    const token = ctx.email.last(email, 'password_reset')!.token;

    const newPassword = 'another long passphrase 42';
    expect((await api().post('/api/v1/auth/password/reset').send({ token, password: newPassword })).status).toBe(200);
    expect((await api().post('/api/v1/auth/password/reset').send({ token, password: newPassword })).status).toBe(400);
    expect((await api().get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email, password: newPassword })).status).toBe(200);
  });
});

describe('MFA for platform roles', () => {
  it('requires a verified MFA session for admin endpoints and blocks code replay', async () => {
    const email = 'admin@example.com';
    const { cookie } = await ctx.userWithSession(email, 'platform_admin');
    const lookup = () => api().get('/api/v1/admin/users/lookup').query({ email: 'real@example.com' }).set('Cookie', cookie);

    const blocked = await lookup();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ mfaRequired: true });

    const setup = await api().post('/api/v1/auth/mfa/setup').set('Cookie', cookie);
    expect(setup.status).toBe(200);
    const secret = base32Decode(setup.body.secret);
    const step = totpStep(Date.now());
    expect((await api().post('/api/v1/auth/mfa/confirm').set('Cookie', cookie).send({ code: '000000' })).status).toBe(400);
    expect((await api().post('/api/v1/auth/mfa/confirm').set('Cookie', cookie).send({ code: totpCode(secret, step) })).status).toBe(200);
    expect((await lookup()).status).toBe(200);

    // Fresh login needs a code; the code just used cannot be replayed.
    const noCode = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.details).toMatchObject({ mfaRequired: true });
    const replay = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD, totpCode: totpCode(secret, step) });
    expect(replay.status).toBe(401);
    const next = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD, totpCode: totpCode(secret, step + 1) });
    expect(next.status).toBe(200);
  });

  it('stores the MFA secret encrypted, not in clear', async () => {
    const [row] = await ctx.db.query<{ secret_enc: string }>('SELECT secret_enc FROM mfa_methods LIMIT 1');
    expect(row!.secret_enc).not.toMatch(/^[A-Z2-7]{32}$/);
  });
});
