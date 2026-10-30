import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let ownerA: S, ownerB: S, ownerC: S, scheduler: S, recruiter: S, pro: S;
let orgA: string, orgB: string, orgC: string, locA: string, deptA: string, locB: string, rnId: string, icuId: string, ptId: string;

const iso = (offsetDays: number, hour = 7) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const jobsUrl = (org = orgA) => `/api/v1/organizations/${org}/jobs`;
const asA = (s: S = ownerA) => ({ Cookie: s.cookie });

async function makeOrg(owner: S, name: string, approved = true) {
  const id = (await api().post('/api/v1/organizations').set('Cookie', owner.cookie).send({ name, type: 'facility' })).body.organization.id as string;
  if (approved) await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [id]);
  return id;
}
async function makeLocation(owner: S, org: string, name: string) {
  const f = await api().post(`/api/v1/organizations/${org}/facilities`).set('Cookie', owner.cookie).send({ name: `${name} Hospital`, facilityType: 'hospital' });
  const l = await api().post(`/api/v1/organizations/${org}/facilities/${f.body.facility.id}/locations`).set('Cookie', owner.cookie)
    .send({ name: `${name} Campus`, addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' });
  return { facilityId: f.body.facility.id as string, locationId: l.body.location.id as string };
}
const draftJob = (extra: object = {}, org = orgA, who = ownerA) =>
  api().post(jobsUrl(org)).set('Cookie', who.cookie).send({
    title: 'ICU Staff Nurse', description: 'Care for critically ill adults in a 24-bed unit with strong staffing ratios.',
    locationId: locA, professionId: rnId, specialtyId: icuId, employmentType: 'per_diem', payMinCents: 4500, payMaxCents: 6500, ...extra,
  });
const setStatus = (id: string, to: string, who: S = ownerA, org = orgA, extra: object = {}) =>
  api().post(`${jobsUrl(org)}/${id}/status`).set('Cookie', who.cookie).send({ to, ...extra });
const putReqs = (id: string, requirements: object[], who: S = ownerA) => api().put(`${jobsUrl()}/${id}/requirements`).set('Cookie', who.cookie).send({ requirements });
const addShift = (id: string, extra: object = {}, who: S = ownerA) =>
  api().post(`${jobsUrl()}/${id}/shifts`).set('Cookie', who.cookie).send({ startsAt: iso(7, 7), endsAt: iso(7, 19), positions: 2, ...extra });
const RN_GA = [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }, { kind: 'certification', credentialType: 'BLS' }];

/** A ready-to-publish per-diem job. */
async function publishableJob(extra: object = {}) {
  const id = (await draftJob(extra)).body.job.id as string;
  await putReqs(id, RN_GA);
  await addShift(id);
  return id;
}
async function publishedJob(extra: object = {}) {
  const id = await publishableJob(extra);
  expect((await setStatus(id, 'published')).status).toBe(200);
  return id;
}
const search = (q: object = {}, who: S = pro) => api().get('/api/v1/jobs').query(q).set('Cookie', who.cookie);

beforeAll(async () => {
  ctx = await makeTestApp();
  ownerA = await ctx.userWithSession('owner.a@example.com');
  ownerB = await ctx.userWithSession('owner.b@example.com');
  ownerC = await ctx.userWithSession('owner.c@example.com');
  scheduler = await ctx.userWithSession('scheduler@example.com');
  recruiter = await ctx.userWithSession('recruiter@example.com');
  pro = await ctx.userWithSession('nurse@example.com');

  orgA = await makeOrg(ownerA, 'Alpha Health');
  orgB = await makeOrg(ownerB, 'Beta Health');
  orgC = await makeOrg(ownerC, 'Gamma Draft Org', false);
  const a = await makeLocation(ownerA, orgA, 'Alpha');
  locA = a.locationId;
  locB = (await makeLocation(ownerB, orgB, 'Beta')).locationId;
  deptA = (await api().post(`/api/v1/organizations/${orgA}/facilities/${a.facilityId}/locations/${locA}/departments`).set('Cookie', ownerA.cookie).send({ name: 'ICU' })).body.department.id;
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'scheduler'), ($1,$3,'recruiter')`, [orgA, scheduler.id, recruiter.id]);

  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', pro.cookie)).body.professions as any[];
  const rn = tax.find((p) => p.code === 'rn');
  rnId = rn.id;
  icuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;
  ptId = tax.find((p) => p.code === 'pt').id;
});

describe('creating and editing jobs', () => {
  it('requires an approved organization to create jobs', async () => {
    const res = await api().post(jobsUrl(orgC)).set('Cookie', ownerC.cookie).send({ title: 'Nurse', locationId: locA, professionId: rnId, employmentType: 'permanent' });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ organizationStatus: 'draft' });
  });

  it('enforces roles: scheduler can create, recruiter cannot', async () => {
    expect((await draftJob({}, orgA, recruiter)).status).toBe(403);
    expect((await draftJob({ title: 'Scheduler draft' }, orgA, scheduler)).status).toBe(201);
    expect((await api().get(jobsUrl()).set('Cookie', recruiter.cookie)).status).toBe(200);
  });

  it('validates input and references', async () => {
    expect((await draftJob({ title: 'x' })).status).toBe(422);
    expect((await draftJob({ employmentType: 'gig' })).status).toBe(422);
    expect((await draftJob({ payMinCents: 9000, payMaxCents: 5000 })).status).toBe(422);
    expect((await draftJob({ payUnit: 'hour', payMaxCents: 5_000_000 })).status).toBe(422);
    expect((await draftJob({ applicationDeadline: iso(-1) })).status).toBe(422);
    expect((await draftJob({ positionsCount: 0 })).status).toBe(422);
    expect((await draftJob({ locationId: locB })).status).toBe(422); // another organization's location
    expect((await draftJob({ departmentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
    expect((await draftJob({ professionId: ptId })).status).toBe(422); // specialty belongs to RN
    const ok = await draftJob({ departmentId: deptA, applicationDeadline: iso(30) });
    expect(ok.status).toBe(201);
    expect(ok.body.job.status).toBe('draft');
  });

  it('does not let a client-supplied status or organization id through', async () => {
    const res = await draftJob({ status: 'published', organization_id: orgB, organizationId: orgB });
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('draft');
    const [row] = await ctx.db.query<{ organization_id: string }>('SELECT organization_id FROM jobs WHERE id = $1', [res.body.job.id]);
    expect(row!.organization_id).toBe(orgA);
  });

  it('validates requirements and keeps them draft-only', async () => {
    const id = (await draftJob()).body.job.id;
    expect((await putReqs(id, [{ kind: 'license', credentialType: 'RN' }])).status).toBe(422); // license needs a state
    expect((await putReqs(id, [{ kind: 'certification' }])).status).toBe(422);
    expect((await putReqs(id, [{ kind: 'other' }])).status).toBe(422);
    expect((await putReqs(id, [{ kind: 'certification', credentialType: 'BLS' }, { kind: 'certification', credentialType: 'bls' }])).status).toBe(409); // duplicate
    const ok = await putReqs(id, [...RN_GA, { kind: 'other', description: 'Two years of ICU experience preferred', mandatory: false }]);
    expect(ok.status).toBe(200);
    expect(ok.body.requirements).toHaveLength(3);
    expect(ok.body.requirements.find((r: any) => r.kind === 'license')).toMatchObject({ jurisdiction: 'GA', mandatory: true });
    expect((await putReqs(id, RN_GA, recruiter)).status).toBe(403);
  });

  it('validates shifts', async () => {
    const id = (await draftJob()).body.job.id;
    expect((await addShift(id, { startsAt: iso(-1, 7), endsAt: iso(-1, 19) })).status).toBe(422); // past
    expect((await addShift(id, { startsAt: iso(5, 19), endsAt: iso(5, 7) })).status).toBe(422); // ends before start
    expect((await addShift(id, { startsAt: iso(5, 0), endsAt: iso(7, 0) })).status).toBe(422); // > 24h
    expect((await addShift(id, { startsAt: iso(900, 7), endsAt: iso(900, 19) })).status).toBe(422); // too far ahead
    expect((await addShift(id, { startsAt: '2030-01-01T07:00:00', endsAt: '2030-01-01T19:00:00' })).status).toBe(422); // needs an offset
    expect((await addShift(id, { positions: 500 })).status).toBe(422);
    const ok = await addShift(id, { startsAt: iso(7, 19), endsAt: new Date(new Date(iso(7, 19)).getTime() + 12 * 3600_000).toISOString() }); // overnight
    expect(ok.status).toBe(201);
    const perm = (await draftJob({ employmentType: 'permanent', payUnit: 'year', payMinCents: 9_000_000, payMaxCents: 12_000_000 })).body.job.id;
    expect((await addShift(perm)).status).toBe(409);
  });
});

describe('publishing', () => {
  it('lists every unmet requirement instead of publishing an incomplete job', async () => {
    const id = (await draftJob({ description: 'Too short' })).body.job.id;
    const res = await setStatus(id, 'published');
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing).toEqual(expect.arrayContaining(['description', 'requirements', 'shifts']));
    expect((await api().get(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie)).body.job.status).toBe('draft');
  });

  it('requires an explicit statement when there are no credential requirements', async () => {
    const id = (await draftJob({ employmentType: 'permanent', payUnit: 'year' })).body.job.id;
    expect((await setStatus(id, 'published')).body.error.details.missing).toContain('requirements');
    await api().patch(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie).send({ noCredentialRequirements: true });
    await putReqs(id, RN_GA);
    expect((await setStatus(id, 'published')).body.error.details.missing).toContain('requirements_conflict');
    await putReqs(id, [{ kind: 'other', description: 'Friendly attitude', mandatory: false }]);
    expect((await setStatus(id, 'published')).status).toBe(200);
  });

  it('only roles with publish permission can publish; others can still pause and close', async () => {
    const id = await publishableJob();
    expect((await setStatus(id, 'published', scheduler)).status).toBe(403);
    expect((await setStatus(id, 'published', recruiter)).status).toBe(403);
    expect((await setStatus(id, 'published')).status).toBe(200);
    expect((await setStatus(id, 'paused', scheduler)).status).toBe(200);
    expect((await setStatus(id, 'published', scheduler)).status).toBe(403); // resuming = publishing
    expect((await setStatus(id, 'published')).status).toBe(200);
  });

  it('freezes structural fields and requirements once published, but allows safe edits', async () => {
    const id = await publishedJob();
    const patch = (b: object) => api().patch(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie).send(b);
    const frozen = await patch({ professionId: ptId, employmentType: 'permanent' });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.details.fields).toEqual(expect.arrayContaining(['professionId', 'employmentType']));
    expect((await putReqs(id, [{ kind: 'certification', credentialType: 'ACLS' }])).status).toBe(409);
    expect((await patch({ title: 'ICU Staff Nurse (Nights)', payMaxCents: 7000 })).status).toBe(200);
    expect((await patch({ payMinCents: 99999 })).status).toBe(422); // min above max
    // Shift edits: cancel is allowed, retiming is not.
    const detail = (await api().get(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie)).body;
    const shiftId = detail.shifts[0].id;
    const sp = (b: object) => api().patch(`${jobsUrl()}/${id}/shifts/${shiftId}`).set('Cookie', ownerA.cookie).send(b);
    expect((await sp({ positions: 9 })).status).toBe(409);
    expect((await api().delete(`${jobsUrl()}/${id}/shifts/${shiftId}`).set('Cookie', ownerA.cookie)).status).toBe(409);
    expect((await addShift(id, { startsAt: iso(8, 7), endsAt: iso(8, 19) })).status).toBe(201); // adding is fine
    expect((await sp({ status: 'cancelled' })).body.shift.status).toBe('cancelled');
  });

  it('follows the lifecycle state machine and records history', async () => {
    const id = await publishedJob();
    expect((await setStatus(id, 'draft')).status).toBe(422); // not an allowed target
    expect((await setStatus(id, 'paused')).status).toBe(200);
    expect((await setStatus(id, 'paused')).status).toBe(409);
    expect((await setStatus(id, 'closed', ownerA, orgA, { reason: 'Position filled elsewhere' })).status).toBe(200);
    expect((await setStatus(id, 'published')).status).toBe(409); // terminal
    expect((await api().patch(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie).send({ title: 'Reopened?' })).status).toBe(409);
    const d = (await api().get(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie)).body;
    expect(d.history.map((h: any) => h.to_status)).toEqual(['draft', 'published', 'paused', 'closed']);
    expect(d.shifts.every((s: any) => s.status === 'cancelled')).toBe(true); // closing cancels open shifts
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'job.status.closed' AND target_id = $1`, [id]);
    expect(log).toBeTruthy();
  });

  it('blocks publishing when the organization is suspended', async () => {
    const id = await publishableJob();
    await ctx.db.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [orgA]);
    expect((await setStatus(id, 'published')).status).toBe(403);
    expect((await draftJob()).status).toBe(403);
    await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [orgA]);
  });
});

describe('opportunity search', () => {
  let perm: string, shiftJob: string;

  beforeAll(async () => {
    shiftJob = await publishedJob({ title: 'Night ICU RN Alpha', description: 'Night shift critical care coverage with 100% paid orientation_included.' });
    perm = (await draftJob({
      title: 'Permanent Day RN', description: 'Permanent day position in our medical-surgical unit with great benefits.', employmentType: 'permanent',
      payUnit: 'year', payMinCents: 8_000_000, payMaxCents: 9_500_000, specialtyId: null,
    })).body.job.id;
    await putReqs(perm, RN_GA);
    await setStatus(perm, 'published');
    // Another tenant's job
    const bId = (await api().post(jobsUrl(orgB)).set('Cookie', ownerB.cookie).send({
      title: 'Beta PT Role', description: 'Outpatient physical therapy role at Beta with flexible schedules.', locationId: locB, professionId: ptId, employmentType: 'permanent', payUnit: 'year', noCredentialRequirements: true,
    })).body.job.id;
    expect((await setStatus(bId, 'published', ownerB, orgB)).status).toBe(200);
  });

  it('requires sign-in', async () => {
    expect((await api().get('/api/v1/jobs')).status).toBe(401);
  });

  it('shows only published jobs from approved organizations, with facility display info', async () => {
    const res = await search({ pageSize: 50 });
    expect(res.status).toBe(200);
    const titles = res.body.jobs.map((j: any) => j.title);
    expect(titles).toEqual(expect.arrayContaining(['Night ICU RN Alpha', 'Permanent Day RN', 'Beta PT Role']));
    expect(titles).not.toContain('Scheduler draft');
    const item = res.body.jobs.find((j: any) => j.title === 'Night ICU RN Alpha');
    expect(item).toMatchObject({ organization_name: 'Alpha Health', city: 'Atlanta', state: 'GA', timezone: 'America/New_York', profession: 'Registered Nurse', specialty: 'Critical Care / ICU' });
    expect(Number(item.open_shifts)).toBeGreaterThan(0);
    expect(item.next_shift_at).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/created_by|organization_id|owner\.a@/);
  });

  it('filters by profession, specialty, state, type, pay and shift window', async () => {
    expect((await search({ professionId: ptId })).body.jobs.map((j: any) => j.title)).toEqual(['Beta PT Role']);
    expect((await search({ specialtyId: icuId })).body.jobs.every((j: any) => j.specialty === 'Critical Care / ICU')).toBe(true);
    expect((await search({ state: 'ga' })).body.total).toBeGreaterThanOrEqual(3);
    expect((await search({ state: 'TX' })).body.total).toBe(0);
    expect((await search({ employmentType: 'permanent' })).body.jobs.map((j: any) => j.employment_type)).not.toContain('per_diem');
    expect((await search({ minPayCents: 6000 })).body.jobs.map((j: any) => j.id)).toContain(shiftJob); // hourly max 6500
    expect((await search({ minPayCents: 7000 })).body.jobs.map((j: any) => j.id)).not.toContain(shiftJob);
    expect((await search({ minPayCents: 9_000_000, payUnit: 'year' })).body.jobs.map((j: any) => j.id)).toContain(perm);
    const inWindow = await search({ shiftFrom: iso(6, 0), shiftTo: iso(8, 23) });
    expect(inWindow.body.jobs.map((j: any) => j.id)).toContain(shiftJob);
    const outside = await search({ shiftFrom: iso(60, 0), shiftTo: iso(61, 0) });
    expect(outside.body.jobs.map((j: any) => j.id)).not.toContain(shiftJob);
  });

  it('text search is safe: wildcards are literal and injection is inert', async () => {
    expect((await search({ q: 'night icu' })).body.jobs.map((j: any) => j.title)).toContain('Night ICU RN Alpha');
    expect((await search({ q: '%' })).body.jobs.map((j: any) => j.title)).toContain('Night ICU RN Alpha'); // literal "%" appears in its description
    expect((await search({ q: '%' })).body.total).toBe(1);
    expect((await search({ q: '_' })).body.total).toBe(1); // literal underscore
    const inj = await search({ q: "'; DROP TABLE jobs; --" });
    expect(inj.status).toBe(200);
    expect(inj.body.total).toBe(0);
    expect((await ctx.db.query('SELECT count(*) FROM jobs'))[0]).toBeTruthy();
  });

  it('paginates and sorts only by allowlisted fields', async () => {
    const p1 = await search({ pageSize: 2, page: 1, sort: 'pay_max', order: 'desc' });
    const p2 = await search({ pageSize: 2, page: 2, sort: 'pay_max', order: 'desc' });
    expect(p1.body.jobs).toHaveLength(2);
    expect(p1.body.total).toBeGreaterThanOrEqual(3);
    const ids = [...p1.body.jobs, ...p2.body.jobs].map((j: any) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await search({ sort: 'created_by' })).status).toBe(422);
    expect((await search({ sort: 'title; DROP' })).status).toBe(422);
    expect((await search({ pageSize: 500 })).status).toBe(422);
    expect((await search({ page: 0 })).status).toBe(422);
    expect((await search({ state: 'Georgia' })).status).toBe(422);
    expect((await search({ professionId: 'nope' })).status).toBe(422);
  });

  it('hides jobs that are paused, past deadline, out of shifts, or from a suspended organization', async () => {
    const visible = async (id: string) => (await search({ pageSize: 50 })).body.jobs.some((j: any) => j.id === id);
    const j = await publishedJob({ title: 'Visibility Probe' });
    expect(await visible(j)).toBe(true);
    await setStatus(j, 'paused');
    expect(await visible(j)).toBe(false);
    expect((await api().get(`/api/v1/jobs/${j}`).set('Cookie', pro.cookie)).status).toBe(404);
    await setStatus(j, 'published');
    expect(await visible(j)).toBe(true);

    await ctx.db.query(`UPDATE jobs SET application_deadline = now() - interval '1 hour' WHERE id = $1`, [j]);
    expect(await visible(j)).toBe(false);
    await ctx.db.query(`UPDATE jobs SET application_deadline = NULL WHERE id = $1`, [j]);

    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '8 hours' WHERE job_id = $1`, [j]);
    expect(await visible(j)).toBe(false); // no future open shift remains

    await ctx.db.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [orgB]);
    expect((await search({ professionId: ptId })).body.total).toBe(0);
    await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [orgB]);
    expect((await search({ professionId: ptId })).body.total).toBe(1);
  });

  it('shows job detail with requirements and only future open shifts; drafts are not visible', async () => {
    const d = await api().get(`/api/v1/jobs/${shiftJob}`).set('Cookie', pro.cookie);
    expect(d.status).toBe(200);
    expect(d.body.requirements.map((r: any) => r.credential_type)).toEqual(expect.arrayContaining(['RN', 'BLS']));
    expect(d.body.shifts.length).toBeGreaterThan(0);
    const draft = (await draftJob({ title: 'Secret Draft' })).body.job.id;
    expect((await api().get(`/api/v1/jobs/${draft}`).set('Cookie', pro.cookie)).status).toBe(404);
    expect((await api().get('/api/v1/jobs/not-a-uuid').set('Cookie', pro.cookie)).status).toBe(422);
  });
});

describe('tenant isolation for jobs', () => {
  it('other organizations cannot read or change a job, by either path', async () => {
    const id = await publishedJob({ title: 'Tenant Probe' });
    const shiftId = (await api().get(`${jobsUrl()}/${id}`).set('Cookie', ownerA.cookie)).body.shifts[0].id;
    for (const org of [orgA, orgB]) {
      const url = `${jobsUrl(org)}/${id}`;
      expect((await api().get(url).set('Cookie', ownerB.cookie)).status).toBe(404);
      expect((await api().patch(url).set('Cookie', ownerB.cookie).send({ title: 'Hijacked' })).status).toBe(404);
      expect((await api().post(`${url}/status`).set('Cookie', ownerB.cookie).send({ to: 'cancelled' })).status).toBe(404);
      expect((await api().put(`${url}/requirements`).set('Cookie', ownerB.cookie).send({ requirements: [] })).status).toBe(404);
      expect((await api().post(`${url}/shifts`).set('Cookie', ownerB.cookie).send({ startsAt: iso(9, 7), endsAt: iso(9, 19) })).status).toBe(404);
      expect((await api().patch(`${url}/shifts/${shiftId}`).set('Cookie', ownerB.cookie).send({ status: 'cancelled' })).status).toBe(404);
    }
    const [row] = await ctx.db.query<{ title: string; status: string }>('SELECT title, status FROM jobs WHERE id = $1', [id]);
    expect(row).toMatchObject({ title: 'Tenant Probe', status: 'published' });
    const list = (await api().get(jobsUrl(orgB)).set('Cookie', ownerB.cookie)).body.jobs.map((j: any) => j.id);
    expect(list).not.toContain(id);
  });

  it('a shift id from one job cannot be used through another job', async () => {
    const j1 = await publishableJob(), j2 = await publishableJob();
    const s1 = (await api().get(`${jobsUrl()}/${j1}`).set('Cookie', ownerA.cookie)).body.shifts[0].id;
    expect((await api().patch(`${jobsUrl()}/${j2}/shifts/${s1}`).set('Cookie', ownerA.cookie).send({ notes: 'cross-wired' })).status).toBe(404);
    expect((await api().delete(`${jobsUrl()}/${j2}/shifts/${s1}`).set('Cookie', ownerA.cookie)).status).toBe(404);
  });

  it('the database refuses a job pointing at another organization\'s location', async () => {
    await expect(ctx.db.query(
      `INSERT INTO jobs (organization_id, location_id, title, profession_id, employment_type, created_by)
       VALUES ($1,$2,'Bad',$3,'permanent',$4)`, [orgA, locB, rnId, ownerA.id])).rejects.toThrow();
  });

  it('draft job lists are paginated and filterable by status', async () => {
    const list = await api().get(`${jobsUrl()}?status=draft&pageSize=2`).set('Cookie', ownerA.cookie);
    expect(list.status).toBe(200);
    expect(list.body.jobs.length).toBeLessThanOrEqual(2);
    expect(list.body.jobs.every((j: any) => j.status === 'draft')).toBe(true);
    expect((await api().get(`${jobsUrl()}?pageSize=1000`).set('Cookie', ownerA.cookie)).status).toBe(422);
  });
});
