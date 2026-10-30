import type { Queryable } from '../../db/index.js';

export const CREDENTIAL_STATUSES = [
  'not_submitted', 'submitted', 'pending_review', 'verification_in_progress', 'verified', 'rejected',
  'expired', 'needs_more_information', 'revoked', 'unable_to_verify',
] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * Status as it should be presented: a credential past its expiration date is "expired" regardless of its stored
 * review outcome (revoked/rejected stay as they are). Uses the database date.
 */
export const EFFECTIVE_STATUS_SQL = `CASE WHEN c.status NOT IN ('revoked','rejected') AND c.expiration_date IS NOT NULL
  AND c.expiration_date < CURRENT_DATE THEN 'expired' ELSE c.status END`;

/** Honest display text. "Verified" is only ever shown with the method that actually produced it. */
export function statusLabel(effective: string, method: string | null): string {
  switch (effective) {
    case 'verified':
      return method === 'primary_source' ? 'Verified with the primary source' : 'Documents reviewed (not verified with the primary source)';
    case 'not_submitted': return 'Not submitted';
    case 'submitted': return 'Submitted, awaiting review';
    case 'pending_review': return 'Pending review';
    case 'verification_in_progress': return 'Verification in progress';
    case 'needs_more_information': return 'More information needed';
    case 'rejected': return 'Rejected';
    case 'expired': return 'Expired';
    case 'revoked': return 'Revoked';
    case 'unable_to_verify': return 'Unable to verify';
    default: return 'Unknown';
  }
}

export const CREDENTIAL_PUBLIC_COLUMNS = `c.id, c.kind, c.credential_type, c.jurisdiction, c.issuing_authority, c.number_last4,
  c.issue_date, c.expiration_date, c.status, ${EFFECTIVE_STATUS_SQL} AS effective_status, c.verification_method,
  CASE WHEN ${EFFECTIVE_STATUS_SQL} = 'verified' THEN c.verified_at END AS verified_at, c.created_at,
  (SELECT v.reason FROM credential_verifications v WHERE v.credential_id = c.id AND v.actor_kind = 'platform'
    ORDER BY v.seq DESC LIMIT 1) AS latest_review_reason`;

export function withLabel<T extends { effective_status: string; verification_method: string | null }>(row: T) {
  return { ...row, status_label: statusLabel(row.effective_status, row.verification_method) };
}

export async function credentialSummary(q: Queryable, professionalId: string) {
  const rows = await q.query<{ s: string; n: string }>(
    `SELECT ${EFFECTIVE_STATUS_SQL} AS s, count(*) AS n FROM credentials c WHERE c.professional_id = $1 GROUP BY 1`, [professionalId]);
  return Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
}
