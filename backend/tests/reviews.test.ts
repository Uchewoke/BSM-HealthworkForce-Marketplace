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
const rateFacility = (s: S, id: string, body: object, org = orgA) => api().post(`${orgUrl(org)}/assignments/${id}/review`).set('Cookie', s.cookie).send(body);
const rateFromPro = (s: S, id: string, body: object) => api().post(`${base}/assignments/${id}/review`).set('Cookie', s.cookie).send(body);
const facilityReviews = (s: S = recruiter, org = orgA) => api().get(`${orgUrl(org)}/ratings`).set('Cookie', s.cookie);
const proReviews = (s: S = pro1) => api().get(`${base}/reviews`).set('Cookie', s.cookie);
const setReviewedAt = (sql: string, id: string) => ctx.db.query(`UPDATE timesheets SET reviewed_at = ${sql} WHERE assignment_id = $1`, [id]);

describe('reviews, reliability and disputes', () => {
  let assignmentId: string, applicationId: string, f2pId: string, p2fId: string;

  beforeAll(async () => {
    applicationId = (await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pro1.cookie).send({ shiftIds: [shiftId] })).body.application.id as string;
    const o = await api().post(`${orgUrl()}/applications/${applicationId}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId });
    assignmentId = (await api().post(`${base}/shift-offers/${o.body.offer.id}/respond`).set('Cookie', pro1.cookie).send({ response: 'accepted' })).body.assignmentId as string;
    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [shiftId]);
    // Keep the job listable: it needs a future open shift.
    await ctx.db.query(`INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions) SELECT job_id, organization_id, now() + interval '3 days', now() + interval '3 days 8 hours', 1 FROM shifts WHERE id = $1`, [shiftId]);
  });

  it('only allows reviews once the hours are approved', async () => {
    expect((await rateFacility(recruiter, assignmentId, { rating: 4 })).status).toBe(409);
    expect((await rateFromPro(pro1, assignmentId, { rating: 5 })).status).toBe(409);
    expect((await api().put(`${base}/assignments/${assignmentId}/timesheet`).set('Cookie', pro1.cookie).send({ workedStart: hoursAgo(10), workedEnd: hoursAgo(2), breakMinutes: 0 })).status).toBe(200);
    const tsId = (await api().get(`${orgUrl()}/timesheets`).set('Cookie', recruiter.cookie)).body.timesheets[0].id;
    expect((await api().post(`${orgUrl()}/timesheets/${tsId}/review`).set('Cookie', recruiter.cookie).send({ decision: 'approve' })).status).toBe(200);
    expect((await proReviews()).body.toReview).toHaveLength(1);
    expect((await facilityReviews()).body.toReview).toHaveLength(1);
  });

  it('closes the review window after 14 days', async () => {
    await setReviewedAt("now() - interval '20 days'", assignmentId);
    expect((await rateFacility(recruiter, assignmentId, { rating: 4 })).status).toBe(409);
    expect((await facilityReviews()).body.toReview).toHaveLength(0);
    await setReviewedAt('now()', assignmentId);
  });

  it('keeps each side to its own assignment and validates the review', async () => {
    expect((await rateFacility(recruiter, assignmentId, { rating: 6 })).status).toBe(422);
    expect((await rateFacility(recruiter, assignmentId, { rating: 0 })).status).toBe(422);
    expect((await rateFacility(scheduler, assignmentId, { rating: 4 })).status).toBe(403); // needs applications.manage
    expect((await rateFacility(ownerB, assignmentId, { rating: 4 }, orgB)).status).toBe(404);
    expect((await rateFromPro(pro2, assignmentId, { rating: 5 })).status).toBe(404);
  });

  it('hides each review from the other side until both exist (double-blind)', async () => {
    const r = await rateFacility(recruiter, assignmentId, { rating: 4, comment: 'Reliable and prepared.' });
    expect(r.status).toBe(201);
    f2pId = r.body.review.id;
    expect((await rateFacility(recruiter, assignmentId, { rating: 5 })).status).toBe(409); // once only
    expect((await proReviews()).body.received).toHaveLength(0); // the professional cannot see it yet
    expect((await proReviews()).body.rating.count).toBe(0);
    const p = await rateFromPro(pro1, assignmentId, { rating: 5, comment: 'Well organised unit.' });
    expect(p.status).toBe(201);
    p2fId = p.body.review.id;
    expect((await proReviews()).body.received).toHaveLength(1);
    expect((await proReviews()).body.received[0]).toMatchObject({ rating: 4, comment: 'Reliable and prepared.', organization_name: 'Alpha Health' });
  });

  it('shows facilities professional feedback anonymously, and averages only once there are enough ratings', async () => {
    const fr = await facilityReviews();
    expect(fr.body.received).toHaveLength(1);
    expect(Object.keys(fr.body.received[0])).not.toEqual(expect.arrayContaining(['professional_id', 'professional_name', 'reviewer_user_id']));
    expect(fr.body.rating).toMatchObject({ count: 1, average: 5, shown: true }); // the facility sees its own
    const detail = await api().get(`${orgUrl()}/applications/${applicationId}`).set('Cookie', recruiter.cookie);
    expect(detail.body.track.rating).toEqual({ count: 1, average: null, shown: false }); // one review is not a public score
    expect(detail.body.track.reliability).toMatchObject({ completedShifts: 1, noShows: 0, cancellations: 0, completionRate: 100, sampleSize: 1 });
    const job = await api().get(`/api/v1/jobs/${jobId}`).set('Cookie', pro2.cookie);
    expect(job.body.organizationRating).toEqual({ count: 1, average: null, shown: false });
    expect((await proReviews()).body.reliability.completionRate).toBe(100);
  });

  it('does not let ratings change eligibility', async () => {
    await ctx.db.query('UPDATE reviews SET rating = 1');
    const detail = await api().get(`${orgUrl()}/applications/${applicationId}`).set('Cookie', recruiter.cookie);
    expect(detail.body.eligibility.outcome).not.toBe('ineligible');
    await ctx.db.query('UPDATE reviews SET rating = 4 WHERE id = $1', [f2pId]);
    await ctx.db.query('UPDATE reviews SET rating = 5 WHERE id = $1', [p2fId]);
  });

  it('lets only the reviewed party dispute a visible review, once', async () => {
    const dispute = (s: S, id: string, reason = 'This does not reflect what happened on that shift.') => api().post(`${base}/reviews/${id}/dispute`).set('Cookie', s.cookie).send({ reason });
    expect((await dispute(pro1, f2pId, 'too short')).status).toBe(422);
    expect((await dispute(pro2, f2pId)).status).toBe(404);
    expect((await dispute(pro1, p2fId)).status).toBe(404); // not about them
    expect((await dispute(pro1, f2pId)).status).toBe(201);
    expect((await dispute(pro1, f2pId)).status).toBe(409);
    const fac = (s: S, id: string, org = orgA) => api().post(`${orgUrl(org)}/reviews/${id}/dispute`).set('Cookie', s.cookie).send({ reason: 'The comment is inaccurate about our staffing levels.' });
    expect((await fac(scheduler, p2fId)).status).toBe(403);
    expect((await fac(ownerB, p2fId, orgB)).status).toBe(404);
    expect((await fac(recruiter, f2pId)).status).toBe(404); // its own review
    expect((await fac(recruiter, p2fId)).status).toBe(201);
    expect((await proReviews()).body.received[0].dispute_status).toBe('open'); // still shown while under review
  });

  it('lets support staff resolve disputes: remove a review or let it stand', async () => {
    const support = await ctx.adminSession('support@bsm.example', 'support_agent');
    expect((await api().get('/api/v1/admin/reviews/disputes').set('Cookie', finance.cookie)).status).toBe(403);
    expect((await api().get('/api/v1/admin/reviews/disputes').set('Cookie', ownerA.cookie)).status).toBe(403);
    const queue = await api().get('/api/v1/admin/reviews/disputes').set('Cookie', support.cookie);
    expect(queue.body.total).toBe(2);
    const forF2p = queue.body.disputes.find((d: any) => d.direction === 'facility_to_professional');
    const forP2f = queue.body.disputes.find((d: any) => d.direction === 'professional_to_facility');
    const resolve = (id: string, body: object) => api().post(`/api/v1/admin/reviews/disputes/${id}/resolve`).set('Cookie', support.cookie).send(body);
    expect((await resolve(forF2p.id, { outcome: 'remove' })).status).toBe(422); // a note is required
    expect((await resolve(forF2p.id, { outcome: 'remove', note: 'Comment contained an unverifiable claim.' })).status).toBe(200);
    expect((await resolve(forF2p.id, { outcome: 'uphold', note: 'Changed my mind' })).status).toBe(409);
    expect((await resolve(forP2f.id, { outcome: 'uphold', note: 'Feedback is within guidelines.' })).status).toBe(200);
    expect((await proReviews()).body.received).toHaveLength(0); // removed
    expect((await proReviews()).body.rating.count).toBe(0);
    expect((await facilityReviews()).body.received).toHaveLength(1); // upheld, still counted
    expect((await notifs(pro1)).some((n) => n.type === 'review.dispute_removed')).toBe(true);
    expect((await notifs(recruiter)).some((n) => n.type === 'review.dispute_upheld')).toBe(true);
    const actions = (await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'review.%'`)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['review.created', 'review.disputed', 'review.dispute_removed', 'review.dispute_upheld']));
  });

  it('counts no-shows and late cancellations from real assignment history', async () => {
    const rel = async () => (await proReviews()).body.reliability;
    await ctx.db.query(`UPDATE assignments SET status = 'no_show' WHERE id = $1`, [assignmentId]);
    expect(await rel()).toMatchObject({ completedShifts: 0, noShows: 1, completionRate: 0, sampleSize: 1 });
    await ctx.db.query(`UPDATE assignments SET status = 'cancelled_by_professional' WHERE id = $1`, [assignmentId]);
    await ctx.db.query(`INSERT INTO assignment_status_history (assignment_id, actor_kind, from_status, to_status, reason, created_at) SELECT a.id, 'professional', 'confirmed', 'cancelled_by_professional', 'Unwell', s.starts_at - interval '3 hours' FROM assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.id = $1`, [assignmentId]);
    expect(await rel()).toMatchObject({ cancellations: 1, lateCancellations: 1 });
    await ctx.db.query(`UPDATE assignment_status_history SET created_at = created_at - interval '5 days' WHERE assignment_id = $1 AND to_status = 'cancelled_by_professional'`, [assignmentId]);
    expect(await rel()).toMatchObject({ cancellations: 1, lateCancellations: 0 });
  });
});
