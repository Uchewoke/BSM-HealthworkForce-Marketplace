import { hash, verify } from '@node-rs/argon2';
import type { PlatformRole } from '@bsm/permissions';
import type { Queryable } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { base32Decode, base32Encode, decrypt, encrypt, newToken, sha256, verifyTotp } from '../../shared/crypto.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import type { AuthContext, CoreDeps } from '../../shared/deps.js';
import { randomBytes } from 'node:crypto';
import { audit } from '../audit/service.js';

const SESSION_TTL_MS = 7 * 24 * 3600_000;
const SESSION_IDLE_MS = 12 * 3600_000;
const TOKEN_TTL_MS = { email_verification: 24 * 3600_000, password_reset: 3600_000 } as const;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

interface UserRow {
  id: string; email: string; password_hash: string; full_name: string; email_verified_at: Date | null;
  platform_role: PlatformRole | null; status: string; failed_login_count: number; locked_until: Date | null;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password); // argon2id by default
}

export function createAuthService(deps: CoreDeps) {
  const { db, config, email } = deps;
  const now = deps.now ?? Date.now;
  const ipLimiter = new RateLimiter(30, 15 * 60_000, now);
  const accountLimiter = new RateLimiter(10, 15 * 60_000, now);
  const signupLimiter = new RateLimiter(10, 3600_000, now);
  // Verified against when the account does not exist so timing doesn't reveal it.
  const dummyHash = hashPassword('not-a-real-password-for-timing');

  async function issueToken(q: Queryable, userId: string, purpose: keyof typeof TOKEN_TTL_MS): Promise<string> {
    const token = newToken();
    await q.query('UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose]);
    await q.query('INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3,$4)',
      [sha256(token), userId, purpose, new Date(now() + TOKEN_TTL_MS[purpose])]);
    return token;
  }

  async function consumeToken(q: Queryable, token: string, purpose: keyof typeof TOKEN_TTL_MS): Promise<string> {
    const rows = await q.query<{ user_id: string }>(
      `UPDATE user_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3
       RETURNING user_id`, [sha256(token), purpose, new Date(now())]);
    if (!rows[0]) throw new AppError('BAD_REQUEST', 'This link is invalid or has expired.');
    return rows[0].user_id;
  }

  async function createUser(input: { email: string; password: string; fullName: string; platformRole?: PlatformRole; verified?: boolean }) {
    const passwordHash = await hashPassword(input.password);
    const rows = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, platform_role, email_verified_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.email, passwordHash, input.fullName, input.platformRole ?? null, input.verified ? new Date(now()) : null]);
    return rows[0]!.id;
  }

  return {
    createUser,

    /** Always behaves the same whether or not the address is already registered (no account enumeration). */
    async register(input: { email: string; password: string; fullName: string }, ip: string, requestId: string) {
      if (!signupLimiter.allow(`signup:${ip}`)) throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
      const existing = await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [input.email]);
      if (existing.length) {
        await audit(db, { action: 'auth.register_duplicate', requestId });
        return;
      }
      let userId: string;
      try { userId = await createUser(input); }
      catch (e: any) {
        if (e?.code === '23505' || /unique/i.test(e?.message ?? '')) return; // concurrent duplicate
        throw e;
      }
      const token = await issueToken(db, userId, 'email_verification');
      await audit(db, { actorUserId: userId, action: 'auth.register', targetType: 'user', targetId: userId, requestId });
      await email.send({ to: input.email, template: 'verify_email', token });
    },

    async verifyEmail(token: string, requestId: string) {
      const userId = await db.transaction(async (tx) => {
        const id = await consumeToken(tx, token, 'email_verification');
        await tx.query('UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1 AND email_verified_at IS NULL', [id]);
        return id;
      });
      await audit(db, { actorUserId: userId, action: 'auth.email_verified', targetType: 'user', targetId: userId, requestId });
    },

    async login(input: { email: string; password: string; totpCode?: string }, ip: string, requestId: string) {
      if (!ipLimiter.allow(`ip:${ip}`) || !accountLimiter.allow(`acct:${input.email}`)) {
        throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
      }
      const invalid = () => new AppError('UNAUTHENTICATED', 'Invalid email or password.');
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE lower(email) = $1', [input.email]))[0];
      if (!user) {
        await verify(await dummyHash, input.password).catch(() => false);
        await audit(db, { action: 'auth.login_failed', requestId, metadata: { reason: 'unknown_user' } });
        throw invalid();
      }
      if (user.locked_until && user.locked_until.getTime() > now()) {
        await audit(db, { actorUserId: user.id, action: 'auth.login_blocked_locked', requestId });
        throw new AppError('RATE_LIMITED', 'Account temporarily locked. Try again later.');
      }
      const ok = await verify(user.password_hash, input.password).catch(() => false);
      if (!ok || user.status !== 'active') {
        const failed = user.failed_login_count + 1;
        await db.query('UPDATE users SET failed_login_count = $2, locked_until = $3 WHERE id = $1',
          [user.id, failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED ? new Date(now() + LOCK_MS) : null]);
        await audit(db, { actorUserId: user.id, action: 'auth.login_failed', requestId });
        throw invalid();
      }
      if (!user.email_verified_at) throw new AppError('FORBIDDEN', 'Verify your email address before signing in.');

      const mfa = (await db.query<{ id: string; secret_enc: string; last_used_step: string }>(
        'SELECT id, secret_enc, last_used_step FROM mfa_methods WHERE user_id = $1 AND confirmed_at IS NOT NULL', [user.id]))[0];
      let mfaVerified = false;
      if (mfa) {
        if (!input.totpCode) throw new AppError('UNAUTHENTICATED', 'A verification code is required.', { mfaRequired: true });
        const step = verifyTotp(base32Decode(decrypt(config.mfaKey, mfa.secret_enc)), input.totpCode, now());
        if (step === null || step <= Number(mfa.last_used_step)) {
          await audit(db, { actorUserId: user.id, action: 'auth.mfa_failed', requestId });
          throw invalid();
        }
        await db.query('UPDATE mfa_methods SET last_used_step = $2 WHERE id = $1', [mfa.id, step]);
        mfaVerified = true;
      }

      await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
      const token = newToken();
      await db.query('INSERT INTO sessions (user_id, token_hash, mfa_verified, expires_at) VALUES ($1,$2,$3,$4)',
        [user.id, sha256(token), mfaVerified, new Date(now() + SESSION_TTL_MS)]);
      await audit(db, { actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, requestId, metadata: { mfa: mfaVerified } });
      return { token, maxAgeMs: SESSION_TTL_MS, user: { id: user.id, email: user.email, fullName: user.full_name } };
    },

    async authenticate(token: string): Promise<AuthContext | null> {
      const t = now();
      const row = (await db.query<{
        id: string; user_id: string; mfa_verified: boolean; last_seen_at: Date; email: string; platform_role: PlatformRole | null;
      }>(
        `SELECT s.id, s.user_id, s.mfa_verified, s.last_seen_at, u.email, u.platform_role
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'active'`,
        [sha256(token), new Date(t)]))[0];
      if (!row || t - row.last_seen_at.getTime() > SESSION_IDLE_MS) return null;
      if (t - row.last_seen_at.getTime() > 60_000) await db.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [row.id, new Date(t)]);
      return { userId: row.user_id, sessionId: row.id, email: row.email, platformRole: row.platform_role, mfaVerified: row.mfa_verified };
    },

    async logout(auth: AuthContext, requestId: string) {
      await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [auth.sessionId]);
      await audit(db, { actorUserId: auth.userId, action: 'auth.logout', requestId });
    },

    async forgotPassword(emailAddr: string, ip: string, requestId: string) {
      if (!signupLimiter.allow(`forgot:${ip}`)) throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
      const user = (await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1 AND status = \'active\'', [emailAddr]))[0];
      if (!user) return; // same response either way
      const token = await issueToken(db, user.id, 'password_reset');
      await audit(db, { actorUserId: user.id, action: 'auth.password_reset_requested', requestId });
      await email.send({ to: emailAddr, template: 'password_reset', token });
    },

    async resetPassword(token: string, password: string, requestId: string) {
      const passwordHash = await hashPassword(password);
      const userId = await db.transaction(async (tx) => {
        const id = await consumeToken(tx, token, 'password_reset');
        await tx.query('UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [id, passwordHash]);
        await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
        return id;
      });
      await audit(db, { actorUserId: userId, action: 'auth.password_reset', requestId });
    },

    async mfaSetup(auth: AuthContext, requestId: string) {
      const existing = await db.query('SELECT 1 FROM mfa_methods WHERE user_id = $1 AND confirmed_at IS NOT NULL', [auth.userId]);
      if (existing.length) throw new AppError('CONFLICT', 'MFA is already enabled.');
      const secret = randomBytes(20);
      await db.query(
        `INSERT INTO mfa_methods (user_id, type, secret_enc) VALUES ($1,'totp',$2)
         ON CONFLICT (user_id, type) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, last_used_step = 0`,
        [auth.userId, encrypt(config.mfaKey, base32Encode(secret))]);
      await audit(db, { actorUserId: auth.userId, action: 'auth.mfa_setup_started', requestId });
      const b32 = base32Encode(secret);
      return { secret: b32, otpauthUrl: `otpauth://totp/BSM%20HealthForce:${encodeURIComponent(auth.email)}?secret=${b32}&issuer=BSM%20HealthForce` };
    },

    async mfaConfirm(auth: AuthContext, code: string, requestId: string) {
      const mfa = (await db.query<{ id: string; secret_enc: string; confirmed_at: Date | null }>(
        'SELECT id, secret_enc, confirmed_at FROM mfa_methods WHERE user_id = $1', [auth.userId]))[0];
      if (!mfa || mfa.confirmed_at) throw new AppError('BAD_REQUEST', 'No MFA enrollment is pending.');
      const step = verifyTotp(base32Decode(decrypt(config.mfaKey, mfa.secret_enc)), code, now());
      if (step === null) throw new AppError('BAD_REQUEST', 'That code is not valid.');
      await db.transaction(async (tx) => {
        await tx.query('UPDATE mfa_methods SET confirmed_at = now(), last_used_step = $2 WHERE id = $1', [mfa.id, step]);
        await tx.query('UPDATE sessions SET mfa_verified = true WHERE id = $1', [auth.sessionId]);
      });
      await audit(db, { actorUserId: auth.userId, action: 'auth.mfa_enabled', requestId });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
