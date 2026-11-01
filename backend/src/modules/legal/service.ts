import type { Queryable } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';

/** Features that must not run until a person has recorded that legal review is done. */
export const GATED_FEATURES = ['float_pool', 'shift_recovery'] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

export const FEATURE_LABELS: Record<GatedFeature, string> = {
  float_pool: 'Regional float pool (shared pool of opted-in professionals across facilities)',
  shift_recovery: 'Automatic outreach on a facility’s behalf (unfilled shift recovery)',
};

export async function isSignedOff(q: Queryable, feature: GatedFeature): Promise<boolean> {
  const [row] = await q.query<{ signed_off: boolean }>('SELECT signed_off FROM legal_signoffs WHERE feature = $1', [feature]);
  return row?.signed_off === true;
}

/** Refuses with a clear, non-technical message while the feature has no recorded sign-off. */
export async function requireSignedOff(q: Queryable, feature: GatedFeature): Promise<void> {
  if (!(await isSignedOff(q, feature))) {
    throw new AppError('FORBIDDEN', 'This feature is not available yet. It is switched on once BSM has completed its legal review.', { code: 'legal_signoff_required', feature });
  }
}
