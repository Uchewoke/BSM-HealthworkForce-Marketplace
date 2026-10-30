import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/service.js';
import type { CredentialStatus } from './labels.js';

export type ActorKind = 'professional' | 'platform';
export type VerificationMethod = 'document_review' | 'primary_source';

interface Rule { to: CredentialStatus; actor: ActorKind; reasonRequired?: boolean }

/**
 * Allowed transitions. "verified" can only be reached by a platform reviewer who records HOW it was verified.
 * "expired" is never a transition: it is derived from the expiration date.
 * "verification_in_progress" is reserved for a future external primary-source integration and is not reachable today.
 */
const RULES: Partial<Record<CredentialStatus, Rule[]>> = {
  not_submitted: [{ to: 'submitted', actor: 'professional' }],
  needs_more_information: [{ to: 'submitted', actor: 'professional' }],
  unable_to_verify: [{ to: 'submitted', actor: 'professional' }],
  submitted: [{ to: 'pending_review', actor: 'platform' }],
  pending_review: [
    { to: 'verified', actor: 'platform' },
    { to: 'rejected', actor: 'platform', reasonRequired: true },
    { to: 'needs_more_information', actor: 'platform', reasonRequired: true },
    { to: 'unable_to_verify', actor: 'platform', reasonRequired: true },
  ],
  verified: [{ to: 'revoked', actor: 'platform', reasonRequired: true }],
};

/** Statuses in which the professional may still edit the record and its documents. */
export const EDITABLE_STATUSES: CredentialStatus[] = ['not_submitted', 'needs_more_information', 'unable_to_verify'];

export async function transitionCredential(db: Db, input: {
  credentialId: string; to: CredentialStatus; actorKind: ActorKind; actorUserId: string;
  /** When set, the credential must belong to this professional (professional-initiated changes). */
  professionalId?: string;
  method?: VerificationMethod; sourceReference?: string; reason?: string; internalNote?: string; requestId: string;
}) {
  return db.transaction(async (tx) => {
    const [c] = await tx.query<{ id: string; status: CredentialStatus; professional_id: string; expired: boolean }>(
      `SELECT id, status, professional_id, (expiration_date IS NOT NULL AND expiration_date < CURRENT_DATE) AS expired
         FROM credentials WHERE id = $1 ${input.professionalId ? 'AND professional_id = $2' : ''} FOR UPDATE`,
      input.professionalId ? [input.credentialId, input.professionalId] : [input.credentialId]);
    if (!c) throw new AppError('NOT_FOUND', 'Resource not found.');
    const rule = RULES[c.status]?.find((r) => r.to === input.to && r.actor === input.actorKind);
    if (!rule) throw new AppError('CONFLICT', `Cannot change status from ${c.status} to ${input.to}.`);
    if (rule.reasonRequired && !input.reason?.trim()) {
      throw new AppError('VALIDATION_FAILED', 'A reason is required for this decision.', { fieldErrors: { reason: ['Required'] } });
    }
    const [docs] = await tx.query<{ n: string }>('SELECT count(*) AS n FROM credential_documents WHERE credential_id = $1', [c.id]);
    const docCount = Number(docs?.n ?? 0);

    if (input.to === 'submitted') {
      if (c.expired) throw new AppError('CONFLICT', 'This credential has expired. Update its dates before submitting.');
      if (docCount === 0) throw new AppError('CONFLICT', 'Upload at least one supporting document before submitting.');
    }
    let verifiedFields: [VerificationMethod | null, string | null, Date | null] = [null, null, null];
    if (input.to === 'verified') {
      if (c.expired) throw new AppError('CONFLICT', 'An expired credential cannot be verified.');
      if (!input.method) throw new AppError('VALIDATION_FAILED', 'State how the credential was verified.', { fieldErrors: { method: ['Required'] } });
      if (input.method === 'primary_source' && (input.sourceReference?.trim().length ?? 0) < 5) {
        throw new AppError('VALIDATION_FAILED', 'Primary-source verification requires a reference to the source that was checked.', { fieldErrors: { sourceReference: ['Required'] } });
      }
      if (input.method === 'document_review' && docCount === 0) {
        throw new AppError('CONFLICT', 'Document review requires at least one uploaded document.');
      }
      verifiedFields = [input.method, input.method === 'primary_source' ? input.sourceReference!.trim() : null, new Date()];
    }

    if (input.to === 'verified') {
      await tx.query(
        `UPDATE credentials SET status = $2, verification_method = $3, verification_reference = $4, verified_at = $5, updated_at = now() WHERE id = $1`,
        [c.id, input.to, ...verifiedFields]);
    } else {
      await tx.query('UPDATE credentials SET status = $2, updated_at = now() WHERE id = $1', [c.id, input.to]);
    }
    await tx.query(
      `INSERT INTO credential_verifications (credential_id, actor_user_id, actor_kind, from_status, to_status, method, source_reference, reason, internal_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [c.id, input.actorUserId, input.actorKind, c.status, input.to, input.to === 'verified' ? input.method : null,
       input.to === 'verified' ? verifiedFields[1] : null, input.reason?.trim() ?? null, input.internalNote?.trim() ?? null]);
    await audit(tx, {
      actorUserId: input.actorUserId, action: `credential.status.${input.to}`, targetType: 'credential', targetId: c.id,
      requestId: input.requestId, metadata: { from: c.status, to: input.to, method: input.to === 'verified' ? input.method : undefined },
    });
    return { id: c.id, status: input.to, previousStatus: c.status, professionalId: c.professional_id };
  });
}
