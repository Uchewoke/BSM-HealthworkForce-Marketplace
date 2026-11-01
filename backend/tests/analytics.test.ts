import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let ownerA: S, recruiter: S, scheduler: S, ownerB: S, reviewer: S;
let pro1: S, pro2: S, finMember: S, finance: S, platformAdmin: S;
let orgA: string, orgB: string, jobId: string, shiftId: string, rnId: string, icuId: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
const base = '/api/v1/professionals/me';
const orgUrl = (org = orgA) => `/api/v1/organizations/${org}`;
const allDays = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '23:59' }));
const LICENSE = { kind: 'license', credentialType: 'RN', jurisdiction: 'GA', number: 'RN-1234567', issueDate: '2023-01-01', expirationDate: '2099-01-01' };
const BLS = { kind: 'certification', credentialType: 'BLS', issueDate: '2025-01-01', expirationDate: '2099-01-01' };

const decideCred = (id: string, to: string, extra: object = {}) =>
  api().post(`/api/v1/admin/credentials/${id}/status`).set('Cookie', reviewer.cookie).send({ to, ...extra });

async function addCredential(p: S, body: object, verify = true) {
  const c = (await api().post(`${base}/credentials`).set('Cookie', p.cookie).send(body)).body.credential;
  await api().post(`${base}/credentials/${c.id}/documents`).set('Cookie', p.cookie).set('Content-Type', 'application/pdf').send(PDF);
  expect((await api().post(`${base}/credentials/${c.id}/submit`).set('Cookie', p.cookie)).status).toBe(200);
  if (verify) {
    await decideCred(c.id, 'pending_review');
    expect((await decideCred(c.id, 'verified', { method: 'primary_source', sourceReference: 'Nursys lookup 2026-10-30' })).status).toBe(200);
  }
}

async function makePro(email: string, verify: boolean) {
  const s = await ctx.userWithSession(email);
  await api().post('/api/v1/professionals').set('Cookie', s.cookie).send({ professionId: rnId, state: 'GA' });
  await api().put(`${base}/specialties`).set('Cookie', s.cookie).send({ specialtyIds: [icuId] });
  await api().post(`${base}/experience`).set('Cookie', s.cookie).send({ employer: 'Hospital', title: 'RN', specialtyId: icuId, startDate: '2015-01-01', isCurrent: true });
  await api().put(`${base}/availability`).set('Cookie', s.cookie).send({ windows: allDays });
  await api().put(`${base}/preferences`).set('Cookie', s.cookie).send({ employmentTypes: ['per_diem'], shiftTypes: ['day'], preferredStates: ['GA'], minHourlyRateCents: 4500 });
  await addCredential(s, LICENSE, verify);
  await addCredential(s, BLS, verify);
  return s;
}

const proId = async (s: S) => (await ctx.db.query<{ id: string }>('SELECT id FROM professionals WHERE user_id = $1', [s.id]))[0]!.id;
const notifs = async (s: S) => (await api().get('/api/v1/notifications').set('Cookie', s.cookie)).body.notifications as any[];

beforeAll(async () => {
  ctx = await makeTestApp();
  ownerA = await ctx.userWithSession('owner.a@example.com');
  recruiter = await ctx.userWithSession('recruiter@example.com');
  scheduler = await ctx.userWithSession('scheduler@example.com');
  ownerB = await ctx.userWithSession('owner.b@example.com');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  finMember = await ctx.userWithSession('fin.member@example.com');
  finance = await ctx.adminSession('finance@bsm.example', 'finance_admin');
  platformAdmin = await ctx.adminSession('padmin@bsm.example', 'platform_admin');

  orgA = (await api().post('/api/v1/organizations').set('Cookie', ownerA.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'scheduler')`, [orgA, recruiter.id, scheduler.id]);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'finance')`, [orgA, finMember.id]);

  const f = await api().post(`${orgUrl()}/facilities`).set('Cookie', ownerA.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
  const locA = (await api().post(`${orgUrl()}/facilities/${f.body.facility.id}/locations`).set('Cookie', ownerA.cookie)
    .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' })).body.location.id;

  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', ownerA.cookie)).body.professions as any[];
  const rn = tax.find((p) => p.code === 'rn');
  rnId = rn.id;
  icuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;

  const jobsUrl = `${orgUrl()}/jobs`;
  jobId = (await api().post(jobsUrl).set('Cookie', ownerA.cookie).send({
    title: 'ICU Nurse', description: 'Critical care nursing in a 24-bed ICU with excellent staffing support.', locationId: locA, professionId: rnId, specialtyId: icuId,
    employmentType: 'per_diem', payMinCents: 5000, payMaxCents: 6500, minYearsExperience: 2,
  })).body.job.id as string;
  await api().put(`${jobsUrl}/${jobId}/requirements`).set('Cookie', ownerA.cookie).send({ requirements: [
    { kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }, { kind: 'certification', credentialType: 'BLS' }] });
  const d = new Date(Date.now() + 10 * 86_400_000);
  const at = (h: number) => { const x = new Date(d); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
  shiftId = (await api().post(`${jobsUrl}/${jobId}/shifts`).set('Cookie', ownerA.cookie).send({ startsAt: at(14), endsAt: at(22), positions: 2, hourlyRateCents: 5500 })).body.shift.id as string;
  expect((await api().post(`${jobsUrl}/${jobId}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' })).status).toBe(200);

  pro1 = await makePro('pro1@example.com', true);
  pro2 = await makePro('pro2@example.com', false); // credentials submitted but never verified
});

const admin = (s: S = finance) => ({ get: (u: string) => api().get(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie), post: (u: string, b: object = {}) => api().post(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie).send(b), put: (u: string, b: object) => api().put(`/api/v1/admin/billing${u}`).set('Cookie', s.cookie).send(b) });
const period = () => ({ periodStart: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10), periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const stats = (s: S, query = '', org = orgA) => api().get(`${orgUrl(org)}/analytics${query}`).set('Cookie', s.cookie);

describe('analytics', () => {
  let assignmentId: string;

  beforeAll(async () => {
    const app1 = (await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pro1.cookie).send({ shiftIds: [shiftId] })).body.application.id as string;
    const o = await api().post(`${orgUrl()}/applications/${app1}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId });
    assignmentId = (await api().post(`${base}/shift-offers/${o.body.offer.id}/respond`).set('Cookie', pro1.cookie).send({ response: 'accepted' })).body.assignmentId as string;
    // The shift has two positions and one is filled. It ran 8 hours, today.
    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [shiftId]);
    expect((await api().put(`${base}/assignments/${assignmentId}/timesheet`).set('Cookie', pro1.cookie).send({ workedStart: hoursAgo(10), workedEnd: hoursAgo(2), breakMinutes: 0 })).status).toBe(200);
    const tsId = (await api().get(`${orgUrl()}/timesheets`).set('Cookie', recruiter.cookie)).body.timesheets[0].id;
    expect((await api().post(`${orgUrl()}/timesheets/${tsId}/review`).set('Cookie', recruiter.cookie).send({ decision: 'approve' })).status).toBe(200);
  });

  it('reports fill, outcomes, time to fill and the application funnel for the period', async () => {
    const res = await stats(ownerA);
    expect(res.status).toBe(200);
    expect(res.body.range).toMatchObject({ days: 90, bucket: 'week' });
    expect(res.body.fill).toMatchObject({ positionsPosted: 2, positionsFilled: 1, fillRate: 50 });
    expect(res.body.trend.reduce((s: number, t: any) => s + t.positionsPosted, 0)).toBe(2);
    expect(res.body.trend.length).toBeGreaterThanOrEqual(13);
    expect(res.body.byProfession).toEqual([{ profession: expect.any(String), positionsPosted: 2, positionsFilled: 1, fillRate: 50 }]);
    expect(res.body.outcomes).toMatchObject({ completed: 1, noShow: 0, finished: 1, completionRate: 100, noShowRate: 0, cancellationRate: 0 });
    expect(res.body.timeToFill.sample).toBe(1);
    expect(res.body.timeToFill.medianHours).toBeGreaterThanOrEqual(0);
    expect(res.body.funnel).toMatchObject({ applications: 1, viaAgency: 0, offersSent: 1, offersAccepted: 1, offerAcceptanceRate: 100 });
  });

  it('reports staffing cost from approved hours, only to roles with billing access', async () => {
    const owner = await stats(ownerA);
    expect(owner.body.includesCosts).toBe(true);
    expect(owner.body.costs).toMatchObject({ approvedHours: 8, agreedPayCents: 44_000, averageHourlyRateCents: 5500, platformFeesInvoicedCents: 0 });
    expect(owner.body.costs.byProfession).toHaveLength(1);
    expect((await stats(finMember)).body.costs.approvedHours).toBe(8); // finance has billing.read
    const sched = await stats(scheduler); // jobs.read but not billing.read
    expect(sched.status).toBe(200);
    expect(sched.body.includesCosts).toBe(false);
    expect(sched.body.costs).toBeUndefined();
    expect(JSON.stringify(sched.body)).not.toMatch(/agreedPay|payCents|platformFees/);
  });

  it('counts only invoiced fees once an invoice is issued', async () => {
    await admin().put('/fee', { bps: 1000 });
    const created = await admin().post('/invoices', { organizationId: orgA, ...period() });
    expect(created.status).toBe(201);
    await admin().post(`/invoices/${created.body.invoice.id}/issue`, {});
    const c = (await stats(ownerA)).body.costs;
    expect(c.platformFeesInvoicedCents).toBe(4400);
    expect(c.platformFeesPaidCents).toBe(0);
  });

  it('keeps one organization out of another\'s numbers', async () => {
    expect((await stats(ownerB)).status).toBe(404); // not a member of orgA
    const own = await stats(ownerB, '', orgB);
    expect(own.status).toBe(200);
    expect(own.body.fill).toMatchObject({ positionsPosted: 0, positionsFilled: 0, fillRate: null });
    expect(own.body.costs.agreedPayCents).toBe(0);
    expect((await api().get(`${orgUrl()}/analytics`)).status).toBe(401);
  });

  it('honours the requested period and rejects bad ones', async () => {
    const past = await stats(ownerA, '?from=2020-01-01&to=2020-01-31');
    expect(past.body.fill).toMatchObject({ positionsPosted: 0, positionsFilled: 0, fillRate: null });
    expect(past.body.trend.every((t: any) => t.positionsPosted === 0)).toBe(true);
    const long = await stats(ownerA, '?from=2026-01-01&to=2026-08-01');
    expect(long.body.range.bucket).toBe('month');
    expect(long.body.trend).toHaveLength(8);
    expect((await stats(ownerA, '?from=2026-02-01&to=2026-01-01')).status).toBe(422);
    expect((await stats(ownerA, '?from=2024-01-01&to=2026-01-01')).status).toBe(422);
    expect((await stats(ownerA, '?from=yesterday')).status).toBe(422);
  });

  it('gives agencies their own submission and placement figures', async () => {
    const agOwner = await ctx.userWithSession('agency.owner@example.com');
    const agency = (await api().post('/api/v1/organizations').set('Cookie', agOwner.cookie).send({ name: 'Care Staffing Co', type: 'agency' })).body.organization.id as string;
    await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [agency]);
    const ag = `/api/v1/organizations/${agency}/agency`;
    await api().post(`${ag}/roster/invitations`).set('Cookie', agOwner.cookie).send({ email: 'pro2@example.com' });
    const rosterId = (await api().get(`${base}/agencies`).set('Cookie', pro2.cookie)).body.agencies[0].id;
    await api().post(`${base}/agencies/${rosterId}/respond`).set('Cookie', pro2.cookie).send({ response: 'accept' });
    await api().post(`${orgUrl()}/jobs/${jobId}/agencies`).set('Cookie', ownerA.cookie).send({ agencyId: agency });
    const [{ id: pid }] = await ctx.db.query<{ id: string }>('SELECT id FROM professionals WHERE user_id = $1', [pro2.id]) as [{ id: string }];
    // The shift has started, so keep the job listable with a future one.
    await ctx.db.query(`INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions) SELECT job_id, organization_id, now() + interval '3 days', now() + interval '3 days 8 hours', 1 FROM shifts WHERE id = $1`, [shiftId]);
    expect((await api().post(`${ag}/jobs/${jobId}/submissions`).set('Cookie', agOwner.cookie).send({ professionalId: pid })).status).toBe(201);

    const res = await api().get(`${ag}/analytics`).set('Cookie', agOwner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ submissions: 1, placements: 0, placementRate: 0, approvedHours: 0 });
    expect(res.body.byStatus).toEqual([{ status: 'submitted', count: 1 }]);
    expect(res.body.byFacility).toEqual([{ facility: 'Alpha Health', submissions: 1, placements: 0 }]);
    expect(res.body.trend.reduce((s: number, t: any) => s + t.submissions, 0)).toBe(1);
    expect((await api().get(`/api/v1/organizations/${orgA}/agency/analytics`).set('Cookie', ownerA.cookie)).status).toBe(403); // a facility is not an agency
    expect((await api().get(`${ag}/analytics`).set('Cookie', ownerA.cookie)).status).toBe(404); // not a member
  });
});
