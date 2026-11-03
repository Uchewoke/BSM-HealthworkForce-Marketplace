import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateMatch, evaluateMatches } from '../src/modules/matching/loader.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let owner: S, recruiter: S, scheduler: S, readonly: S, ownerB: S, reviewer: S;
let pApplicant: S, pPool: S, pPending: S, pTherapist: S, pHidden: S;
let orgA: string, orgB: string, jobId: string, jobB: string, shiftJobId: string, rnId: string, ptId: string, icuId: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
const base = '/api/v1/professionals/me';
const org = (o: string) => `/api/v1/organizations/${o}`;
const allDays = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '23:59' }));
const run = (body: object = {}, s: S = recruiter, o = orgA, job = jobId) => api().post(`${org(o)}/jobs/${job}/match-runs`).set('Cookie', s.cookie).send(body);
const read = (id: string, q = '', s: S = recruiter, o = orgA) => api().get(`${org(o)}/match-runs/${id}${q}`).set('Cookie', s.cookie);
const decide = (id: string, to: string, extra: object = {}) => api().post(`/api/v1/admin/credentials/${id}/status`).set('Cookie', reviewer.cookie).send({ to, ...extra });
const discoverable = (s: S, on: boolean) => api().put(`${base}/discoverability`).set('Cookie', s.cookie).send({ discoverable: on });
const PRIVATE = ['Test User', 'private@example.com', 'Secret Hospital', 'Secret University', '404-555', 'Jane Doe', 'RN-SECRET'];

async function credential(p: S, body: object, verify: boolean) {
  const c = (await api().post(`${base}/credentials`).set('Cookie', p.cookie).send(body)).body.credential;
  await api().post(`${base}/credentials/${c.id}/documents`).set('Cookie', p.cookie).set('Content-Type', 'application/pdf').send(PDF);
  await api().post(`${base}/credentials/${c.id}/submit`).set('Cookie', p.cookie);
  if (verify) { await decide(c.id, 'pending_review'); await decide(c.id, 'verified', { method: 'primary_source', sourceReference: 'Nursys lookup 2026-10-30' }); }
}

async function makePro(email: string, o: { professionId?: string; verified?: boolean } = {}) {
  const s = await ctx.userWithSession(email);
  await api().post('/api/v1/professionals').set('Cookie', s.cookie).send({ professionId: o.professionId ?? rnId, headline: 'Jane Doe, travel RN', summary: 'Call me at 404-555-0199', phone: '404-555-0199', city: 'Atlanta', state: 'GA' });
  if (!o.professionId) await api().put(`${base}/specialties`).set('Cookie', s.cookie).send({ specialtyIds: [icuId] });
  await api().post(`${base}/experience`).set('Cookie', s.cookie).send({ employer: 'Secret Hospital System', title: 'Staff RN', specialtyId: o.professionId ? undefined : icuId, startDate: '2015-01-01', isCurrent: true });
  await api().post(`${base}/education`).set('Cookie', s.cookie).send({ institution: 'Secret University', degree: 'BSN' });
  await api().put(`${base}/preferences`).set('Cookie', s.cookie).send({ employmentTypes: ['permanent', 'per_diem'], shiftTypes: ['day'], preferredStates: ['GA'], minHourlyRateCents: 4800 });
  await api().put(`${base}/availability`).set('Cookie', s.cookie).send({ windows: allDays });
  if (!o.professionId) {
    await credential(s, { kind: 'license', credentialType: 'RN', jurisdiction: 'GA', number: 'RN-SECRET-5551234', issueDate: '2022-01-01', expirationDate: '2099-01-01' }, o.verified ?? true);
    await credential(s, { kind: 'certification', credentialType: 'BLS', expirationDate: '2099-01-01' }, o.verified ?? true);
  }
  return s;
}

beforeAll(async () => {
  ctx = await makeTestApp({ globalLimit: { max: 100_000, windowMs: 60_000 } });
  owner = await ctx.userWithSession('owner@alpha.example');
  recruiter = await ctx.userWithSession('recruiter@alpha.example');
  scheduler = await ctx.userWithSession('scheduler@alpha.example');
  readonly = await ctx.userWithSession('readonly@alpha.example');
  ownerB = await ctx.userWithSession('owner@beta.example');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  orgA = (await api().post('/api/v1/organizations').set('Cookie', owner.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'scheduler'), ($1,$4,'read_only')`, [orgA, recruiter.id, scheduler.id, readonly.id]);

  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', owner.cookie)).body.professions as any[];
  const rn = tax.find((p) => p.code === 'rn');
  rnId = rn.id; ptId = tax.find((p) => p.code === 'pt').id; icuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;

  const mkJob = async (o: string, who: S, title: string, employmentType: string) => {
    const f = await api().post(`${org(o)}/facilities`).set('Cookie', who.cookie).send({ name: `${title} Hospital`, facilityType: 'hospital' });
    const l = (await api().post(`${org(o)}/facilities/${f.body.facility.id}/locations`).set('Cookie', who.cookie)
      .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' })).body.location.id as string;
    const id = (await api().post(`${org(o)}/jobs`).set('Cookie', who.cookie).send({
      title, description: 'Critical care nursing with strong staffing ratios and orientation support.', locationId: l, professionId: rnId, specialtyId: icuId,
      employmentType, payUnit: employmentType === 'permanent' ? 'year' : 'hour', minYearsExperience: 2 })).body.job.id as string;
    await api().put(`${org(o)}/jobs/${id}/requirements`).set('Cookie', who.cookie).send({ requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }] });
    return id;
  };
  jobId = await mkJob(orgA, owner, 'ICU Nurse', 'permanent');
  expect((await api().post(`${org(orgA)}/jobs/${jobId}/status`).set('Cookie', owner.cookie).send({ to: 'published' })).status).toBe(200);
  jobB = await mkJob(orgB, ownerB, 'Beta ICU Nurse', 'permanent');
  expect((await api().post(`${org(orgB)}/jobs/${jobB}/status`).set('Cookie', ownerB.cookie).send({ to: 'published' })).status).toBe(200);
  shiftJobId = await mkJob(orgA, owner, 'Per diem ICU', 'per_diem'); // stays a draft

  pApplicant = await makePro('applicant.private@example.com');                    // verified; applies directly
  pPool = await makePro('pool.private@example.com');                              // verified; opted in
  pPending = await makePro('pending.private@example.com', { verified: false });   // submitted only; opted in
  pTherapist = await makePro('therapist.private@example.com', { professionId: ptId }); // other profession; opted in
  pHidden = await makePro('hidden.private@example.com');                          // verified; never opts in
  for (const s of [pPool, pPending, pTherapist]) await discoverable(s, true);
  expect((await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pApplicant.cookie).send({})).status).toBe(201);
});

describe('batch evaluator', () => {
  it('gives the same result as evaluating one candidate at a time', async () => {
    const ids = (await ctx.db.query<{ id: string }>('SELECT id FROM professionals ORDER BY id')).map((r) => r.id);
    const now = new Date();
    const batch = await evaluateMatches(ctx.db, { jobId, now, candidates: ids.map((professionalId) => ({ professionalId })) });
    expect(batch.size).toBe(ids.length);
    for (const id of ids) expect(batch.get(id)).toEqual(await evaluateMatch(ctx.db, { professionalId: id, jobId, shiftIds: [], now }));
    expect(new Set([...batch.values()].map((m) => m.eligibility.outcome))).toEqual(new Set(['eligible', 'pending_verification', 'ineligible']));
  });
});

describe('creating and reading a run', () => {
  let runId: string;

  it('ranks eligible applicants and opted-in talent, and lists everyone else with reasons', async () => {
    const created = await run({ scope: 'both' });
    expect(created.status).toBe(201);
    runId = created.body.run.id;
    // applicant + pool (eligible) and pending (pending_verification). The therapist is another profession and the hidden one never opted in.
    expect(created.body.run.candidateCount).toBe(3);
    expect(created.body.run.outcomes).toEqual({ eligible: 2, pending_verification: 1 });

    const got = await read(runId);
    expect(got.status).toBe(200);
    const results = got.body.results as any[];
    expect(results.map((r) => r.eligibility.outcome)).toEqual(['eligible', 'eligible', 'pending_verification']);
    expect(results.filter((r) => r.rank).map((r) => r.rank)).toEqual([1, 2]);
    expect(results.slice(0, 2).every((r) => r.score > 0 && r.factors.length === 7)).toBe(true);
    expect(results.slice(2).every((r) => r.rank === null && r.score === null && r.factors === null && r.eligibility.reasons.length > 0)).toBe(true);
    expect(got.body.run).toMatchObject({ rulesVersion: 'eligibility-v1', rankingVersion: 'ranking-v1', scope: 'both' });
    expect(got.body.note).toMatch(/advisory/i);
    expect((await read(runId, '?group=eligible')).body.total).toBe(2);
  });

  it('shows applicants by name but keeps talent anonymous', async () => {
    const results = (await read(runId)).body.results as any[];
    const applicant = results.filter((r) => r.source === 'applicant');
    const talent = results.filter((r) => r.source === 'talent');
    expect(applicant).toHaveLength(1);
    expect(applicant[0].applicant.name).toBe('Test User');
    expect(talent).toHaveLength(2);
    const raw = JSON.stringify(talent);
    for (const secret of PRIVATE) expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/credentialId|professional_id|professionalId|"email"/);
    expect(talent.every((t) => typeof t.talentRef === 'string' && t.talent.profession)).toBe(true);
    for (const p of await ctx.db.query<{ id: string }>('SELECT id FROM professionals')) expect(raw).not.toContain(p.id);
  });

  it('stores versioned, reviewable results and audits the run and each view', async () => {
    const rows = await ctx.db.query<any>('SELECT trigger, source, rank, outcome, rules_version, weights_version, application_id FROM candidate_matches WHERE run_id = $1 ORDER BY rank NULLS LAST', [runId]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.trigger === 'recommend' && r.rules_version === 'eligibility-v1')).toBe(true);
    expect(rows.filter((r) => r.source === 'applicant').every((r) => r.application_id)).toBe(true);
    const log = await ctx.db.query<any>(`SELECT action, metadata FROM audit_logs WHERE action IN ('match.run','match.run_viewed') AND target_id = $1`, [runId]);
    expect(log.map((l) => l.action)).toContain('match.run');
    expect(log.map((l) => l.action)).toContain('match.run_viewed');
    const meta = log.find((l) => l.action === 'match.run').metadata;
    expect(meta).toMatchObject({ scope: 'both', candidates: 3 });
    expect(JSON.stringify(log)).not.toMatch(/Test User|private@example/);
    expect((await api().get(`${org(orgA)}/jobs/${jobId}/match-runs`).set('Cookie', readonly.cookie)).body.runs).toHaveLength(1);
  });

  it('never changes an application or sends an invitation', async () => {
    const [{ n: apps }] = await ctx.db.query<any>('SELECT count(*) AS n FROM applications');
    const [{ n: invites }] = await ctx.db.query<any>('SELECT count(*) AS n FROM talent_invitations');
    await run({ scope: 'both' });
    expect((await ctx.db.query<any>('SELECT count(*) AS n FROM applications'))[0].n).toBe(apps);
    expect((await ctx.db.query<any>('SELECT count(*) AS n FROM talent_invitations'))[0].n).toBe(invites);
    expect((await ctx.db.query<any>(`SELECT status FROM applications`))[0].status).toBe('submitted');
  });

  it('lets a facility invite a candidate through the existing invitation flow', async () => {
    const pool = ((await read(runId)).body.results as any[]).find((r) => r.source === 'talent' && r.eligibility.outcome === 'eligible');
    const ok = await api().post(`${org(orgA)}/talent/invitations`).set('Cookie', recruiter.cookie).send({ talentRef: pool.talentRef, jobId });
    expect(ok.status).toBe(201);
  });

  it('leaves out talent who opted out after the run, and says so', async () => {
    await discoverable(pPending, false);
    const got = await read(runId);
    expect(got.body.total).toBe(2);
    expect(got.body.hiddenSinceRun).toBe(1);
    expect((got.body.results as any[]).some((r) => r.eligibility.outcome === 'pending_verification')).toBe(false);
    await discoverable(pPending, true);
  });

  it('supports applicants-only (the default) and talent-only scopes', async () => {
    const only = await run({});
    expect(only.body.run.candidateCount).toBe(1);
    const talentOnly = await run({ scope: 'talent' });
    expect(talentOnly.body.run.candidateCount).toBe(2);
    const results = (await read(talentOnly.body.run.id)).body.results as any[];
    expect(results.every((r) => r.source === 'talent')).toBe(true);
  });

  it('pages results', async () => {
    const page = await read(runId, '?pageSize=2&page=2');
    expect(page.body.results).toHaveLength(1);
    expect(page.body.total).toBe(3);
    expect(page.body.results[0].eligibility.outcome).toBe('pending_verification');
  });
});

describe('access control', () => {
  it('requires the talent-search permission and an approved organization to create a run', async () => {
    expect((await run({}, scheduler)).status).toBe(403);
    expect((await run({}, readonly)).status).toBe(403);
    expect((await api().post(`${org(orgA)}/jobs/${jobId}/match-runs`).send({})).status).toBe(401);
    await ctx.db.query(`UPDATE organizations SET status = 'under_review' WHERE id = $1`, [orgA]);
    expect((await run({ scope: 'talent' })).status).toBe(403);
    await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [orgA]);
  });

  it('lets read-only members read runs but not create them', async () => {
    const runs = (await api().get(`${org(orgA)}/jobs/${jobId}/match-runs`).set('Cookie', readonly.cookie)).body.runs as any[];
    expect(runs.length).toBeGreaterThan(0);
    expect((await read(runs[0].id, '', readonly)).status).toBe(200);
  });

  it('isolates organizations', async () => {
    const [existing] = (await api().get(`${org(orgA)}/jobs/${jobId}/match-runs`).set('Cookie', recruiter.cookie)).body.runs as any[];
    expect((await read(existing.id, '', ownerB, orgB)).status).toBe(404);               // another org's run id under my own org
    expect((await read(existing.id, '', ownerB, orgA)).status).toBe(404);               // non-member of org A
    expect((await run({}, ownerB, orgB, jobId)).status).toBe(404);                      // org A's job from org B
    expect((await run({}, recruiter, orgA, jobB)).status).toBe(404);                    // org B's job from org A
    expect((await api().get(`${org(orgA)}/jobs/${jobB}/match-runs`).set('Cookie', recruiter.cookie)).status).toBe(404);
    const created = await run({}, ownerB, orgB, jobB);
    expect(created.status).toBe(201);
    expect(created.body.run.candidateCount).toBe(0);
  });
});

describe('validation and integrity', () => {
  it('refuses jobs that are not open and bad shift selections', async () => {
    expect((await run({}, recruiter, orgA, shiftJobId)).status).toBe(409);               // draft job
    expect((await run({ scope: 'everyone' })).status).toBe(422);
    expect((await run({ shiftIds: ['not-a-uuid'] })).status).toBe(422);
    expect((await run({ shiftIds: ['0b8c1d6e-2f0a-4c55-9a43-6a1f7a0f9b11'] })).status).toBe(422); // permanent job: no shifts
  });

  it('keeps stored results append-only', async () => {
    await expect(ctx.db.query(`UPDATE candidate_matches SET outcome = 'eligible' WHERE run_id IS NOT NULL`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`UPDATE match_runs SET candidate_count = 0`)).rejects.toThrow(/append-only/);
    // A recommendation must belong to a run, and a run result must not claim an application-flow trigger.
    const [m] = await ctx.db.query<any>('SELECT organization_id, job_id, professional_id, rules_version FROM candidate_matches WHERE run_id IS NOT NULL LIMIT 1');
    const insert = (trigger: string, runId: string | null) => ctx.db.query(
      `INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, rules_version, weights_version) VALUES ($1,$2,$3,$4,$5,'eligible','{}'::jsonb,$6,0)`,
      [runId, m.organization_id, m.job_id, m.professional_id, trigger, m.rules_version]);
    await expect(insert('recommend', null)).rejects.toThrow();
    await expect(insert('apply', null)).rejects.toThrow();
  });
});

describe('review findings', () => {
  // Pool member's stated minimum is 4800 cents/hour (see makePro). ADR 0005: a facility never sees a pay expectation.
  async function hourlyJob() {
    const [{ location_id }] = await ctx.db.query<any>('SELECT location_id FROM jobs WHERE id = $1', [jobId]);
    const id = (await api().post(`${org(orgA)}/jobs`).set('Cookie', owner.cookie).send({
      title: 'Hourly ICU', description: 'Critical care nursing with strong staffing ratios and orientation support.', locationId: location_id, professionId: rnId,
      specialtyId: icuId, employmentType: 'per_diem', payUnit: 'hour', payMinCents: 3500, payMaxCents: 4000, minYearsExperience: 2 })).body.job.id as string;
    await api().put(`${org(orgA)}/jobs/${id}/requirements`).set('Cookie', owner.cookie).send({ requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }] });
    const start = new Date(Date.now() + 10 * 86_400_000); start.setUTCHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 3_600_000);
    await api().post(`${org(orgA)}/jobs/${id}/shifts`).set('Cookie', owner.cookie).send({ startsAt: start.toISOString(), endsAt: end.toISOString(), positions: 1, hourlyRateCents: 4000 });
    expect((await api().post(`${org(orgA)}/jobs/${id}/status`).set('Cookie', owner.cookie).send({ to: 'published' })).status).toBe(200);
    return id;
  }

  it('does not reveal a professional\'s pay expectation in factor details', async () => {
    const hourly = await hourlyJob();
    expect((await api().post(`/api/v1/jobs/${hourly}/apply`).set('Cookie', pApplicant.cookie).send({})).status).toBe(201);
    const created = await run({ scope: 'both' }, recruiter, orgA, hourly);
    expect(created.status).toBe(201);
    const got = await read(created.body.run.id);
    const raw = JSON.stringify(got.body.results);
    expect(raw).not.toContain('4800');
    for (const r of got.body.results as any[]) {
      if (!r.factors) continue;
      const pay = r.factors.find((f: any) => f.key === 'compensation');
      expect(pay).toMatchObject({ withheld: true, value: null, contribution: null });
    }
    // The existing application detail page must not reveal it either.
    const [{ id: appId }] = await ctx.db.query<any>('SELECT id FROM applications WHERE job_id = $1', [hourly]);
    const detail = await api().get(`${org(orgA)}/applications/${appId}`).set('Cookie', recruiter.cookie);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('4800');
    expect(detail.body.ranking.factors).toHaveLength(7);
  });

  it('shows anonymous talent only to members who may search for talent', async () => {
    const created = await run({ scope: 'both' });
    const asReadOnly = await read(created.body.run.id, '', readonly);
    expect(asReadOnly.status).toBe(200);
    expect((asReadOnly.body.results as any[]).every((r) => r.source === 'applicant')).toBe(true);
    expect(asReadOnly.body.total).toBe(1);
    expect(JSON.stringify(asReadOnly.body)).not.toContain('talentRef');
    const asRecruiter = await read(created.body.run.id);
    expect((asRecruiter.body.results as any[]).some((r) => r.source === 'talent')).toBe(true);
    // An organization that is no longer approved loses talent visibility on stored runs too.
    await ctx.db.query(`UPDATE organizations SET status = 'under_review' WHERE id = $1`, [orgA]);
    expect(((await read(created.body.run.id)).body.results as any[]).every((r) => r.source === 'applicant')).toBe(true);
    await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [orgA]);
  });

  it('loads candidates in batches: query count does not grow with the number of candidates', async () => {
    const ids = (await ctx.db.query<{ id: string }>('SELECT id FROM professionals ORDER BY id')).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    const counted = () => { let n = 0; return { n: () => n, db: { query: (s: string, p?: unknown[]) => { n++; return ctx.db.query(s, p); }, exec: ctx.db.exec } as typeof ctx.db }; };
    const one = counted(), many = counted();
    await evaluateMatches(one.db, { jobId, now: new Date(), candidates: [{ professionalId: ids[0]! }] });
    await evaluateMatches(many.db, { jobId, now: new Date(), candidates: ids.map((professionalId) => ({ professionalId })) });
    expect(many.n()).toBe(one.n());
    expect(one.n()).toBeLessThanOrEqual(14);
  });
});
