import type { RequestHandler } from 'express';
import { orgRoleCan, platformRoleCan, type Permission } from '@bsm/permissions';
import { z } from 'zod';
import type { AuthService } from '../modules/auth/service.js';
import type { AppDeps } from '../shared/deps.js';
import { AppError } from '../shared/errors.js';

export const SESSION_COOKIE = 'bsm_session';

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** CSRF defence: browsers always send Origin on cross-site state-changing requests. */
export const originCheck = (allowed: string[]): RequestHandler => (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.includes(origin)) return next(new AppError('FORBIDDEN', 'Cross-origin request blocked.'));
  }
  next();
};

export const requireAuth = (auth: AuthService): RequestHandler => async (req, _res, next) => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const ctx = token ? await auth.authenticate(token) : null;
  if (!ctx) return next(new AppError('UNAUTHENTICATED', 'Authentication required.'));
  req.auth = ctx;
  next();
};

const orgIdParam = z.uuid();

/**
 * Tenant isolation: membership is looked up server-side from the session user and the :orgId path param.
 * Non-members get 404 so another organization's existence is not revealed; members lacking the permission get 403.
 */
export const requireOrgPermission = (deps: AppDeps, permission: Permission): RequestHandler => async (req, _res, next) => {
  const parsed = orgIdParam.safeParse(req.params.orgId);
  if (!parsed.success) return next(new AppError('VALIDATION_FAILED', 'Invalid organization id.'));
  const rows = await deps.db.query<{ role: string }>(
    `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`,
    [parsed.data, req.auth!.userId]);
  const m = rows[0];
  if (!m) return next(new AppError('NOT_FOUND', 'Resource not found.'));
  if (!orgRoleCan(m.role, permission)) return next(new AppError('FORBIDDEN', 'You do not have permission to perform this action.'));
  req.membership = { organizationId: parsed.data, role: m.role };
  next();
};

/** Restricted marketplace functions are only available to organizations BSM has approved. Run after requireOrgPermission. */
export const requireApprovedOrg = (deps: AppDeps): RequestHandler => async (req, _res, next) => {
  const [o] = await deps.db.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1', [req.membership!.organizationId]);
  if (o?.status !== 'approved') {
    return next(new AppError('FORBIDDEN', 'Your organization must be approved before using this feature.', { organizationStatus: o?.status }));
  }
  next();
};

/** Any platform role, with a verified MFA session. Callers then filter what each role may see. */
export const requirePlatformMember: RequestHandler = (req, _res, next) => {
  const a = req.auth!;
  if (!a.platformRole) return next(new AppError('FORBIDDEN', 'You do not have permission to perform this action.'));
  if (!a.mfaVerified) return next(new AppError('FORBIDDEN', 'Multi-factor authentication is required.', { mfaRequired: true }));
  next();
};

/** Platform access is explicit, requires a verified MFA session, and never derives from organization roles. */
export const requirePlatformPermission = (permission: Permission): RequestHandler => (req, _res, next) => {
  const a = req.auth!;
  if (!a.platformRole || !platformRoleCan(a.platformRole, permission)) {
    return next(new AppError('FORBIDDEN', 'You do not have permission to perform this action.'));
  }
  if (!a.mfaVerified) return next(new AppError('FORBIDDEN', 'Multi-factor authentication is required.', { mfaRequired: true }));
  next();
};
