import { Router } from 'express';
import { SESSION_COOKIE, readCookie, requireAuth } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { createAuthService, type AuthService } from './service.js';
import { forgotBody, loginBody, mfaConfirmBody, registerBody, resetBody, verifyEmailBody } from './schemas.js';

export function authRoutes(deps: AppDeps, auth: AuthService = createAuthService(deps)) {
  const r = Router();
  const needAuth = requireAuth(auth);
  const ip = (req: { ip?: string }) => req.ip ?? 'unknown';

  r.post('/register', validate({ body: registerBody }), async (req, res) => {
    await auth.register(req.body, ip(req), req.requestId);
    res.status(202).json({ message: 'If this address can be registered, a verification email will be sent.' });
  });

  r.post('/verify-email', validate({ body: verifyEmailBody }), async (req, res) => {
    await auth.verifyEmail(req.body.token, req.requestId);
    res.json({ message: 'Email verified.' });
  });

  r.post('/login', validate({ body: loginBody }), async (req, res) => {
    const out = await auth.login(req.body, ip(req), req.requestId);
    res.cookie(SESSION_COOKIE, out.token, {
      httpOnly: true, secure: deps.config.cookieSecure, sameSite: 'lax', path: '/', maxAge: out.maxAgeMs,
    });
    res.json({ user: out.user });
  });

  r.post('/logout', needAuth, async (req, res) => {
    await auth.logout(req.auth!, req.requestId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  r.get('/me', needAuth, (req, res) => {
    const { userId, email, platformRole, mfaVerified } = req.auth!;
    res.json({ user: { id: userId, email, platformRole, mfaVerified } });
  });

  r.post('/password/forgot', validate({ body: forgotBody }), async (req, res) => {
    await auth.forgotPassword(req.body.email, ip(req), req.requestId);
    res.status(202).json({ message: 'If an account exists for this address, a reset email will be sent.' });
  });

  r.post('/password/reset', validate({ body: resetBody }), async (req, res) => {
    await auth.resetPassword(req.body.token, req.body.password, req.requestId);
    res.json({ message: 'Password updated. Please sign in again.' });
  });

  r.post('/mfa/setup', needAuth, async (req, res) => {
    res.json(await auth.mfaSetup(req.auth!, req.requestId));
  });

  r.post('/mfa/confirm', needAuth, validate({ body: mfaConfirmBody }), async (req, res) => {
    await auth.mfaConfirm(req.auth!, req.body.code, req.requestId);
    res.json({ message: 'Multi-factor authentication enabled.' });
  });

  return { router: r, auth, readCookie };
}
