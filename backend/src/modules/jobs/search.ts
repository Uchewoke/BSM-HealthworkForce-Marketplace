import { Router, type RequestHandler } from 'express';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { organizationRating as orgRating } from '../reviews/service.js';
import { params, searchQuery } from './schemas.js';

/**
 * A job is publicly listable only while its job is published, its organization is approved, its location and facility
 * are active, the deadline has not passed, and (for shift-based roles) at least one future open shift remains.
 */
export const FROM_WHERE_BASE = `
  FROM jobs j
  JOIN organizations o ON o.id = j.organization_id AND o.status = 'approved'
  JOIN facility_locations l ON l.id = j.location_id AND l.active
  JOIN facilities f ON f.id = l.facility_id AND f.active
  LEFT JOIN state_configurations sc ON sc.state = l.state
  JOIN professions pr ON pr.id = j.profession_id
  LEFT JOIN specialties sp ON sp.id = j.specialty_id
  LEFT JOIN LATERAL (
    SELECT min(s.starts_at) AS next_shift_at, count(*) AS open_shifts
      FROM shifts s WHERE s.job_id = j.id AND s.status = 'open' AND s.starts_at > now()
  ) ns ON true
  WHERE j.status = 'published'
    AND COALESCE(sc.enabled, true)
    AND (j.application_deadline IS NULL OR j.application_deadline > now())
    AND (j.employment_type = 'permanent' OR ns.open_shifts > 0)`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const SORT_SQL = { published_at: 'j.published_at', pay_max: 'j.pay_max_cents', next_shift: 'ns.next_shift_at' } as const;

/** Opportunity search for professionals, mounted at /jobs. Plain filtering: no eligibility or ranking is applied here. */
export function jobSearchRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);

  r.get('/', async (req, res) => {
    const q = searchQuery.parse(req.query);
    const args: unknown[] = [];
    let where = '';
    const add = (clause: string, value: unknown) => { args.push(value); where += ` AND ${clause.replace('?', `$${args.length}`)}`; };
    if (q.q) {
      args.push(`%${escapeLike(q.q)}%`);
      where += ` AND (j.title ILIKE $${args.length} ESCAPE '\\' OR j.description ILIKE $${args.length} ESCAPE '\\')`;
    }
    if (q.professionId) add('j.profession_id = ?', q.professionId);
    if (q.specialtyId) add('j.specialty_id = ?', q.specialtyId);
    if (q.state) add('l.state = ?', q.state);
    if (q.employmentType) add('j.employment_type = ?', q.employmentType);
    if (q.minPayCents !== undefined) {
      add('j.pay_unit = ?', q.payUnit ?? 'hour');
      add('j.pay_max_cents >= ?', q.minPayCents);
    } else if (q.payUnit) add('j.pay_unit = ?', q.payUnit);
    if (q.shiftFrom || q.shiftTo) {
      const from = q.shiftFrom ?? '1970-01-01T00:00:00Z';
      const to = q.shiftTo ?? '2999-01-01T00:00:00Z';
      args.push(from, to);
      where += ` AND EXISTS (SELECT 1 FROM shifts s2 WHERE s2.job_id = j.id AND s2.status = 'open' AND s2.starts_at > now()
                  AND s2.starts_at >= $${args.length - 1} AND s2.starts_at <= $${args.length})`;
    }
    const [count] = await db.query<{ n: string }>(`SELECT count(*) AS n ${FROM_WHERE_BASE} ${where}`, args);
    const rows = await db.query(
      `SELECT j.id, j.title, left(j.description, 300) AS summary, j.employment_type, j.pay_unit, j.pay_min_cents, j.pay_max_cents,
              j.application_deadline, j.published_at, j.positions_count, j.min_years_experience,
              o.name AS organization_name, f.name AS facility_name, l.city, l.state, l.timezone,
              pr.name AS profession, sp.name AS specialty, ns.next_shift_at, ns.open_shifts
       ${FROM_WHERE_BASE} ${where}
       ORDER BY ${SORT_SQL[q.sort]} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, j.id
       LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ jobs: rows, page: q.page, pageSize: q.pageSize, total: Number(count?.n ?? 0) });
  });

  r.get('/:id', validate({ params: params.id }), async (req, res) => {
    const id = param(req, 'id');
    const [job] = await db.query(
      `SELECT j.id, j.title, j.description, j.employment_type, j.pay_unit, j.pay_min_cents, j.pay_max_cents, j.application_deadline,
              j.published_at, j.positions_count, j.min_years_experience, o.name AS organization_name, f.name AS facility_name,
              l.city, l.state, l.timezone, pr.name AS profession, sp.name AS specialty, ns.next_shift_at, ns.open_shifts
       ${FROM_WHERE_BASE} AND j.id = $1`, [id]);
    if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    const requirements = await db.query(
      'SELECT kind, credential_type, jurisdiction, description, mandatory FROM job_requirements WHERE job_id = $1 ORDER BY mandatory DESC, created_at, id', [id]);
    const shifts = await db.query(
      `SELECT id, starts_at, ends_at, positions, hourly_rate_cents, notes FROM shifts WHERE job_id = $1 AND status = 'open' AND starts_at > now() ORDER BY starts_at LIMIT 100`, [id]);
    const [owner] = await db.query<{ organization_id: string }>('SELECT organization_id FROM jobs WHERE id = $1', [id]);
    const organizationRating = owner ? await orgRating(db, owner.organization_id) : null;
    res.json({ job, requirements, shifts, organizationRating });
  });

  return r;
}
