import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let ownerA: S, recruiter: S, scheduler: S, ownerB: S, reviewer: S;
let pro1: S, pro2: S;
let orgA: string, orgB: string, jobId: string, shiftId: string, shift2Id: string, rnId: string, icuId: string;

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

const apply = async (s: S, shiftIds: string[]) => {
  const res = await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', s.cookie).send({ shiftIds });
  expect(res.status).toBe(201);
  return res.body.application.id as string;
};
const offer = (appId: string, shift: string, s: S = recruiter, org = orgA, body: object = {}) =>
  api().post(`${orgUrl(org)}/applications/${appId}/shift-offers`).set('Cookie', s.cookie).send({ shiftId: shift, ...body });
const respond = (offerId: string, response: string, s: S) => api().post(`${base}/shift-offers/${offerId}/respond`).set('Cookie', s.cookie).send({ response });
const asgStatus = (id: string, to: string, reason?: string, s: S = recruiter) =>
  api().post(`${orgUrl()}/assignments/${id}/status`).set('Cookie', s.cookie).send({ to, reason });
const notifs = async (s: S) => (await api().get('/api/v1/notifications').set('Cookie', s.cookie)).body.notifications as any[];

beforeAll(async () => {
  ctx = await makeTestApp();
  ownerA = await ctx.userWithSession('owner.a@example.com');
  recruiter = await ctx.userWithSession('recruiter@example.com');
  scheduler = await ctx.userWithSession('scheduler@example.com');
  ownerB = await ctx.userWithSession('owner.b@example.com');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');

  orgA = (await api().post('/api/v1/organizations').set('Cookie', ownerA.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'scheduler')`, [orgA, recruiter.id, scheduler.id]);
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
  const at = (days: number, h: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
  const mkShift = async (days: number, positions: number) =>
    (await api().post(`${jobsUrl}/${jobId}/shifts`).set('Cookie', ownerA.cookie).send({ startsAt: at(days, 14), endsAt: at(days, 22), positions, hourlyRateCents: 5500 })).body.shift.id as string;
  shiftId = await mkShift(10, 1);
  shift2Id = await mkShift(10, 2); // overlaps shiftId on purpose
  expect((await api().post(`${jobsUrl}/${jobId}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' })).status).toBe(200);

  pro1 = await makePro('pro1@example.com', true);
  pro2 = await makePro('pro2@example.com', false); // credentials submitted but never verified
});

describe('shift offers', () => {
  let app1: string, offerId: string, assignmentId: string;

  it('refuses an offer to a candidate who is not eligible and records the refusal', async () => {
    const app2 = await apply(pro2, [shiftId]);
    const res = await offer(app2, shiftId);
    expect(res.status).toBe(409);
    const [row] = await ctx.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'shift_offer.refused_ineligible'`);
    expect(Number(row!.n)).toBe(1);
    expect((await ctx.db.query('SELECT 1 FROM shift_offers')).length).toBe(0);
  });

  it('needs applications.manage and the right organization', async () => {
    app1 = await apply(pro1, [shiftId, shift2Id]);
    expect((await offer(app1, shiftId, scheduler)).status).toBe(403);
    expect((await offer(app1, shiftId, ownerB, orgB)).status).toBe(404);
    expect([403, 404]).toContain((await offer(app1, shiftId, ownerB, orgA)).status);
  });

  it('sends an offer, defaulting the rate from the shift, and notifies the professional', async () => {
    const res = await offer(app1, shiftId, recruiter, orgA, { message: 'Welcome aboard' });
    expect(res.status).toBe(201);
    offerId = res.body.offer.id;
    expect((await offer(app1, shiftId)).status).toBe(409); // already pending
    const list = await api().get(`${base}/shift-offers`).set('Cookie', pro1.cookie);
    expect(list.body.offers[0]).toMatchObject({ id: offerId, status: 'sent', hourly_rate_cents: 5500 });
    expect((await notifs(pro1)).some((n) => n.type === 'shift_offer.sent')).toBe(true);
  });

  it('hides offers from other professionals and organizations', async () => {
    expect((await api().get(`${base}/shift-offers/${offerId}`).set('Cookie', pro2.cookie)).status).toBe(404);
    expect((await respond(offerId, 'accepted', pro2)).status).toBe(404);
    expect((await api().get(`${orgUrl(orgB)}/shift-offers`).set('Cookie', ownerB.cookie)).body.offers).toHaveLength(0);
    expect((await api().post(`${orgUrl(orgB)}/shift-offers/${offerId}/withdraw`).set('Cookie', ownerB.cookie)).status).toBe(404);
  });

  it('records acceptance as an assignment with history and fills a one-position shift', async () => {
    const res = await respond(offerId, 'accepted', pro1);
    expect(res.status).toBe(200);
    assignmentId = res.body.assignmentId;
    const detail = await api().get(`${base}/assignments/${assignmentId}`).set('Cookie', pro1.cookie);
    expect(detail.body.assignment.status).toBe('confirmed');
    expect(detail.body.history.map((h: any) => h.to_status)).toEqual(['confirmed']);
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM shifts WHERE id = $1', [shiftId]))[0]!.status).toBe('filled');
    expect((await respond(offerId, 'accepted', pro1)).status).toBe(409); // cannot answer twice
  });

  it('treats a confirmed assignment as a scheduling conflict for overlapping shifts', async () => {
    const res = await offer(app1, shift2Id);
    expect(res.status).toBe(409);
  });

  it('reopens the shift when the professional cancels, and requires a reason', async () => {
    expect((await api().post(`${base}/assignments/${assignmentId}/cancel`).set('Cookie', pro1.cookie).send({})).status).toBe(422);
    expect((await api().post(`${base}/assignments/${assignmentId}/cancel`).set('Cookie', pro2.cookie).send({ reason: 'Sick' })).status).toBe(404);
    const res = await api().post(`${base}/assignments/${assignmentId}/cancel`).set('Cookie', pro1.cookie).send({ reason: 'Family emergency' });
    expect(res.status).toBe(200);
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM shifts WHERE id = $1', [shiftId]))[0]!.status).toBe('open');
    expect((await asgStatus(assignmentId, 'cancelled_by_facility', 'Too late')).status).toBe(409); // already cancelled
    const detail = await api().get(`${orgUrl()}/assignments/${assignmentId}`).set('Cookie', recruiter.cookie);
    expect(detail.body.history.map((h: any) => h.to_status)).toEqual(['confirmed', 'cancelled_by_professional']);
  });

  it('lets the facility withdraw a pending offer and the professional decline one', async () => {
    const o = (await offer(app1, shiftId)).body.offer.id;
    expect((await api().post(`${orgUrl()}/shift-offers/${o}/withdraw`).set('Cookie', recruiter.cookie)).status).toBe(200);
    expect((await respond(o, 'accepted', pro1)).status).toBe(409);
    const o2 = (await offer(app1, shiftId)).body.offer.id;
    expect((await respond(o2, 'declined', pro1)).status).toBe(200);
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM shift_offers WHERE id = $1', [o2]))[0]!.status).toBe('declined');
  });

  it('expires offers lazily and refuses late answers', async () => {
    const o = (await offer(app1, shiftId)).body.offer.id;
    await ctx.db.query(`UPDATE shift_offers SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o]);
    expect((await respond(o, 'accepted', pro1)).status).toBe(409);
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM shift_offers WHERE id = $1', [o]))[0]!.status).toBe('expired');
  });

  it('only lets the facility record completion or no-show after the shift starts', async () => {
    const o = (await offer(app1, shiftId)).body.offer.id;
    const a = (await respond(o, 'accepted', pro1)).body.assignmentId as string;
    expect((await asgStatus(a, 'completed')).status).toBe(409);
    expect((await asgStatus(a, 'cancelled_by_facility')).status).toBe(422);
    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [shiftId]);
    expect((await asgStatus(a, 'completed', undefined, scheduler)).status).toBe(403);
    expect((await asgStatus(a, 'completed')).status).toBe(200);
    expect((await notifs(pro1)).some((n) => n.type === 'assignment.completed')).toBe(true);
  });
});
