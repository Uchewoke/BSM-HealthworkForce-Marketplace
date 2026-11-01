import { Router, type RequestHandler } from 'express';
import { AGENCY_ROLES, canGrantRole, FACILITY_ROLES } from '@bsm/permissions';
import { z } from 'zod';
import { requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import { newToken, sha256 } from '../../shared/crypto.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import { emailSchema } from '../auth/schemas.js';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const inviteBody = z.object({ email: emailSchema, role: z.enum([...FACILITY_ROLES, ...AGENCY_ROLES]).exclude(['facility_owner', 'agency_owner']) });
const orgParams = z.object({ orgId: z.uuid() });
const inviteParams = z.object({ orgId: z.uuid(), invitationId: z.uuid() });
const acceptBody = z.object({ token: z.string().min(20).max(200) });

/** Org-scoped invitation management, mounted at /organizations/:orgId/invitations. */
export function invitationRoutes(deps: AppDeps) {
  const { db, email } = deps;
  const now = deps.now ?? Date.now;
  const r = Router({ mergeParams: true });

  r.get('/', validate({ params: orgParams }), requireOrgPermission(deps, 'members.invite'), async (req, res) => {
    const rows = await db.query(
      `SELECT id, email, role, expires_at, created_at FROM organization_invitations
        WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at DESC`,
      [req.membership!.organizationId, new Date(now())]);
    res.json({ invitations: rows });
  });

  r.post('/', validate({ params: orgParams, body: inviteBody }), requireOrgPermission(deps, 'members.invite'), async (req, res) => {
    const orgId = req.membership!.organizationId;
    const { email: invitee, role } = req.body as z.infer<typeof inviteBody>;
    if (!canGrantRole(req.membership!.role, role)) {
      throw new AppError('FORBIDDEN', 'You cannot invite someone with more permissions than your own.');
    }
    const [org] = await db.query<{ name: string; status: string; type: string }>('SELECT name, status, type FROM organizations WHERE id = $1', [orgId]);
    if (!org || ['rejected', 'suspended'].includes(org.status)) {
      throw new AppError('FORBIDDEN', 'This organization cannot invite members in its current status.', { organizationStatus: org?.status });
    }
    if (!(org.type === 'agency' ? AGENCY_ROLES : FACILITY_ROLES).includes(role as never)) {
      throw new AppError('VALIDATION_FAILED', 'This role does not apply to this type of organization.', { fieldErrors: { role: ['Invalid role'] } });
    }
    const [member] = await db.query(
      `SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.status = 'active' AND lower(u.email) = $2`, [orgId, invitee]);
    if (member) throw new AppError('CONFLICT', 'This person is already a member.');

    const token = newToken();
    const inv = await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE organization_invitations SET revoked_at = now()
          WHERE organization_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [orgId, invitee]);
      const [row] = await tx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, expires_at`,
        [orgId, invitee, role, sha256(token), req.auth!.userId, new Date(now() + INVITE_TTL_MS)]);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'invitation.created', targetType: 'invitation', targetId: row!.id, organizationId: orgId, requestId: req.requestId, metadata: { role } });
      return row!;
    });
    await email.send({ to: invitee, template: 'org_invitation', token, orgName: org.name });
    res.status(201).json({ invitation: { id: inv.id, email: invitee, role, expiresAt: inv.expires_at } });
  });

  r.delete('/:invitationId', validate({ params: inviteParams }), requireOrgPermission(deps, 'members.invite'), async (req, res) => {
    const orgId = req.membership!.organizationId;
    const rows = await db.query(
      `UPDATE organization_invitations SET revoked_at = now()
        WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [param(req, 'invitationId'), orgId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'invitation.revoked', targetType: 'invitation', targetId: param(req, 'invitationId'), organizationId: orgId, requestId: req.requestId });
    res.status(204).end();
  });

  return r;
}

/** POST /invitations/accept — the signed-in, email-verified user whose address matches the invitation joins the organization. */
export function acceptInvitationRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  r.post('/accept', needAuth, validate({ body: acceptBody }), async (req, res) => {
    const invalid = () => new AppError('BAD_REQUEST', 'This invitation is invalid, expired, or was sent to a different account.');
    const out = await db.transaction(async (tx) => {
      const [user] = await tx.query<{ email: string; email_verified_at: Date | null }>('SELECT email, email_verified_at FROM users WHERE id = $1', [req.auth!.userId]);
      if (!user?.email_verified_at) throw invalid();
      // Match on the address before consuming the token, so another user's token is not burned.
      const [inv] = await tx.query<{ id: string; organization_id: string; role: string }>(
        `UPDATE organization_invitations SET accepted_at = $2, accepted_by = $3
          WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2 AND lower(email) = lower($4)
          RETURNING id, organization_id, role`,
        [sha256(req.body.token), new Date(now()), req.auth!.userId, user.email]);
      if (!inv) throw invalid();
      await tx.query(
        `INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1,$2,$3,'active')
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
        [inv.organization_id, req.auth!.userId, inv.role]);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id, organizationId: inv.organization_id, requestId: req.requestId, metadata: { role: inv.role } });
      return inv;
    });
    res.json({ organizationId: out.organization_id, role: out.role });
  });
  return r;
}
