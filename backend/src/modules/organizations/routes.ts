import { Router, type RequestHandler } from 'express';
import { AGENCY_ROLES, canGrantRole, FACILITY_ROLES } from '@bsm/permissions';
import { z } from 'zod';
import { requireOrgPermission } from '../../middleware/access.js';
import { validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { buildSet } from '../../shared/sql.js';
import { audit } from '../audit/service.js';
import { emailSchema } from '../auth/schemas.js';
import { facilityRoutes } from '../facilities/routes.js';
import { invitationRoutes } from '../invitations/routes.js';
import { agencyRoutes, facilityAgencyRoutes } from '../agencies/routes.js';
import { agencyAnalyticsRoutes, facilityAnalyticsRoutes } from '../analytics/routes.js';
import { agencyAssistantRoutes, facilityAssistantRoutes } from '../assistant/routes.js';
import { orgBillingRoutes } from '../billing/routes.js';
import { facilityExchangeRoutes } from '../exchange/routes.js';
import { forecastRoutes } from '../forecast/routes.js';
import { shiftRecoveryRoutes } from '../shift-recovery/routes.js';
import { facilityReviewRoutes } from '../reviews/routes.js';
import { facilityTimesheetRoutes } from '../timesheets/routes.js';
import { applicationFacilityRoutes } from '../applications/routes.js';
import { shiftOfferFacilityRoutes } from '../applications/shift-offers-routes.js';
import { jobRoutes } from '../jobs/routes.js';
import { talentRoutes } from '../talent/routes.js';
import { matchRunRoutes } from '../matching/routes.js';
import { transitionOrganization } from './status.js';

const createBody = z.object({
  name: z.string().trim().min(2).max(160),
  type: z.enum(['facility', 'agency']),
});
const profileBody = z.object({
  name: z.string().trim().min(2).max(160),
  legalName: z.string().trim().min(2).max(200),
  contactEmail: emailSchema,
  contactPhone: z.string().trim().regex(/^\+?[0-9 ()\-.]{7,20}$/, 'Invalid phone number'),
  website: z.url({ protocol: /^https?$/ }).max(300),
  state: z.string().trim().length(2).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/)),
}).partial().refine((b) => Object.keys(b).length > 0, 'Provide at least one field.');
const orgParams = z.object({ orgId: z.uuid() });
const memberParams = z.object({ orgId: z.uuid(), memberId: z.uuid() });
const roleBody = z.object({ role: z.enum([...FACILITY_ROLES, ...AGENCY_ROLES]).exclude(['facility_owner', 'agency_owner']) });

const PROFILE_COLUMNS = {
  name: 'name', legalName: 'legal_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', website: 'website', state: 'state',
};
const ORG_COLUMNS = 'id, name, type, status, legal_name, contact_email, contact_phone, website, state, created_at';

export function organizationRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);

  // Organizations the caller actively belongs to.
  r.get('/', async (req, res) => {
    const rows = await db.query(
      `SELECT o.id, o.name, o.type, o.status, m.role
         FROM organizations o JOIN organization_members m ON m.organization_id = o.id
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.created_at`, [req.auth!.userId]);
    res.json({ organizations: rows });
  });

  r.post('/', validate({ body: createBody }), async (req, res) => {
    const org = await db.transaction(async (tx) => {
      const [o] = await tx.query<{ id: string; name: string; type: string; status: string }>(
        'INSERT INTO organizations (name, type, created_by) VALUES ($1,$2,$3) RETURNING id, name, type, status',
        [req.body.name, req.body.type, req.auth!.userId]);
      const ownerRole = req.body.type === 'agency' ? 'agency_owner' : 'facility_owner';
      await tx.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)`, [o!.id, req.auth!.userId, ownerRole]);
      await audit(tx, { actorUserId: req.auth!.userId, action: 'organization.created', targetType: 'organization', targetId: o!.id, organizationId: o!.id, requestId: req.requestId });
      return o!;
    });
    res.status(201).json({ organization: { ...org, role: org.type === 'agency' ? 'agency_owner' : 'facility_owner' } });
  });

  r.get('/:orgId', validate({ params: orgParams }), requireOrgPermission(deps, 'org.read'), async (req, res) => {
    const [o] = await db.query(`SELECT ${ORG_COLUMNS} FROM organizations WHERE id = $1`, [req.membership!.organizationId]);
    res.json({ organization: { ...o, role: req.membership!.role } });
  });

  // Profile edits are only allowed while the organization is a draft or BSM has asked for more information.
  r.patch('/:orgId', validate({ params: orgParams, body: profileBody }), requireOrgPermission(deps, 'org.update'), async (req, res) => {
    const id = req.membership!.organizationId;
    const o = await db.transaction(async (tx) => {
      const [cur] = await tx.query<{ status: string }>('SELECT status FROM organizations WHERE id = $1 FOR UPDATE', [id]);
      if (!cur || !['draft', 'needs_information'].includes(cur.status)) {
        throw new AppError('CONFLICT', 'The profile cannot be edited in the current review status.', { organizationStatus: cur?.status });
      }
      const set = buildSet(PROFILE_COLUMNS, req.body, 2);
      if (!set) return null;
      const [row] = await tx.query(`UPDATE organizations SET ${set.sql}, updated_at = now() WHERE id = $1 RETURNING ${ORG_COLUMNS}`, [id, ...set.values]);
      return row;
    });
    if (!o) throw new AppError('BAD_REQUEST', 'Nothing to update.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'organization.updated', targetType: 'organization', targetId: id, organizationId: id, requestId: req.requestId, metadata: { fields: Object.keys(req.body) } });
    res.json({ organization: o });
  });

  r.post('/:orgId/submit', validate({ params: orgParams }), requireOrgPermission(deps, 'org.submit_for_review'), async (req, res) => {
    const out = await transitionOrganization(db, {
      orgId: req.membership!.organizationId, to: 'submitted', actorKind: 'organization', actorUserId: req.auth!.userId, requestId: req.requestId,
    });
    res.json({ organization: { id: out.id, status: out.status } });
  });

  // Decision history shown to the organization (reasons only; internal reviewer notes and reviewer identity are omitted).
  r.get('/:orgId/reviews', validate({ params: orgParams }), requireOrgPermission(deps, 'org.read'), async (req, res) => {
    const rows = await db.query(
      `SELECT id, actor_kind, from_status, to_status, reason, created_at
         FROM organization_reviews WHERE organization_id = $1 ORDER BY created_at, id`, [req.membership!.organizationId]);
    res.json({ reviews: rows });
  });

  r.get('/:orgId/members', validate({ params: orgParams }), requireOrgPermission(deps, 'members.read'), async (req, res) => {
    const rows = await db.query(
      `SELECT m.id, m.user_id, m.role, m.status, u.full_name, u.email
         FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.status = 'active' ORDER BY m.created_at`, [req.membership!.organizationId]);
    res.json({ members: rows });
  });

  /** Loads a member of THIS organization and enforces the escalation rules for modifying them. */
  async function loadManageableMember(req: Parameters<RequestHandler>[0]) {
    const orgId = req.membership!.organizationId;
    const [target] = await db.query<{ id: string; user_id: string; role: string }>(
      `SELECT id, user_id, role FROM organization_members WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [req.params.memberId, orgId]);
    if (!target) throw new AppError('NOT_FOUND', 'Resource not found.');
    if (target.user_id === req.auth!.userId) throw new AppError('FORBIDDEN', 'You cannot change your own membership.');
    if (!canGrantRole(req.membership!.role, target.role)) throw new AppError('FORBIDDEN', 'You do not have permission to change this member.');
    return { orgId, target };
  }

  r.patch('/:orgId/members/:memberId', validate({ params: memberParams, body: roleBody }), requireOrgPermission(deps, 'members.manage'), async (req, res) => {
    const { orgId, target } = await loadManageableMember(req);
    if (!canGrantRole(req.membership!.role, req.body.role)) throw new AppError('FORBIDDEN', 'You cannot assign a role with more permissions than your own.');
    const [orgRow] = await db.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1', [orgId]);
    if (!(orgRow?.type === 'agency' ? AGENCY_ROLES : FACILITY_ROLES).includes(req.body.role as never)) throw new AppError('VALIDATION_FAILED', 'This role does not apply to this type of organization.', { fieldErrors: { role: ['Invalid role'] } });
    await db.query('UPDATE organization_members SET role = $2 WHERE id = $1', [target.id, req.body.role]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'member.role_changed', targetType: 'organization_member', targetId: target.id, organizationId: orgId, requestId: req.requestId, metadata: { from: target.role, to: req.body.role } });
    res.json({ member: { id: target.id, role: req.body.role } });
  });

  r.delete('/:orgId/members/:memberId', validate({ params: memberParams }), requireOrgPermission(deps, 'members.manage'), async (req, res) => {
    const { orgId, target } = await loadManageableMember(req);
    await db.query(`UPDATE organization_members SET status = 'removed' WHERE id = $1`, [target.id]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'member.removed', targetType: 'organization_member', targetId: target.id, organizationId: orgId, requestId: req.requestId, metadata: { role: target.role } });
    res.status(204).end();
  });

  r.use('/:orgId/invitations', invitationRoutes(deps));
  r.use('/:orgId/agency/analytics', agencyAnalyticsRoutes(deps));
  r.use('/:orgId/agency/assistant', agencyAssistantRoutes(deps));
  r.use('/:orgId/assistant', facilityAssistantRoutes(deps));
  r.use('/:orgId/analytics', facilityAnalyticsRoutes(deps));
  r.use('/:orgId/forecast', forecastRoutes(deps));
  r.use('/:orgId/exchange', facilityExchangeRoutes(deps));
  r.use('/:orgId/shift-recovery', shiftRecoveryRoutes(deps));
  r.use('/:orgId/agency', agencyRoutes(deps));
  r.use('/:orgId/billing', orgBillingRoutes(deps));
  r.use('/:orgId', facilityAgencyRoutes(deps));
  r.use('/:orgId/facilities', facilityRoutes(deps));
  r.use('/:orgId/jobs', jobRoutes(deps));
  r.use('/:orgId/talent', talentRoutes(deps));
  r.use('/:orgId', applicationFacilityRoutes(deps));
  r.use('/:orgId', matchRunRoutes(deps));
  r.use('/:orgId', shiftOfferFacilityRoutes(deps));
  r.use('/:orgId', facilityTimesheetRoutes(deps));
  r.use('/:orgId', facilityReviewRoutes(deps));
  return r;
}
