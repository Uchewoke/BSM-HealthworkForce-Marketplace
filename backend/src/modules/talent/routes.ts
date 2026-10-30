import { randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireApprovedOrg, requireOrgPermission } from '../../middleware/access.js';
import { param, validate } from '../../middleware/http.js';
import type { AppDeps } from '../../shared/deps.js';
import { AppError } from '../../shared/errors.js';
import { RateLimiter } from '../../shared/rate-limit.js';
import { audit } from '../audit/service.js';
import { statusLabel } from '../credentials/labels.js';
import { FROM_WHERE_BASE } from '../jobs/search.js';
import { evaluateMatch, type MatchResult } from '../matching/loader.js';
import { experienceYears } from '../matching/eligibility.js';
import { notifyUsers } from '../notifications/service.js';
import { loadProfessional } from '../professionals/service.js';
import { EMPLOYMENT_TYPES, stateCode } from '../professionals/schemas.js';

const MAX_RESULT_WINDOW = 300;          // a facility can never page past this many results (anti-scraping)
const INVITE_TTL_MS = 14 * 86_400_000;
const DAILY_INVITES_PER_ORG = 30;

const searchQuery = z.object({
  professionId: z.uuid().optional(),
  specialtyId: z.uuid().optional(),
  state: stateCode.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  licenseType: z.string().trim().min(1).max(40).optional(),
  licenseState: stateCode.optional(),
  verifiedOnly: z.enum(['true', 'false']).default('false'),
  minYears: z.coerce.number().min(0).max(50).optional(),
  jobId: z.uuid().optional(),           // evaluate eligibility and rank against one of this organization's jobs
  sort: z.enum(['experience', 'recent']).default('recent'),
  page: z.coerce.number().int().min(1).max(100).default(1),
  pageSize: z.coerce.number().int().min(1).max(25).default(12),
});
const inviteBody = z.object({ talentRef: z.string().min(10).max(64), jobId: z.uuid(), message: z.string().trim().min(1).max(500).optional() });
const orgParams = z.object({ orgId: z.uuid() });
const invParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const idParams = z.object({ id: z.uuid() });
const discoverBody = z.object({ discoverable: z.boolean() });
const OUTCOME_ORDER = ['eligible', 'pending_verification', 'needs_review', 'unavailable', 'expired_credential', 'ineligible'];

/**
 * Facility talent search, mounted at /organizations/:orgId/talent.
 * Privacy contract (decided by the product owner): only opted-in professionals appear, as ANONYMIZED cards: profession,
 * specialties, city/state, years of experience, credential STATUS labels and a general availability summary. Never a name,
 * contact detail, free-text profile text, employer, school, pay expectation, credential number or document. Identity is
 * revealed only through the normal application flow after the professional applies.
 */
export function talentRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const searchLimiter = new RateLimiter(60, 60_000, now);
  const r = Router({ mergeParams: true });
  const search = [requireOrgPermission(deps, 'professionals.search'), requireApprovedOrg(deps)];
  const orgOf = (req: Request) => req.membership!.organizationId;

  async function refFor(orgId: string, professionalId: string): Promise<string> {
    const [row] = await db.query<{ ref: string }>(
      `INSERT INTO talent_refs (organization_id, professional_id, ref) VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, professional_id) DO UPDATE SET organization_id = EXCLUDED.organization_id RETURNING ref`,
      [orgId, professionalId, randomBytes(16).toString('base64url')]);
    return row!.ref;
  }

  r.get('/', validate({ params: orgParams }), ...search, async (req, res) => {
    if (!searchLimiter.allow(`talent:${req.auth!.userId}`)) throw new AppError('RATE_LIMITED', 'Too many searches. Try again shortly.');
    const q = searchQuery.parse(req.query);
    const orgId = orgOf(req);
    if (q.jobId) {
      const [job] = await db.query('SELECT 1 FROM jobs WHERE id = $1 AND organization_id = $2', [q.jobId, orgId]);
      if (!job) throw new AppError('NOT_FOUND', 'Resource not found.');
    }
    if ((q.page - 1) * q.pageSize >= MAX_RESULT_WINDOW) throw new AppError('VALIDATION_FAILED', 'Refine your search to see more results.');

    const args: unknown[] = [];
    let where = `p.discoverable AND p.account_status = 'active' AND u.status = 'active'`;
    const add = (clause: string, v: unknown) => { args.push(v); where += ` AND ${clause.replace(/\?/g, `$${args.length}`)}`; };
    if (q.professionId) add('p.profession_id = ?', q.professionId);
    if (q.specialtyId) add('EXISTS (SELECT 1 FROM professional_specialties ps WHERE ps.professional_id = p.id AND ps.specialty_id = ?)', q.specialtyId);
    if (q.state) add('p.state = ?', q.state);
    if (q.employmentType) add('? = ANY(pp.employment_types)', q.employmentType);
    if (q.licenseType) {
      args.push(q.licenseType.toLowerCase());
      let sub = `EXISTS (SELECT 1 FROM credentials c WHERE c.professional_id = p.id AND c.kind = 'license' AND c.status <> 'not_submitted' AND lower(c.credential_type) = $${args.length}`;
      if (q.licenseState) { args.push(q.licenseState); sub += ` AND c.jurisdiction = $${args.length}`; }
      if (q.verifiedOnly === 'true') sub += ` AND c.status = 'verified' AND (c.expiration_date IS NULL OR c.expiration_date >= CURRENT_DATE)`;
      where += ` AND ${sub})`;
    } else if (q.verifiedOnly === 'true') {
      where += ` AND EXISTS (SELECT 1 FROM credentials c WHERE c.professional_id = p.id AND c.status = 'verified' AND (c.expiration_date IS NULL OR c.expiration_date >= CURRENT_DATE))`;
    }
    const base = `FROM professionals p JOIN users u ON u.id = p.user_id JOIN professions pr ON pr.id = p.profession_id
                  LEFT JOIN professional_preferences pp ON pp.professional_id = p.id WHERE ${where}`;
    const rows = await db.query<any>(
      `SELECT p.id, p.city, p.state, p.updated_at, pr.name AS profession, pp.employment_types, pp.shift_types, pp.preferred_states, pp.available_from
         ${base} ORDER BY p.updated_at DESC, p.id LIMIT ${MAX_RESULT_WINDOW}`, args);

    const ids = rows.map((x) => x.id as string);
    const specialties = new Map<string, string[]>(), experience = new Map<string, any[]>(), creds = new Map<string, any[]>(), days = new Map<string, number[]>();
    if (ids.length) {
      for (const s of await db.query<any>(`SELECT ps.professional_id, s.name FROM professional_specialties ps JOIN specialties s ON s.id = ps.specialty_id WHERE ps.professional_id = ANY($1::uuid[]) ORDER BY s.name`, [ids])) {
        specialties.set(s.professional_id, [...(specialties.get(s.professional_id) ?? []), s.name]);
      }
      for (const e of await db.query<any>(`SELECT professional_id, start_date, end_date FROM professional_experience WHERE professional_id = ANY($1::uuid[])`, [ids])) {
        experience.set(e.professional_id, [...(experience.get(e.professional_id) ?? []), { startDate: new Date(e.start_date).toISOString().slice(0, 10), endDate: e.end_date ? new Date(e.end_date).toISOString().slice(0, 10) : null }]);
      }
      for (const c of await db.query<any>(
        `SELECT c.professional_id, c.kind, c.credential_type, c.jurisdiction, c.verification_method,
                CASE WHEN c.status NOT IN ('revoked','rejected') AND c.expiration_date < CURRENT_DATE THEN 'expired' ELSE c.status END AS effective_status
           FROM credentials c WHERE c.professional_id = ANY($1::uuid[]) AND c.status <> 'not_submitted' ORDER BY c.kind, c.credential_type`, [ids])) {
        creds.set(c.professional_id, [...(creds.get(c.professional_id) ?? []), { kind: c.kind, credentialType: c.credential_type, jurisdiction: c.jurisdiction, status: c.effective_status,
          verificationMethod: c.verification_method, statusLabel: statusLabel(c.effective_status, c.verification_method) }]);
      }
      for (const d of await db.query<any>(`SELECT DISTINCT professional_id, day_of_week FROM professional_availability WHERE professional_id = ANY($1::uuid[]) ORDER BY day_of_week`, [ids])) {
        days.set(d.professional_id, [...(days.get(d.professional_id) ?? []), Number(d.day_of_week)]);
      }
    }
    const nowDate = new Date(now());
    let cards = rows.map((p) => ({
      id: p.id as string, // internal only: stripped before sending
      profession: p.profession, specialties: specialties.get(p.id) ?? [], city: p.city, state: p.state,
      yearsExperience: experienceYears(experience.get(p.id) ?? [], nowDate),
      credentials: creds.get(p.id) ?? [],
      availability: { daysOfWeek: days.get(p.id) ?? [], employmentTypes: p.employment_types ?? [], shiftTypes: p.shift_types ?? [], preferredStates: p.preferred_states ?? [], availableFrom: p.available_from },
      match: null as null | { outcome: string; score: number | null; reasons: { code: string; message: string }[] },
    }));
    if (q.minYears !== undefined) cards = cards.filter((c) => c.yearsExperience >= q.minYears!);

    if (q.jobId) {
      const matches = new Map<string, MatchResult>();
      for (const c of cards) matches.set(c.id, await evaluateMatch(db, { professionalId: c.id, jobId: q.jobId, shiftIds: [], now: nowDate }));
      for (const c of cards) {
        const m = matches.get(c.id)!;
        c.match = { outcome: m.eligibility.outcome, score: m.rank?.score ?? null, reasons: m.eligibility.reasons.map((x) => ({ code: x.code, message: x.message })) };
      }
      cards.sort((a, b) => OUTCOME_ORDER.indexOf(a.match!.outcome) - OUTCOME_ORDER.indexOf(b.match!.outcome) || (b.match!.score ?? 0) - (a.match!.score ?? 0));
    } else if (q.sort === 'experience') {
      cards.sort((a, b) => b.yearsExperience - a.yearsExperience);
    }

    const total = cards.length;
    const pageCards = cards.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const out = [];
    for (const c of pageCards) {
      const { id, ...card } = c;
      out.push({ talentRef: await refFor(orgId, id), ...card });
    }
    await audit(db, { actorUserId: req.auth!.userId, action: 'talent.search', organizationId: orgId, requestId: req.requestId, metadata: { filters: Object.keys(req.query), results: total } });
    res.json({
      talent: out, page: q.page, pageSize: q.pageSize, total,
      note: 'Only professionals who opted in appear, anonymized. Eligibility and ranking (when a job is chosen) never override mandatory requirements.',
    });
  });

  // ---- invitations to apply
  r.post('/invitations', validate({ params: orgParams, body: inviteBody }), ...search, async (req, res) => {
    const b = req.body as z.infer<typeof inviteBody>;
    const orgId = orgOf(req);
    const [ref] = await db.query<{ professional_id: string }>('SELECT professional_id FROM talent_refs WHERE organization_id = $1 AND ref = $2', [orgId, b.talentRef]);
    if (!ref) throw new AppError('NOT_FOUND', 'Resource not found.');
    const [prof] = await db.query<{ user_id: string }>(
      `SELECT p.user_id FROM professionals p JOIN users u ON u.id = p.user_id WHERE p.id = $1 AND p.discoverable AND p.account_status = 'active' AND u.status = 'active'`, [ref.professional_id]);
    if (!prof) throw new AppError('CONFLICT', 'This professional is no longer available for invitations.');
    const [job] = await db.query<{ title: string }>(`SELECT j.title ${FROM_WHERE_BASE} AND j.id = $1 AND j.organization_id = $2`, [b.jobId, orgId]);
    if (!job) throw new AppError('VALIDATION_FAILED', 'Choose one of your published jobs that is currently open.', { fieldErrors: { jobId: ['Not an open job of this organization'] } });
    const [applied] = await db.query('SELECT 1 FROM applications WHERE job_id = $1 AND professional_id = $2', [b.jobId, ref.professional_id]);
    if (applied) throw new AppError('CONFLICT', 'This professional has already applied to that job.');
    const [today] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM talent_invitations WHERE organization_id = $1 AND created_at > $2`, [orgId, new Date(now() - 86_400_000)]);
    if (Number(today?.n ?? 0) >= DAILY_INVITES_PER_ORG) throw new AppError('RATE_LIMITED', 'Daily invitation limit reached. Try again tomorrow.');
    const inv = await db.query<{ id: string }>(
      `INSERT INTO talent_invitations (organization_id, job_id, professional_id, invited_by, message, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, b.jobId, ref.professional_id, req.auth!.userId, b.message ?? null, new Date(now() + INVITE_TTL_MS)]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'talent.invited', targetType: 'talent_invitation', targetId: inv[0]!.id, organizationId: orgId, requestId: req.requestId, metadata: { jobId: b.jobId } });
    const [org] = await db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
    await notifyUsers(deps, [prof.user_id], {
      category: 'application_updates', type: 'talent.invited', title: `${org?.name ?? 'A facility'} invited you to apply: ${job.title}`,
      body: b.message, data: { invitationId: inv[0]!.id, jobId: b.jobId },
    });
    res.status(201).json({ invitation: { id: inv[0]!.id, status: 'pending' } });
  });

  r.get('/invitations', validate({ params: orgParams }), requireOrgPermission(deps, 'applications.read'), async (req, res) => {
    const rows = await db.query(
      `SELECT i.id, i.status, i.created_at, i.expires_at, i.responded_at, i.job_id, j.title AS job_title, i.application_id, tr.ref AS talent_ref, pr.name AS profession
         FROM talent_invitations i JOIN jobs j ON j.id = i.job_id JOIN professionals p ON p.id = i.professional_id
         JOIN professions pr ON pr.id = p.profession_id LEFT JOIN talent_refs tr ON tr.organization_id = i.organization_id AND tr.professional_id = i.professional_id
        WHERE i.organization_id = $1 ORDER BY i.created_at DESC, i.id LIMIT 100`, [orgOf(req)]);
    // The person's identity is only reachable through application_id, which exists once they applied.
    res.json({ invitations: rows.map((i: any) => ({ ...i, status: i.status === 'pending' && new Date(i.expires_at) < new Date(now()) ? 'expired' : i.status })) });
  });

  r.delete('/invitations/:id', validate({ params: invParams }), requireOrgPermission(deps, 'applications.manage'), async (req, res) => {
    const rows = await db.query(
      `UPDATE talent_invitations SET status = 'withdrawn', responded_at = now() WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`, [param(req, 'id'), orgOf(req)]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    await audit(db, { actorUserId: req.auth!.userId, action: 'talent.invitation_withdrawn', targetType: 'talent_invitation', targetId: param(req, 'id'), organizationId: orgOf(req), requestId: req.requestId });
    res.status(204).end();
  });

  return r;
}

/** The professional's side: discoverability setting and invitations received, mounted under /professionals/me. */
export function professionalTalentRoutes(deps: AppDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  const me = (req: Request) => loadProfessional(db, req.auth!.userId);

  r.get('/discoverability', async (req, res) => {
    const p = await me(req);
    const [row] = await db.query<{ discoverable: boolean; discoverable_updated_at: Date | null }>('SELECT discoverable, discoverable_updated_at FROM professionals WHERE id = $1', [p.id]);
    res.json({ discoverable: row!.discoverable, updatedAt: row!.discoverable_updated_at });
  });

  r.put('/discoverability', validate({ body: discoverBody }), async (req, res) => {
    const p = await me(req);
    await db.query('UPDATE professionals SET discoverable = $2, discoverable_updated_at = now(), updated_at = now() WHERE id = $1', [p.id, req.body.discoverable]);
    await audit(db, { actorUserId: req.auth!.userId, action: 'professional.discoverability_changed', targetType: 'professional', targetId: p.id, requestId: req.requestId, metadata: { discoverable: req.body.discoverable } });
    res.json({ discoverable: req.body.discoverable });
  });

  r.get('/invitations', async (req, res) => {
    const p = await me(req);
    const rows = await db.query<any>(
      `SELECT i.id, i.status, i.message, i.created_at, i.expires_at, i.job_id, jj.title AS job_title, o.name AS organization_name, l.city, l.state,
              EXISTS (SELECT 1 ${FROM_WHERE_BASE} AND j.id = i.job_id) AS job_open
         FROM talent_invitations i JOIN jobs jj ON jj.id = i.job_id JOIN organizations o ON o.id = i.organization_id JOIN facility_locations l ON l.id = jj.location_id
        WHERE i.professional_id = $1 ORDER BY i.created_at DESC, i.id LIMIT 100`, [p.id]);
    res.json({ invitations: rows.map((i) => ({ ...i, status: i.status === 'pending' && new Date(i.expires_at) < new Date(now()) ? 'expired' : i.status })) });
  });

  r.post('/invitations/:id/decline', validate({ params: idParams }), async (req, res) => {
    const p = await me(req);
    const rows = await db.query(`UPDATE talent_invitations SET status = 'declined', responded_at = now() WHERE id = $1 AND professional_id = $2 AND status = 'pending' RETURNING id`, [param(req, 'id'), p.id]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Resource not found.');
    res.status(204).end();
  });

  return r;
}
