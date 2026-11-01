import { Router, type RequestHandler } from 'express';
import type { z } from 'zod';
import { validate, param } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { buildInsert, buildReplace, buildSet } from '../../shared/sql.js';
import { audit } from '../audit/service.js';
import { professionalAgencyRoutes } from '../agencies/routes.js';
import { professionalReviewRoutes } from '../reviews/routes.js';
import { professionalTimesheetRoutes } from '../timesheets/routes.js';
import { professionalApplicationRoutes } from '../applications/routes.js';
import { shiftOfferProfessionalRoutes } from '../applications/shift-offers-routes.js';
import { professionalTalentRoutes } from '../talent/routes.js';
import { credentialSummary } from '../credentials/labels.js';
import { credentialRoutes } from '../credentials/routes.js';
import {
  availabilityBody, educationBody, experienceBody, idParams, preferencesBody, profileBody, profilePatch, specialtiesBody,
} from './schemas.js';
import { loadProfessional, profileCompleteness } from './service.js';

const PROFILE_COLUMNS = { headline: 'headline', summary: 'summary', phone: 'phone', city: 'city', state: 'state' };
const EDU_COLUMNS = { institution: 'institution', degree: 'degree', fieldOfStudy: 'field_of_study', startYear: 'start_year', endYear: 'end_year' };
const EDU_RET = 'id, institution, degree, field_of_study, start_year, end_year';
const EXP_COLUMNS = {
  employer: 'employer', title: 'title', specialtyId: 'specialty_id', city: 'city', state: 'state',
  startDate: 'start_date', endDate: 'end_date', isCurrent: 'is_current', description: 'description',
};
const EXP_RET = 'id, employer, title, specialty_id, city, state, start_date, end_date, is_current, description';

/** Self-service professional API, mounted at /professionals. Everything is scoped to the signed-in user's own profile. */
export function professionalRoutes(deps: AppDeps, needAuth: RequestHandler) {
  const { db } = deps;
  const r = Router();
  r.use(needAuth);
  const me = (req: Parameters<RequestHandler>[0]) => loadProfessional(db, req.auth!.userId);
  const log = (req: Parameters<RequestHandler>[0], action: string, targetType: string, targetId?: string) =>
    audit(db, { actorUserId: req.auth!.userId, action, targetType, targetId, requestId: req.requestId });

  r.post('/', validate({ body: profileBody }), async (req, res) => {
    const b = req.body as z.infer<typeof profileBody>;
    const [prof] = await db.query<{ id: string }>('SELECT id FROM professions WHERE id = $1 AND active', [b.professionId]);
    if (!prof) throw new AppError('VALIDATION_FAILED', 'Unknown profession.', { fieldErrors: { professionId: ['Unknown profession'] } });
    const ins = buildInsert({ ...PROFILE_COLUMNS }, b, { user_id: req.auth!.userId, profession_id: b.professionId });
    const [row] = await db.query<{ id: string }>(`INSERT INTO professionals ${ins.sql} RETURNING id`, ins.values);
    await log(req, 'professional.created', 'professional', row!.id);
    res.status(201).json({ professional: { id: row!.id } });
  });

  r.get('/me', async (req, res) => {
    const p = await me(req);
    const [profession] = await db.query('SELECT id, code, name FROM professions WHERE id = $1', [p.profession_id]);
    const specialties = await db.query(
      `SELECT s.id, s.name FROM professional_specialties ps JOIN specialties s ON s.id = ps.specialty_id
        WHERE ps.professional_id = $1 ORDER BY s.name`, [p.id]);
    res.json({
      professional: { id: p.id, discoverable: p.discoverable, headline: p.headline, summary: p.summary, phone: p.phone, city: p.city, state: p.state, account_status: p.account_status },
      profession, specialties,
      completeness: await profileCompleteness(db, p.id),
      credentialSummary: await credentialSummary(db, p.id),
    });
  });

  r.patch('/me', validate({ body: profilePatch }), async (req, res) => {
    const p = await me(req);
    const set = buildSet(PROFILE_COLUMNS, req.body, 2);
    if (!set) throw new AppError('BAD_REQUEST', 'Nothing to update.');
    const [row] = await db.query(
      `UPDATE professionals SET ${set.sql}, updated_at = now() WHERE id = $1 RETURNING id, headline, summary, phone, city, state`, [p.id, ...set.values]);
    await log(req, 'professional.updated', 'professional', p.id);
    res.json({ professional: row });
  });

  r.put('/me/specialties', validate({ body: specialtiesBody }), async (req, res) => {
    const p = await me(req);
    const ids = [...new Set((req.body as z.infer<typeof specialtiesBody>).specialtyIds)];
    if (ids.length) {
      const ok = await db.query<{ id: string }>(
        'SELECT id FROM specialties WHERE id = ANY($1::uuid[]) AND profession_id = $2 AND active', [ids, p.profession_id]);
      if (ok.length !== ids.length) throw new AppError('VALIDATION_FAILED', 'Specialties must belong to your profession.');
    }
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM professional_specialties WHERE professional_id = $1', [p.id]);
      for (const id of ids) await tx.query('INSERT INTO professional_specialties (professional_id, specialty_id) VALUES ($1,$2)', [p.id, id]);
    });
    res.json({ specialtyIds: ids });
  });

  // ---- education & experience: list / create / replace / delete, always scoped to the caller's professional id
  function listCrud(path: string, table: string, schema: z.ZodType, columns: Record<string, string>, ret: string, order: string, max: number, key: string) {
    r.get(`/me/${path}`, async (req, res) => {
      const p = await me(req);
      res.json({ [key]: await db.query(`SELECT ${ret} FROM ${table} WHERE professional_id = $1 ORDER BY ${order}`, [p.id]) });
    });
    r.post(`/me/${path}`, validate({ body: schema }), async (req, res) => {
      const p = await me(req);
      const [{ n } = { n: '0' }] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE professional_id = $1`, [p.id]);
      if (Number(n) >= max) throw new AppError('CONFLICT', `You can add at most ${max} entries.`);
      const ins = buildInsert(columns, req.body, { professional_id: p.id });
      const [row] = await db.query<{ id: string }>(`INSERT INTO ${table} ${ins.sql} RETURNING ${ret}`, ins.values);
      await log(req, `professional.${path}_added`, table, row!.id);
      res.status(201).json({ item: row });
    });
    r.put(`/me/${path}/:id`, validate({ params: idParams, body: schema }), async (req, res) => {
      const p = await me(req);
      const rep = buildReplace(columns, req.body, 3);
      const [row] = await db.query(`UPDATE ${table} SET ${rep.sql} WHERE id = $1 AND professional_id = $2 RETURNING ${ret}`, [param(req, 'id'), p.id, ...rep.values]);
      if (!row) throw new AppError('NOT_FOUND', 'Resource not found.');
      await log(req, `professional.${path}_updated`, table, param(req, 'id'));
      res.json({ item: row });
    });
    r.delete(`/me/${path}/:id`, validate({ params: idParams }), async (req, res) => {
      const p = await me(req);
      const rows = await db.query(`DELETE FROM ${table} WHERE id = $1 AND professional_id = $2 RETURNING id`, [param(req, 'id'), p.id]);
      if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
      await log(req, `professional.${path}_removed`, table, param(req, 'id'));
      res.status(204).end();
    });
  }
  listCrud('education', 'professional_education', educationBody, EDU_COLUMNS, EDU_RET, 'end_year DESC NULLS FIRST, created_at', 20, 'education');
  listCrud('experience', 'professional_experience', experienceBody, EXP_COLUMNS, EXP_RET, 'start_date DESC', 50, 'experience');

  // ---- preferences & availability
  const PREF_RET = `employment_types, shift_types, preferred_states, max_travel_miles, min_hourly_rate_cents, available_from`;
  r.get('/me/preferences', async (req, res) => {
    const p = await me(req);
    const [row] = await db.query(`SELECT ${PREF_RET} FROM professional_preferences WHERE professional_id = $1`, [p.id]);
    res.json({ preferences: row ?? null });
  });
  r.put('/me/preferences', validate({ body: preferencesBody }), async (req, res) => {
    const p = await me(req);
    const b = req.body as z.infer<typeof preferencesBody>;
    const [row] = await db.query(
      `INSERT INTO professional_preferences (professional_id, employment_types, shift_types, preferred_states, max_travel_miles, min_hourly_rate_cents, available_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (professional_id) DO UPDATE SET employment_types = EXCLUDED.employment_types, shift_types = EXCLUDED.shift_types,
         preferred_states = EXCLUDED.preferred_states, max_travel_miles = EXCLUDED.max_travel_miles,
         min_hourly_rate_cents = EXCLUDED.min_hourly_rate_cents, available_from = EXCLUDED.available_from, updated_at = now()
       RETURNING ${PREF_RET}`,
      [p.id, [...new Set(b.employmentTypes)], [...new Set(b.shiftTypes)], [...new Set(b.preferredStates)], b.maxTravelMiles ?? null, b.minHourlyRateCents ?? null, b.availableFrom ?? null]);
    await log(req, 'professional.preferences_updated', 'professional', p.id);
    res.json({ preferences: row });
  });

  r.get('/me/availability', async (req, res) => {
    const p = await me(req);
    const rows = await db.query(
      `SELECT day_of_week, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
         FROM professional_availability WHERE professional_id = $1 ORDER BY day_of_week, start_time`, [p.id]);
    res.json({ windows: rows });
  });
  r.put('/me/availability', validate({ body: availabilityBody }), async (req, res) => {
    const p = await me(req);
    const { windows } = req.body as z.infer<typeof availabilityBody>;
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM professional_availability WHERE professional_id = $1', [p.id]);
      for (const w of windows) {
        await tx.query('INSERT INTO professional_availability (professional_id, day_of_week, start_time, end_time) VALUES ($1,$2,$3,$4)',
          [p.id, w.dayOfWeek, w.startTime, w.endTime]);
      }
    });
    await log(req, 'professional.availability_updated', 'professional', p.id);
    res.json({ windows });
  });

  r.use('/me/credentials', credentialRoutes(deps));
  r.use('/me/applications', professionalApplicationRoutes(deps));
  r.use('/me', professionalAgencyRoutes(deps));
  r.use('/me', professionalTimesheetRoutes(deps));
  r.use('/me', professionalReviewRoutes(deps));
  r.use('/me', shiftOfferProfessionalRoutes(deps));
  r.use('/me', professionalTalentRoutes(deps));
  return r;
}
