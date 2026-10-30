import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';

export const ORG_STATUSES = ['draft', 'submitted', 'under_review', 'needs_information', 'approved', 'rejected', 'suspended'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];
export type ActorKind = 'organization' | 'platform';

interface Rule { to: OrgStatus; actor: ActorKind; reasonRequired: boolean }

/** Allowed transitions. The frontend never sets a status directly. */
const RULES: Record<OrgStatus, Rule[]> = {
  draft: [{ to: 'submitted', actor: 'organization', reasonRequired: false }],
  needs_information: [{ to: 'submitted', actor: 'organization', reasonRequired: false }],
  submitted: [{ to: 'under_review', actor: 'platform', reasonRequired: false }],
  under_review: [
    { to: 'approved', actor: 'platform', reasonRequired: false },
    { to: 'rejected', actor: 'platform', reasonRequired: true },
    { to: 'needs_information', actor: 'platform', reasonRequired: true },
  ],
  approved: [{ to: 'suspended', actor: 'platform', reasonRequired: true }],
  suspended: [{ to: 'approved', actor: 'platform', reasonRequired: true }],
  rejected: [],
};

const REQUIRED_PROFILE: Record<string, string> = {
  legal_name: 'legalName', contact_email: 'contactEmail', contact_phone: 'contactPhone', state: 'state',
};

export async function transitionOrganization(db: Db, input: {
  orgId: string; to: OrgStatus; actorKind: ActorKind; actorUserId: string;
  reason?: string; internalNote?: string; requestId: string;
}) {
  return db.transaction(async (tx) => {
    const org = (await tx.query<Record<string, any>>('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [input.orgId]))[0];
    if (!org) throw new AppError('NOT_FOUND', 'Resource not found.');
    const from = org.status as OrgStatus;
    const rule = RULES[from]?.find((r) => r.to === input.to && r.actor === input.actorKind);
    if (!rule) throw new AppError('CONFLICT', `Cannot change status from ${from} to ${input.to}.`);
    if (rule.reasonRequired && !input.reason?.trim()) {
      throw new AppError('VALIDATION_FAILED', 'A reason is required for this decision.', { fieldErrors: { reason: ['Required'] } });
    }
    if (input.to === 'submitted') {
      const missing = Object.entries(REQUIRED_PROFILE).filter(([col]) => !org[col]).map(([, field]) => field);
      if (missing.length) throw new AppError('VALIDATION_FAILED', 'Complete the organization profile before submitting.', { missing });
    }
    await tx.query('UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1', [input.orgId, input.to]);
    await tx.query(
      `INSERT INTO organization_reviews (organization_id, actor_user_id, actor_kind, from_status, to_status, reason, internal_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.orgId, input.actorUserId, input.actorKind, from, input.to, input.reason?.trim() ?? null, input.internalNote?.trim() ?? null]);
    await audit(tx, {
      actorUserId: input.actorUserId, action: `organization.status.${input.to}`, targetType: 'organization',
      targetId: input.orgId, organizationId: input.orgId, requestId: input.requestId, metadata: { from, to: input.to },
    });
    return { id: input.orgId, status: input.to, previousStatus: from };
  });
}
