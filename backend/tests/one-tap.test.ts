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

const offersOf = async (s: S) => { const r = await api().get(`${base}/shift-offers`).set('Cookie', s.cookie); return r.body.offers as any[]; };
const answer = (s: S, offer: string, response: 'accepted' | 'declined') => api().post(`${base}/shift-offers/${offer}/respond`).set('Cookie', s.cookie).send({ response });
const undo = (s: S, assignment: string) => api().post(`${base}/assignments/${assignment}/undo`).set('Cookie', s.cookie);
const reliabilityOf = async (s: S) => (await api().get(`${base}/reviews`).set('Cookie', s.cookie)).body.reliability;
const extraShift = async (daysAhead: number) => (await ctx.db.query<{ id: string }>(
  `INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions, hourly_rate_cents, notes)
   VALUES ($1,$2, ((date_trunc('day', (now() AT TIME ZONE 'UTC') + make_interval(days => $3::int)) + interval '14 hours') AT TIME ZONE 'UTC'),
                  ((date_trunc('day', (now() AT TIME ZONE 'UTC') + make_interval(days => $3::int)) + interval '22 hours') AT TIME ZONE 'UTC'), 1, 5500, 'Park in lot B. Badge pickup at the front desk.') RETURNING id`,
  [jobId, orgA, daysAhead]))[0]!.id;

describe('shift offers: decide with full details, accept in one tap, undo within minutes', () => {
  let appId: string, shiftA: string, shiftB: string, offerA: string, assignmentA: string;

  beforeAll(async () => {
    shiftA = await extraShift(20);
    shiftB = await extraShift(22);
    appId = (await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pro1.cookie).send({ shiftIds: [shiftA] })).body.application.id as string;
    await ctx.db.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3)', [appId, shiftB, orgA]);
  });

  it('shows where, when, how much, what is required, the conditions, and whether you qualify right now', async () => {
    const o = await api().post(`${orgUrl()}/applications/${appId}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId: shiftA, message: 'Please arrive 15 minutes early.' });
    expect(o.status).toBe(201);
    offerA = o.body.offer.id;
    const offer = (await offersOf(pro1)).find((x) => x.id === offerA);
    expect(offer).toMatchObject({ organization_name: 'Alpha Health', location_name: 'Main', address_line1: '1 Main St', city: 'Atlanta', state: 'GA', hourly_rate_cents: 5500, message: 'Please arrive 15 minutes early.', shift_notes: expect.stringContaining('Park in lot B') });
    expect(offer.starts_at).toEqual(expect.any(String));
    expect(offer.requirements.map((r: any) => `${r.credential_type}:${r.mandatory}`).sort()).toEqual(['BLS:true', 'RN:true']);
    expect(offer.eligibility).toMatchObject({ outcome: 'eligible', reasons: [] });
    const single = await api().get(`${base}/shift-offers/${offerA}`).set('Cookie', pro1.cookie);
    expect(single.body.offer.requirements).toHaveLength(2);
  });

  it('warns before you accept if you would not qualify, and refuses the acceptance', async () => {
    await ctx.db.query(`UPDATE credentials SET status = 'revoked' WHERE professional_id = $1 AND credential_type = 'BLS'`, [await proId(pro1)]);
    const offer = (await offersOf(pro1)).find((x) => x.id === offerA);
    expect(offer.eligibility.outcome).not.toBe('eligible');
    expect(offer.eligibility.reasons.length).toBeGreaterThan(0);
    expect((await answer(pro1, offerA, 'accepted')).status).toBe(409);
    await ctx.db.query(`UPDATE credentials SET status = 'verified' WHERE professional_id = $1 AND credential_type = 'BLS'`, [await proId(pro1)]);
    expect((await offersOf(pro1)).find((x) => x.id === offerA).eligibility.outcome).toBe('eligible');
  });

  it('books on one accept, and says what happens next and how to undo', async () => {
    const res = await answer(pro1, offerA, 'accepted');
    expect(res.status).toBe(200);
    assignmentA = res.body.assignmentId;
    expect(new Date(res.body.undoUntil).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(new Date(res.body.undoUntil).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 2000);
    expect(res.body.nextSteps).toHaveLength(3);
    expect(res.body.nextSteps.join(' ')).toMatch(/Timesheets/);
    const offer = (await offersOf(pro1)).find((x) => x.id === offerA);
    expect(offer).toMatchObject({ status: 'accepted', assignment_id: assignmentA, assignment_status: 'confirmed' });
    expect((await notifs(recruiter)).some((n) => n.type === 'shift_offer.accepted')).toBe(true);
    expect((await answer(pro1, offerA, 'declined')).status).toBe(409); // answered once
  });

  it('lets the professional take it back within the window, with no reason and no mark on their record', async () => {
    expect((await undo(pro2, assignmentA)).status).toBe(404); // not theirs
    const res = await undo(pro1, assignmentA);
    expect(res.status).toBe(200);
    expect(res.body.assignment.status).toBe('cancelled_by_professional');
    const [a] = await ctx.db.query<{ status: string; undone_at: Date | null }>('SELECT status, undone_at FROM assignments WHERE id = $1', [assignmentA]);
    expect(a!.undone_at).not.toBeNull();
    const [shift] = await ctx.db.query<{ status: string }>('SELECT status FROM shifts WHERE id = $1', [shiftA]);
    expect(shift!.status).toBe('open'); // the facility can fill it again
    const [h] = await ctx.db.query<{ reason: string }>(`SELECT reason FROM assignment_status_history WHERE assignment_id = $1 AND to_status = 'cancelled_by_professional'`, [assignmentA]);
    expect(h!.reason).toMatch(/Undone/);
    expect((await notifs(recruiter)).some((n) => n.type === 'assignment.undone')).toBe(true);
    const rel = await reliabilityOf(pro1);
    expect(rel).toMatchObject({ cancellations: 0, lateCancellations: 0 });
    expect((await undo(pro1, assignmentA)).status).toBe(409); // already cancelled
    const [log] = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'assignment.undone' AND target_id = $1`, [assignmentA]);
    expect(log).toBeDefined();
  });

  it('closes the window after five minutes: then a normal cancellation needs a reason and counts', async () => {
    const o = await api().post(`${orgUrl()}/applications/${appId}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId: shiftB });
    const accepted = await answer(pro1, o.body.offer.id, 'accepted');
    expect(accepted.status).toBe(200);
    const asg = accepted.body.assignmentId as string;
    await ctx.db.query(`UPDATE assignments SET created_at = now() - interval '10 minutes' WHERE id = $1`, [asg]);
    const late = await undo(pro1, asg);
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/undo window has passed/);
    expect((await api().post(`${base}/assignments/${asg}/cancel`).set('Cookie', pro1.cookie).send({})).status).toBe(422); // reason required
    expect((await api().post(`${base}/assignments/${asg}/cancel`).set('Cookie', pro1.cookie).send({ reason: 'Family emergency' })).status).toBe(200);
    expect((await reliabilityOf(pro1)).cancellations).toBe(1); // only the real cancellation counts
  });

  it('cannot undo a shift that has already started', async () => {
    const s = await extraShift(25);
    await ctx.db.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3)', [appId, s, orgA]);
    const o = await api().post(`${orgUrl()}/applications/${appId}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId: s });
    const asg = (await answer(pro1, o.body.offer.id, 'accepted')).body.assignmentId as string;
    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '1 hour', ends_at = now() + interval '7 hours' WHERE id = $1`, [s]);
    const res = await undo(pro1, asg);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already started/);
  });

  it('asks for a reason once someone has undone three bookings in 30 days, and staff can see the pattern', async () => {
    const pid = await proId(pro1);
    // One undo already happened in this file. Mark two more as undone earlier this month.
    await ctx.db.query(`UPDATE assignments SET undone_at = now() - interval '2 days' WHERE professional_id = $1 AND undone_at IS NULL`, [pid]);
    const s2 = await extraShift(28);
    await ctx.db.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3)', [appId, s2, orgA]);
    const o = await api().post(`${orgUrl()}/applications/${appId}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId: s2 });
    const asg = (await answer(pro1, o.body.offer.id, 'accepted')).body.assignmentId as string;
    const refused = await undo(pro1, asg);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.fieldErrors.reason).toBeDefined();
    expect(refused.body.error.message).toMatch(/undone 3 bookings/);
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM assignments WHERE id = $1', [asg]))[0]!.status).toBe('confirmed'); // nothing happened
    const ok = await api().post(`${base}/assignments/${asg}/undo`).set('Cookie', pro1.cookie).send({ reason: 'Double-booked myself by mistake' });
    expect(ok.status).toBe(200);
    const [h] = await ctx.db.query<{ reason: string }>(`SELECT reason FROM assignment_status_history WHERE assignment_id = $1 AND to_status = 'cancelled_by_professional'`, [asg]);
    expect(h!.reason).toContain('Double-booked myself by mistake');
    const staff = await api().get(`/api/v1/admin/users/${pro1.id}`).set('Cookie', platformAdmin.cookie);
    expect(staff.body.professional.undoneLast30Days).toBeGreaterThanOrEqual(4);
    expect(staff.body.professional.undoneTotal).toBeGreaterThanOrEqual(4);
  });
});
