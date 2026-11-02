import type { Queryable } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';

export interface ProfessionalRow {
  id: string; user_id: string; profession_id: string; headline: string | null; summary: string | null;
  phone: string | null; city: string | null; state: string | null; account_status: string; discoverable: boolean;
}

/** The professional is always derived from the session user, never from a client-supplied id. */
export async function loadProfessional(q: Queryable, userId: string): Promise<ProfessionalRow> {
  const [p] = await q.query<ProfessionalRow>('SELECT * FROM professionals WHERE user_id = $1', [userId]);
  if (!p) throw new AppError('NOT_FOUND', 'Create your professional profile first.');
  return p;
}

export const COMPLETENESS_SECTIONS = ['specialties', 'work_history', 'preferences', 'availability', 'credentials'] as const;

/**
 * Profile completeness is about whether sections are filled in. It says nothing about whether any credential
 * has been verified and does not grant eligibility for any job.
 */
export async function profileCompleteness(q: Queryable, professionalId: string) {
  const [row] = await q.query<Record<string, boolean>>(
    `SELECT
       EXISTS (SELECT 1 FROM professional_specialties WHERE professional_id = $1) AS specialties,
       (EXISTS (SELECT 1 FROM professional_experience WHERE professional_id = $1)
         OR EXISTS (SELECT 1 FROM professional_education WHERE professional_id = $1)) AS work_history,
       EXISTS (SELECT 1 FROM professional_preferences WHERE professional_id = $1) AS preferences,
       EXISTS (SELECT 1 FROM professional_availability WHERE professional_id = $1) AS availability,
       EXISTS (SELECT 1 FROM credentials WHERE professional_id = $1) AS credentials`, [professionalId]);
  const missing = COMPLETENESS_SECTIONS.filter((s) => !row?.[s]);
  return {
    complete: missing.length === 0,
    percent: Math.round(((COMPLETENESS_SECTIONS.length - missing.length) / COMPLETENESS_SECTIONS.length) * 100),
    missing,
  };
}

/** Same rule as `profileCompleteness`, for many professionals in one query. Returns percent by professional id. */
export async function profileCompletenessPercents(q: Queryable, professionalIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!professionalIds.length) return out;
  const rows = await q.query<Record<string, any>>(
    `SELECT p.id,
       EXISTS (SELECT 1 FROM professional_specialties WHERE professional_id = p.id) AS specialties,
       (EXISTS (SELECT 1 FROM professional_experience WHERE professional_id = p.id)
         OR EXISTS (SELECT 1 FROM professional_education WHERE professional_id = p.id)) AS work_history,
       EXISTS (SELECT 1 FROM professional_preferences WHERE professional_id = p.id) AS preferences,
       EXISTS (SELECT 1 FROM professional_availability WHERE professional_id = p.id) AS availability,
       EXISTS (SELECT 1 FROM credentials WHERE professional_id = p.id) AS credentials
     FROM professionals p WHERE p.id = ANY($1::uuid[])`, [professionalIds]);
  for (const row of rows) {
    const done = COMPLETENESS_SECTIONS.filter((s) => row[s]).length;
    out.set(row.id, Math.round((done / COMPLETENESS_SECTIONS.length) * 100));
  }
  return out;
}
