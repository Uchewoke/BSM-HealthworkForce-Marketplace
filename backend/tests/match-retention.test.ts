import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLEANUP_LEASE, eraseProfessionalMatchData, previewMatchRetention, runMatchRetention, startMatchRetentionScheduler,
} from '../src/modules/matching/retention.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let owner: S, recruiter: S, proA: S, proB: S, superAdmin: S, platformAdmin: S, reviewer: S, auditor: S;
let orgId: string, jobId: string, profA: string, profB: string, rnId: string;
const A = '/api/v1/admin/match-retention';
const sa = (method: 'get' | 'put' | 'post' | 'delete', path: string, body?: object, s: S = superAdmin) => {
  const r = api()[method](`${A}${path}`).set('Cookie', s.cookie);
  return body ? r.send(body) : r;
};
const DAY = 86_400_000;
const n = async (sql: string, args: unknown[] = []) => Number((await ctx.db.query<{ n: string }>(sql, args))[0]!.n);

async function seedRun(daysOld: number, professionalIds: string[] = []) {
  const [run] = await ctx.db.query<{ id: string }>(
    `INSERT INTO match_runs (organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count, created_at)
     VALUES ($1,$2,'talent',$3,'eligibility-v1','ranking-v1',0,$4, now() - ($5 || ' days')::interval) RETURNING id`, [orgId, jobId, owner.id, professionalIds.length, String(daysOld)]);
  for (const p of professionalIds) {
    await ctx.db.query(
      `INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, outcome, eligibility, rules_version, weights_version)
       VALUES ($1,$2,$3,$4,'recommend','talent','needs_review','{"reasons":[]}'::jsonb,'eligibility-v1',0)`, [run!.id, orgId, jobId, p]);
  }
  return run!.id;
}
const hasRun = async (id: string) => (await n('SELECT count(*) AS n FROM match_runs WHERE id = $1', [id])) === 1;
const resultCount = (id: string) => n('SELECT count(*) AS n FROM candidate_matches WHERE run_id = $1', [id]);
const snapshot = async () => ({
  applications: await n('SELECT count(*) AS n FROM applications'), decision: await n('SELECT count(*) AS n FROM candidate_matches WHERE run_id IS NULL'),
  assignments: await n('SELECT count(*) AS n FROM assignments'), credentials: await n('SELECT count(*) AS n FROM credentials'),
  professionals: await n('SELECT count(*) AS n FROM professionals'), users: await n('SELECT count(*) AS n FROM users'),
  audit: await n('SELECT count(*) AS n FROM audit_logs'), history: await n('SELECT count(*) AS n FROM retention_runs'),
  runs: await n('SELECT count(*) AS n FROM match_runs'), results: await n('SELECT count(*) AS n FROM candidate_matches WHERE run_id IS NOT NULL'),
  refs: await n('SELECT count(*) AS n FROM talent_refs'), holds: await n('SELECT count(*) AS n FROM match_run_holds'),
});
const resetRetention = () => ctx.db.query(`DELETE FROM platform_settings WHERE key = 'match_retention'`);
const clearAll = async () => { await ctx.db.query('DELETE FROM match_run_holds'); await ctx.db.query('DELETE FROM candidate_matches WHERE run_id IS NOT NULL'); await ctx.db.query('DELETE FROM match_runs'); };

beforeAll(async () => {
  ctx = await makeTestApp({ globalLimit: { max: 100_000, windowMs: 60_000 } });
  owner = await ctx.userWithSession('owner@alpha.example');
  recruiter = await ctx.userWithSession('recruiter@alpha.example');
  proA = await ctx.userWithSession('pro.a.private@example.com');
  proB = await ctx.userWithSession('pro.b.private@example.com');
  superAdmin = await ctx.adminSession('super@bsm.example', 'platform_super_admin');
  platformAdmin = await ctx.adminSession('admin@bsm.example', 'platform_admin');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  auditor = await ctx.adminSession('auditor@bsm.example', 'auditor');
  orgId = (await api().post('/api/v1/organizations').set('Cookie', owner.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter')`, [orgId, recruiter.id]);
  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', owner.cookie)).body.professions as any[];
  rnId = tax.find((p) => p.code === 'rn').id;
  const f = await api().post(`/api/v1/organizations/${orgId}/facilities`).set('Cookie', owner.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
  const l = (await api().post(`/api/v1/organizations/${orgId}/facilities/${f.body.facility.id}/locations`).set('Cookie', owner.cookie)
    .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' })).body.location.id as string;
  jobId = (await api().post(`/api/v1/organizations/${orgId}/jobs`).set('Cookie', owner.cookie).send({
    title: 'ICU Nurse', description: 'Critical care nursing with strong staffing ratios and orientation support.', locationId: l, professionId: rnId, employmentType: 'permanent', payUnit: 'year' })).body.job.id;
  await api().put(`/api/v1/organizations/${orgId}/jobs/${jobId}/requirements`).set('Cookie', owner.cookie).send({ requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }] });
  expect((await api().post(`/api/v1/organizations/${orgId}/jobs/${jobId}/status`).set('Cookie', owner.cookie).send({ to: 'published' })).status).toBe(200);
  for (const s of [proA, proB]) {
    await api().post('/api/v1/professionals').set('Cookie', s.cookie).send({ professionId: rnId, headline: 'Jane Doe, RN', summary: 'Call 404-555-0199', phone: '404-555-0199', city: 'Atlanta', state: 'GA' });
  }
  profA = (await ctx.db.query<{ id: string }>('SELECT id FROM professionals WHERE user_id = $1', [proA.id]))[0]!.id;
  profB = (await ctx.db.query<{ id: string }>('SELECT id FROM professionals WHERE user_id = $1', [proB.id]))[0]!.id;
});

describe('retention policy', () => {
  it('defaults to 90 days, is configurable within bounds, and changes are audited', async () => {
    const got = await sa('get', '/settings');
    expect(got.body).toMatchObject({ days: 90, version: 0, defaultDays: 90, minDays: 30, maxDays: 3650 });
    expect((await sa('put', '/settings', { days: 10 })).status).toBe(422);
    expect((await sa('put', '/settings', { days: 5000 })).status).toBe(422);
    expect((await sa('put', '/settings', { days: 45, extra: 1 })).status).toBe(422);
    const set = await sa('put', '/settings', { days: 45 });
    expect(set.body).toEqual({ days: 45, version: 1 });
    expect((await sa('get', '/settings')).body.days).toBe(45);
    expect(await n(`SELECT count(*) AS n FROM audit_logs WHERE action = 'admin.match_retention_updated'`)).toBe(1);
    await resetRetention();
  });

  it('uses the configured period when cleaning up', async () => {
    await clearAll();
    const run50 = await seedRun(50, [profA]);
    await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id });
    expect(await hasRun(run50)).toBe(true);                       // 50 days < 90
    await sa('put', '/settings', { days: 45 });
    await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id });
    expect(await hasRun(run50)).toBe(false);                      // 50 days > 45
    await resetRetention();
  });
});

describe('cleanup', () => {
  it('keeps runs younger than the period and removes older ones with their results', async () => {
    await clearAll();
    const young = await seedRun(10, [profA, profB]), edge = await seedRun(89, [profA]), old = await seedRun(100, [profA, profB]), older = await seedRun(400, [profB]);
    const before = await snapshot();
    const res = await sa('post', '/cleanup', {});
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ retentionDays: 90, runsDeleted: 2, resultsDeleted: 3, runsHeld: 0, moreRemaining: false });
    expect([await hasRun(young), await hasRun(edge), await hasRun(old), await hasRun(older)]).toEqual([true, true, false, false]);
    expect(await resultCount(young)).toBe(2);
    expect(await resultCount(old)).toBe(0);
    const after = await snapshot();
    expect(after.runs).toBe(before.runs - 2);
    expect(after.results).toBe(before.results - 3);
  });

  it('does not touch applications, decision snapshots, assignments, credentials, accounts or audit records', async () => {
    await clearAll();
    const [app] = await ctx.db.query<{ id: string }>('INSERT INTO applications (job_id, organization_id, professional_id) VALUES ($1,$2,$3) RETURNING id', [jobId, orgId, profA]);
    await ctx.db.query(
      `INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, rules_version, weights_version) VALUES ($1,$2,$3,$4,'apply','eligible','{}'::jsonb,'eligibility-v1',0)`,
      [app!.id, orgId, jobId, profA]);
    await seedRun(500, [profA, profB]);
    const before = await snapshot();
    await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id });
    const after = await snapshot();
    for (const k of ['applications', 'decision', 'assignments', 'credentials', 'professionals', 'users'] as const) expect(after[k], k).toBe(before[k]);
    expect(after.audit).toBeGreaterThanOrEqual(before.audit);     // audit only grows
    expect(after.runs).toBe(0);
    await ctx.db.query('DELETE FROM applications WHERE id = $1', [app!.id]);
  });

  it('keeps a run under legal hold until the hold is released, and skips it in dry runs too', async () => {
    await clearAll();
    const held = await seedRun(200, [profA]), free = await seedRun(200, [profB]);
    const hold = await sa('put', '/holds', { runIds: [held, held, '0b8c1d6e-2f0a-4c55-9a43-6a1f7a0f9b11'], reason: 'Matter 2026-114' });
    expect(hold.body).toMatchObject({ requested: 2, newlyHeld: 1, nowHeld: 1, notFound: 1 });
    const preview = await sa('post', '/cleanup', { dryRun: true });
    expect(preview.body.summary).toMatchObject({ runsExpired: 1, resultsExpired: 1, runsHeld: 1 });
    const done = await sa('post', '/cleanup', {});
    expect(done.body.summary).toMatchObject({ runsDeleted: 1, runsHeld: 1 });
    expect(await hasRun(held)).toBe(true);
    expect(await resultCount(held)).toBe(1);
    expect(await hasRun(free)).toBe(false);
    // The database itself refuses to delete a held run.
    await expect(ctx.db.query('DELETE FROM match_runs WHERE id = $1', [held])).rejects.toThrow();
    expect((await sa('get', '/holds')).body.holds).toHaveLength(1);
    expect((await sa('delete', `/holds/${held}`)).status).toBe(204);
    expect((await sa('delete', `/holds/${held}`)).status).toBe(404);
    await sa('post', '/cleanup', {});
    expect(await hasRun(held)).toBe(false);
  });

  it('can be run repeatedly without errors or further changes', async () => {
    await clearAll();
    await seedRun(300, [profA]);
    const first = await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id });
    const second = await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id });
    const third = await runMatchRetention(ctx.db, { mode: 'scheduled' });
    expect(first).toMatchObject({ runsDeleted: 1 });
    expect(second).toMatchObject({ runsDeleted: 0, resultsDeleted: 0, batches: 0, moreRemaining: false });
    expect(third).toMatchObject({ runsDeleted: 0 });
  });

  it('works in batches over a large dataset and reports what remains when it stops early', async () => {
    await clearAll();
    await ctx.db.query(
      `INSERT INTO match_runs (organization_id, job_id, scope, requested_by, rules_version, ranking_version, weights_version, candidate_count, created_at)
       SELECT $1, $2, 'talent', $3, 'eligibility-v1', 'ranking-v1', 0, 2, now() - interval '200 days' - (g || ' minutes')::interval FROM generate_series(1, 1200) g`, [orgId, jobId, owner.id]);
    await ctx.db.query(
      `INSERT INTO candidate_matches (run_id, organization_id, job_id, professional_id, trigger, source, outcome, eligibility, rules_version, weights_version)
       SELECT r.id, r.organization_id, r.job_id, gen_random_uuid(), 'recommend', 'talent', 'needs_review', '{}'::jsonb, 'eligibility-v1', 0 FROM match_runs r, generate_series(1, 2)`);
    const recent = await seedRun(5, [profA]);
    expect(await n('SELECT count(*) AS n FROM candidate_matches WHERE run_id IS NOT NULL')).toBe(2401);

    const partial = await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id, batchSize: 100, maxBatches: 3 });
    expect(partial).toMatchObject({ runsDeleted: 300, resultsDeleted: 600, batches: 3, moreRemaining: true, runsExpired: 900 });
    const rest = await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id, batchSize: 200 });
    expect(rest).toMatchObject({ runsDeleted: 900, resultsDeleted: 1800, batches: 5, moreRemaining: false });
    expect(await n('SELECT count(*) AS n FROM match_runs')).toBe(1);
    expect(await hasRun(recent)).toBe(true);
  });

  it('refuses to overlap another cleanup, and records failures without error messages', async () => {
    await clearAll();
    await seedRun(300, [profA]);
    await ctx.db.query(`INSERT INTO scheduler_leases (name, holder, expires_at) VALUES ($1, 'another-server', now() + interval '10 minutes')
     ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at`, [CLEANUP_LEASE]);
    expect(await runMatchRetention(ctx.db, { mode: 'scheduled' })).toBeNull();
    expect((await sa('post', '/cleanup', {})).status).toBe(409);
    expect(await n('SELECT count(*) AS n FROM match_runs')).toBe(1);
    await ctx.db.query('DELETE FROM scheduler_leases WHERE name = $1', [CLEANUP_LEASE]);

    const broken = { ...ctx.db, transaction: async () => { throw new TypeError('secret-value@example.com'); } } as typeof ctx.db;
    await expect(runMatchRetention(broken, { mode: 'manual', userId: superAdmin.id })).rejects.toThrow();
    const [failed] = await ctx.db.query<any>(`SELECT status, error_code, counts FROM retention_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`);
    expect(failed).toMatchObject({ status: 'failed', error_code: 'TypeError' });
    expect(JSON.stringify(failed)).not.toContain('secret-value');
    // A failure leaves the lease free and the data intact, so the next pass simply retries.
    expect(await runMatchRetention(ctx.db, { mode: 'manual', userId: superAdmin.id })).toMatchObject({ runsDeleted: 1 });
  });

  it('runs on a timer and records scheduled executions', async () => {
    await clearAll();
    const stale = await seedRun(300, [profA]);
    const stop = startMatchRetentionScheduler({ db: ctx.db }, 60_000, 20);
    await new Promise((r) => setTimeout(r, 1500));
    stop();
    expect(await hasRun(stale)).toBe(false);
    expect(await n(`SELECT count(*) AS n FROM retention_runs WHERE mode = 'scheduled' AND status = 'completed'`)).toBeGreaterThanOrEqual(1);
  });

  it('removes an expired run created through the API, which then reads as not found', async () => {
    await clearAll();
    await api().put('/api/v1/professionals/me/discoverability').set('Cookie', proA.cookie).send({ discoverable: true });
    const created = await api().post(`/api/v1/organizations/${orgId}/jobs/${jobId}/match-runs`).set('Cookie', recruiter.cookie).send({ scope: 'talent' });
    expect(created.status).toBe(201);
    const id = created.body.run.id as string;
    expect((await api().get(`/api/v1/organizations/${orgId}/match-runs/${id}`).set('Cookie', recruiter.cookie)).status).toBe(200);
    await ctx.db.transaction(async (tx) => {                              // tests only: bypass the update-protection trigger to age the run
      await tx.exec(`SET LOCAL session_replication_role = replica`);
      await tx.query(`UPDATE match_runs SET created_at = now() - interval '120 days' WHERE id = $1`, [id]);
    });
    await sa('post', '/cleanup', {});
    expect((await api().get(`/api/v1/organizations/${orgId}/match-runs/${id}`).set('Cookie', recruiter.cookie)).status).toBe(404);
    expect(await resultCount(id)).toBe(0);
  });
});

describe('professional erasure', () => {
  async function arrange() {
    await clearAll();
    await ctx.db.query('DELETE FROM talent_refs');
    await ctx.db.query('DELETE FROM applications');
    const r1 = await seedRun(10, [profA, profB]), r2 = await seedRun(20, [profA]), r3 = await seedRun(30, [profB]);
    await ctx.db.query(`INSERT INTO talent_refs (organization_id, professional_id, ref) VALUES ($1,$2,'ref-a-aaaaaaaaaaaaaaaa'), ($1,$3,'ref-b-bbbbbbbbbbbbbbbb')`, [orgId, profA, profB]);
    const [app] = await ctx.db.query<{ id: string }>('INSERT INTO applications (job_id, organization_id, professional_id) VALUES ($1,$2,$3) RETURNING id', [jobId, orgId, profA]);
    await ctx.db.query(
      `INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, rules_version, weights_version) VALUES ($1,$2,$3,$4,'apply','eligible','{}'::jsonb,'eligibility-v1',0)`,
      [app!.id, orgId, jobId, profA]);
    return { r1, r2, r3 };
  }
  const forA = (resultsOf: string) => n('SELECT count(*) AS n FROM candidate_matches WHERE run_id IS NOT NULL AND professional_id = $1', [resultsOf]);

  it('makes no database changes in dry-run mode (apart from its audit entry)', async () => {
    await arrange();
    const before = await snapshot();
    const res = await sa('post', '/erasure', { professionalId: profA, reference: 'DSR-2026-007' });   // dry run is the default
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ dryRun: true, resultsDeleted: 2, resultsHeld: 0, talentRefsDeleted: 1, talentRefsKept: 0, decisionSnapshotsKept: 1 });
    const after = await snapshot();
    expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 });
    expect(after.audit).toBe(before.audit + 1);
    expect((await sa('post', '/erasure', { professionalId: profA, dryRun: true })).body.summary.dryRun).toBe(true);
  });

  it('erases only the intended professional and keeps decision records, applications and audit history', async () => {
    const { r1, r2, r3 } = await arrange();
    const before = await snapshot();
    const res = await sa('post', '/erasure', { professionalId: profA, dryRun: false, reference: 'DSR-2026-007' });
    expect(res.body.summary).toMatchObject({ dryRun: false, resultsDeleted: 2, resultsHeld: 0, talentRefsDeleted: 1, talentRefsKept: 0, decisionSnapshotsKept: 1 });
    expect(await forA(profA)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM talent_refs WHERE professional_id = $1', [profA])).toBe(0);
    // Everyone else is untouched.
    expect(await forA(profB)).toBe(2);
    expect(await n('SELECT count(*) AS n FROM talent_refs WHERE professional_id = $1', [profB])).toBe(1);
    expect([await hasRun(r1), await hasRun(r2), await hasRun(r3)]).toEqual([true, true, true]);
    const after = await snapshot();
    for (const k of ['applications', 'decision', 'assignments', 'credentials', 'professionals', 'users'] as const) expect(after[k], k).toBe(before[k]);
    expect(after.results).toBe(before.results - 2);
    expect(after.refs).toBe(before.refs - 1);
    expect(after.audit).toBeGreaterThan(before.audit);
    expect(res.body.summary).not.toHaveProperty('professionalId');
  });

  it('is idempotent, handles professionals who no longer exist, and reports whether they can still be matched', async () => {
    await arrange();
    await sa('post', '/erasure', { professionalId: profA, dryRun: false });
    const again = await sa('post', '/erasure', { professionalId: profA, dryRun: false });
    expect(again.body.summary).toMatchObject({ resultsDeleted: 0, resultsHeld: 0, talentRefsDeleted: 0, decisionSnapshotsKept: 1 });
    const gone = await sa('post', '/erasure', { professionalId: '0b8c1d6e-2f0a-4c55-9a43-6a1f7a0f9b11', dryRun: false });
    expect(gone.body.summary).toMatchObject({ resultsDeleted: 0, talentRefsDeleted: 0, stillDiscoverable: null });
    await ctx.db.query('UPDATE professionals SET discoverable = true WHERE id = $1', [profB]);
    expect((await sa('post', '/erasure', { professionalId: profB, dryRun: true })).body.summary.stillDiscoverable).toBe(true);
    await ctx.db.query('UPDATE professionals SET discoverable = false WHERE id = $1', [profB]);
  });

  it('leaves results in a run under legal hold, and the reference that explains them', async () => {
    const { r1 } = await arrange();
    await sa('put', '/holds', { runIds: [r1], reason: 'Matter 2026-114' });
    const res = await sa('post', '/erasure', { professionalId: profA, dryRun: false });
    expect(res.body.summary).toMatchObject({ resultsDeleted: 1, resultsHeld: 1, talentRefsDeleted: 0, talentRefsKept: 1 });
    expect(await forA(profA)).toBe(1);
    expect(await n('SELECT count(*) AS n FROM talent_refs WHERE professional_id = $1', [profA])).toBe(1);
    // After the hold is released the erasure can be completed.
    await sa('delete', `/holds/${r1}`);
    const done = await sa('post', '/erasure', { professionalId: profA, dryRun: false });
    expect(done.body.summary).toMatchObject({ resultsDeleted: 1, resultsHeld: 0, talentRefsDeleted: 1 });
    expect(await forA(profA)).toBe(0);
  });

  it('can be called from code and rejects malformed requests', async () => {
    await arrange();
    const sum = await eraseProfessionalMatchData(ctx.db, { professionalId: profB, dryRun: true, userId: superAdmin.id, requestId: 'test' });
    expect(sum.resultsDeleted).toBe(2);
    expect((await sa('post', '/erasure', { professionalId: 'nope' })).status).toBe(422);
    expect((await sa('post', '/erasure', { professionalId: profA, reference: 'Jane Doe <jane@example.com>' })).status).toBe(422);
    expect((await sa('put', '/holds', { runIds: [], reason: 'ok ref' })).status).toBe(422);
    expect((await sa('put', '/holds', { runIds: [profA], reason: 'jane@example.com' })).status).toBe(422);
  });
});

describe('access control and records', () => {
  const endpoints: [('get' | 'put' | 'post' | 'delete'), string, object?][] = [
    ['get', '/settings'], ['put', '/settings', { days: 60 }], ['post', '/cleanup', {}], ['get', '/history'], ['get', '/holds'],
    ['put', '/holds', { runIds: ['0b8c1d6e-2f0a-4c55-9a43-6a1f7a0f9b11'], reason: 'Matter 1' }], ['delete', '/holds/0b8c1d6e-2f0a-4c55-9a43-6a1f7a0f9b11'],
    ['post', '/erasure', { professionalId: '0b8c1d6e-2f0a-4c55-9a43-6a1f7a0f9b11', dryRun: false }],
  ];

  it('is closed to everyone but a super admin', async () => {
    const before = await snapshot();
    for (const [method, path, body] of endpoints) {
      const anon = api()[method](`${A}${path}`); if (body) anon.send(body);
      expect((await anon).status, `anon ${method} ${path}`).toBe(401);
      for (const [who, s] of [['facility owner', owner], ['recruiter', recruiter], ['professional', proA], ['platform admin', platformAdmin], ['reviewer', reviewer], ['auditor', auditor]] as const) {
        expect((await sa(method, path, body, s)).status, `${who} ${method} ${path}`).toBe(403);
      }
    }
    const after = await snapshot();
    expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 });       // nothing changed
    expect((await sa('get', '/settings')).status).toBe(200);
  });

  it('records history as counts only, and audit entries without names, emails or credential data', async () => {
    const history = (await sa('get', '/history')).body.history as any[];
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((h) => h.kind === 'professional_erasure')).toBe(true);
    expect((await sa('get', '/history?kind=match_retention')).body.history.every((h: any) => h.kind === 'match_retention')).toBe(true);
    const raw = JSON.stringify(history);
    for (const secret of ['private@example.com', 'Test User', 'Jane Doe', '404-555', profA, profB]) expect(raw).not.toContain(secret);
    const audits = await ctx.db.query<any>(`SELECT action, metadata FROM audit_logs WHERE action LIKE 'match.retention%' OR action LIKE 'admin.match_%'`);
    expect(audits.length).toBeGreaterThan(5);
    const auditRaw = JSON.stringify(audits.map((a) => a.metadata));
    for (const secret of ['private@example.com', 'Test User', 'Jane Doe', '404-555', 'ref-a-aaaa', 'ref-b-bbbb']) expect(auditRaw).not.toContain(secret);
  });

  it('exposes only the preview when asked for a preview', async () => {
    await clearAll();
    await seedRun(400, [profA]);
    const before = await snapshot();
    const sum = await previewMatchRetention(ctx.db, { userId: superAdmin.id, requestId: 'test' });
    expect(sum).toMatchObject({ runsExpired: 1, resultsExpired: 1, runsDeleted: 0 });
    const after = await snapshot();
    expect({ ...after, audit: 0 }).toEqual({ ...before, audit: 0 });
  });
});

describe('erasure regression', () => {
  const fingerprint = async (pid: string) => (await ctx.db.query<{ h: string }>(
    `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (
       SELECT p::text AS x FROM professionals p WHERE id = $1
       UNION ALL SELECT c::text FROM candidate_matches c WHERE professional_id = $1
       UNION ALL SELECT t::text FROM talent_refs t WHERE professional_id = $1
       UNION ALL SELECT a::text FROM applications a WHERE professional_id = $1
       UNION ALL SELECT pr::text FROM professional_preferences pr WHERE professional_id = $1
       UNION ALL SELECT cr::text FROM credentials cr WHERE professional_id = $1) s`, [pid]))[0]!.h;
  const forPro = (runId: string, pid: string) => n('SELECT count(*) AS n FROM candidate_matches WHERE run_id = $1 AND professional_id = $2', [runId, pid]);
  const newRun = async () => {
    const res = await api().post(`/api/v1/organizations/${orgId}/jobs/${jobId}/match-runs`).set('Cookie', recruiter.cookie).send({ scope: 'talent' });
    expect(res.status).toBe(201);
    return res.body.run.id as string;
  };
  const discoverable = (s: S, on: boolean) => api().put('/api/v1/professionals/me/discoverability').set('Cookie', s.cookie).send({ discoverable: on });
  const erase = (professionalId: string, dryRun = false) => sa('post', '/erasure', { professionalId, dryRun, reference: 'DSR-2026-010' });

  it('erases an existing professional and leaves an unrelated professional byte-for-byte unchanged', async () => {
    await clearAll();
    await ctx.db.query('DELETE FROM talent_refs');
    await ctx.db.query('DELETE FROM applications');
    await seedRun(10, [profA, profB]); await seedRun(20, [profB]);
    await ctx.db.query(`INSERT INTO talent_refs (organization_id, professional_id, ref) VALUES ($1,$2,'ref-a-aaaaaaaaaaaaaaaa'), ($1,$3,'ref-b-bbbbbbbbbbbbbbbb')`, [orgId, profA, profB]);
    const [app] = await ctx.db.query<{ id: string }>('INSERT INTO applications (job_id, organization_id, professional_id) VALUES ($1,$2,$3) RETURNING id', [jobId, orgId, profB]);
    await ctx.db.query(
      `INSERT INTO candidate_matches (application_id, organization_id, job_id, professional_id, trigger, outcome, eligibility, rules_version, weights_version) VALUES ($1,$2,$3,$4,'apply','eligible','{}'::jsonb,'eligibility-v1',0)`,
      [app!.id, orgId, jobId, profB]);
    const bBefore = await fingerprint(profB);
    const aBefore = await fingerprint(profA);
    const res = await erase(profA);
    expect(res.body.summary).toMatchObject({ resultsDeleted: 1, talentRefsDeleted: 1, resultsHeld: 0 });
    expect(await fingerprint(profB)).toBe(bBefore);                       // nothing about the other professional changed
    expect(await fingerprint(profA)).not.toBe(aBefore);                   // and the target's matching data did
    expect(await n('SELECT count(*) AS n FROM professionals WHERE id = $1', [profA])).toBe(1);   // the account is not touched
    await ctx.db.query('DELETE FROM applications WHERE id = $1', [app!.id]);
  });

  it('erases matching data of a professional whose account no longer exists', async () => {
    await clearAll();
    const proC = await ctx.userWithSession('pro.c.private@example.com');
    await api().post('/api/v1/professionals').set('Cookie', proC.cookie).send({ professionId: rnId, headline: 'Jane Doe, RN', city: 'Atlanta', state: 'GA' });
    const profC = (await ctx.db.query<{ id: string }>('SELECT id FROM professionals WHERE user_id = $1', [proC.id]))[0]!.id;
    await seedRun(10, [profC, profB]);
    await ctx.db.query(`INSERT INTO talent_refs (organization_id, professional_id, ref) VALUES ($1,$2,'ref-c-cccccccccccccccc')`, [orgId, profC]);
    await ctx.db.query('DELETE FROM professionals WHERE id = $1', [profC]);                         // the account is gone; match results are linked by value
    expect(await n('SELECT count(*) AS n FROM candidate_matches WHERE professional_id = $1', [profC])).toBe(1);   // orphaned results remain
    const bBefore = await fingerprint(profB);
    const preview = await erase(profC, true);
    expect(preview.body.summary).toMatchObject({ dryRun: true, resultsDeleted: 1, stillDiscoverable: null });
    expect(await n('SELECT count(*) AS n FROM candidate_matches WHERE professional_id = $1', [profC])).toBe(1);
    const done = await erase(profC);
    expect(done.body.summary).toMatchObject({ dryRun: false, resultsDeleted: 1, stillDiscoverable: null });
    expect(await n('SELECT count(*) AS n FROM candidate_matches WHERE professional_id = $1', [profC])).toBe(0);
    expect((await erase(profC)).body.summary).toMatchObject({ resultsDeleted: 0 });                // idempotent
    expect(await fingerprint(profB)).toBe(bBefore);
  });

  it('keeps an opted-out, suspended, restricted or deleted professional out of future matching, and says plainly that erasure alone does not', async () => {
    await clearAll();
    expect((await discoverable(proA, true)).status).toBe(200);
    const run1 = await newRun();
    expect(await forPro(run1, profA)).toBe(1);                                                       // matched while discoverable
    const res = await erase(profA);
    expect(res.body.summary).toMatchObject({ resultsDeleted: 1, stillDiscoverable: true });         // the operator is told they can still appear
    expect(await forPro(run1, profA)).toBe(0);

    const run2 = await newRun();
    expect(await forPro(run2, profA)).toBe(1);                                                       // erasing past data does not stop future matching

    expect((await discoverable(proA, false)).status).toBe(200);                                      // opting out does
    await erase(profA);
    expect(await forPro(await newRun(), profA)).toBe(0);
    expect((await erase(profA, true)).body.summary.stillDiscoverable).toBe(false);

    await discoverable(proA, true);
    await ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [proA.id]);            // account suspended
    expect(await forPro(await newRun(), profA)).toBe(0);
    await ctx.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [proA.id]);
    await ctx.db.query(`UPDATE professionals SET account_status = 'restricted' WHERE id = $1`, [profA]);   // profile restricted
    expect(await forPro(await newRun(), profA)).toBe(0);
    await ctx.db.query(`UPDATE professionals SET account_status = 'active' WHERE id = $1`, [profA]);
    expect(await forPro(await newRun(), profA)).toBe(1);                                             // control: back to eligible for the pool
    await discoverable(proA, false);
  });
});
