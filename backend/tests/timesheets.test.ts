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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const putTs = (s: S, id: string, body: object) => api().put(`${base}/assignments/${id}/timesheet`).set('Cookie', s.cookie).send(body);
const review = (id: string, body: object, s: S = recruiter, org = orgA) => api().post(`${orgUrl(org)}/timesheets/${id}/review`).set('Cookie', s.cookie).send(body);
const GOOD = () => ({ workedStart: hoursAgo(10), workedEnd: hoursAgo(2), breakMinutes: 30, note: 'Covered a late admission' });

describe('timesheets', () => {
  let assignmentId: string, tsId: string;

  beforeAll(async () => {
    const app1 = (await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pro1.cookie).send({ shiftIds: [shiftId] })).body.application.id as string;
    const o = await api().post(`${orgUrl()}/applications/${app1}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId });
    const acc = await api().post(`${base}/shift-offers/${o.body.offer.id}/respond`).set('Cookie', pro1.cookie).send({ response: 'accepted' });
    assignmentId = acc.body.assignmentId as string;
  });

  it('cannot be submitted before the shift has started', async () => {
    const res = await putTs(pro1, assignmentId, GOOD());
    expect(res.status).toBe(409);
    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [shiftId]);
  });

  it('only the assigned professional can submit, and the hours must make sense', async () => {
    expect((await putTs(pro2, assignmentId, GOOD())).status).toBe(404);
    const bad = (b: object) => putTs(pro1, assignmentId, { ...GOOD(), ...b });
    expect((await bad({ workedEnd: hoursAgo(11) })).status).toBe(422); // ends before it starts
    expect((await bad({ workedEnd: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(422); // in the future
    expect((await bad({ breakMinutes: 600 })).status).toBe(422);
    expect((await bad({ breakMinutes: 480, workedStart: hoursAgo(10), workedEnd: hoursAgo(3) })).status).toBe(422); // break longer than the work
    expect((await bad({ workedStart: hoursAgo(40), workedEnd: hoursAgo(2) })).status).toBe(422); // more than 24h
    expect((await bad({ workedStart: hoursAgo(30), workedEnd: hoursAgo(26) })).status).toBe(422); // nowhere near the shift
    expect((await ctx.db.query('SELECT 1 FROM timesheets')).length).toBe(0);
  });

  it('records the net minutes and notifies the facility', async () => {
    const res = await putTs(pro1, assignmentId, GOOD());
    expect(res.status).toBe(200);
    expect(res.body.timesheet).toMatchObject({ status: 'submitted', minutesWorked: 450 });
    tsId = res.body.timesheet.id;
    expect((await notifs(recruiter)).some((n) => n.type === 'timesheet.submitted')).toBe(true);
    expect((await putTs(pro1, assignmentId, GOOD())).status).toBe(409); // waiting for review
    const mine = await api().get(`${base}/timesheets`).set('Cookie', pro1.cookie);
    expect(mine.body.timesheets[0]).toMatchObject({ assignment_id: assignmentId, status: 'submitted', minutes_worked: 450 });
  });

  it('keeps timesheets inside their organization and needs applications.manage to decide', async () => {
    expect((await api().get(`${orgUrl()}/timesheets`).set('Cookie', scheduler.cookie)).status).toBe(200); // read
    expect((await review(tsId, { decision: 'approve' }, scheduler)).status).toBe(403);
    expect((await review(tsId, { decision: 'approve' }, ownerB, orgB)).status).toBe(404);
    expect((await api().get(`${orgUrl(orgB)}/timesheets/${tsId}`).set('Cookie', ownerB.cookie)).status).toBe(404);
    expect((await api().get(`${base}/assignments/${assignmentId}/timesheet`).set('Cookie', pro2.cookie)).status).toBe(404);
  });

  it('returns a timesheet with a required reason, and lets the professional correct it', async () => {
    expect((await review(tsId, { decision: 'return' })).status).toBe(422);
    expect((await review(tsId, { decision: 'return', reason: 'Break was 45 minutes per the unit log.' })).status).toBe(200);
    const n = (await notifs(pro1)).find((x) => x.type === 'timesheet.returned');
    expect(n.body).toContain('45 minutes');
    expect((await review(tsId, { decision: 'approve' })).status).toBe(409); // not submitted any more
    const again = await putTs(pro1, assignmentId, { ...GOOD(), breakMinutes: 45 });
    expect(again.body.timesheet).toMatchObject({ status: 'submitted', minutesWorked: 435 });
    const detail = await api().get(`${orgUrl()}/timesheets/${tsId}`).set('Cookie', recruiter.cookie);
    expect(detail.body.events.map((e: any) => e.action)).toEqual(['submitted', 'returned', 'resubmitted']);
  });

  it('approves the hours, completes the assignment and then becomes final', async () => {
    expect((await review(tsId, { decision: 'approve' })).status).toBe(200);
    const [a] = await ctx.db.query<{ status: string }>('SELECT status FROM assignments WHERE id = $1', [assignmentId]);
    expect(a!.status).toBe('completed');
    expect((await notifs(pro1)).some((x) => x.type === 'timesheet.approved')).toBe(true);
    expect((await putTs(pro1, assignmentId, GOOD())).status).toBe(409);
    expect((await review(tsId, { decision: 'return', reason: 'Changed my mind' })).status).toBe(409);
    const actions = (await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE target_id = $1`, [tsId])).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['timesheet.submitted', 'timesheet.returned', 'timesheet.resubmitted', 'timesheet.approved']));
  });

  it('is not allowed for cancelled assignments', async () => {
    await ctx.db.query(`UPDATE assignments SET status = 'cancelled_by_facility' WHERE id = $1 RETURNING id`, [assignmentId]);
    await ctx.db.query('DELETE FROM timesheet_events');
    await ctx.db.query('DELETE FROM timesheets');
    expect((await putTs(pro1, assignmentId, GOOD())).status).toBe(409);
  });
});
