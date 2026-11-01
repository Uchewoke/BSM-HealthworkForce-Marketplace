import { randomBytes } from 'node:crypto';
import type { Queryable } from '../../db/index.js';

/**
 * A random reference per (organization, professional). It lets a facility act on an anonymized card without learning who
 * the person is, and stops two organizations correlating the same person. Shared by talent search and the float pool.
 */
export async function talentRefFor(q: Queryable, organizationId: string, professionalId: string): Promise<string> {
  const [row] = await q.query<{ ref: string }>(
    `INSERT INTO talent_refs (organization_id, professional_id, ref) VALUES ($1,$2,$3)
     ON CONFLICT (organization_id, professional_id) DO UPDATE SET organization_id = EXCLUDED.organization_id RETURNING ref`,
    [organizationId, professionalId, randomBytes(16).toString('base64url')]);
  return row!.ref;
}
