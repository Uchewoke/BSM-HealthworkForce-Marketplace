import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { runShiftRecovery } from '../src/modules/shift-recovery/service.js';
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

const url = (path: string, org = orgA) => `${orgUrl(org)}/shift-recovery${path}`;
const rec = (path: string, s: S = ownerA, org = orgA) => ({
  get: () => api().get(url(path, org)).set('Cookie', s.cookie),
  put: (b: object) => api().put(url(path, org)).set('Cookie', s.cookie).send(b),
  post: (b: object = {}) => api().post(url(path, org)).set('Cookie', s.cookie).send(b),
});
const SETTINGS = { enabled: true, maxOutreach: 5, offerHours: 12, escalateHours: 48, minLeadHours: 2, includeFloatPool: true };
/**
 * Shifts start at 14:00 UTC on the target day (8 hours long), so they never straddle midnight and the test does not depend on
 * the time of day it runs. A shift less than 3 hours away is a short 30-minute one starting from now instead.
 */
const newShift = async (o: { positions?: number; rate?: number | null; inHours?: number } = {}) => {
  const hours = o.inHours ?? 240;
  const near = hours < 3;
  const starts = near
    ? 'now() + make_interval(hours => $3::int)'
    : "((date_trunc('day', (now() AT TIME ZONE 'UTC') + make_interval(hours => $3::int)) + interval '14 hours') AT TIME ZONE 'UTC')";
  const [r] = await ctx.db.query<{ id: string }>(
    `INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions, hourly_rate_cents) VALUES ($1,$2, ${starts}, ${starts} + ${near ? "interval '30 minutes'" : "interval '8 hours'"}, $4, $5) RETURNING id`,
    [jobId, orgA, hours, o.positions ?? 1, o.rate === undefined ? 5500 : o.rate]);
  return r!.id;
};
/** A person applies to a job once; a later shift of the same job is added to that application. */
const applyTo = async (s: S, shift: string) => {
  const [existing] = await ctx.db.query<{ id: string }>('SELECT id FROM applications WHERE job_id = $1 AND professional_id = $2', [jobId, await proId(s)]);
  if (existing) {
    await ctx.db.query('INSERT INTO application_shifts (application_id, shift_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [existing.id, shift, orgA]);
    return existing.id;
  }
  const res = await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', s.cookie).send({ shiftIds: [shift] });
  expect(res.status).toBe(201);
  return res.body.application.id as string;
};
const manualOffer = async (app: string, shift: string, rate = 5500) => {
  const res = await api().post(`${orgUrl()}/applications/${app}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId: shift, hourlyRateCents: rate });
  expect(res.status).toBe(201);
  return res.body.offer.id as string;
};
const answer = (s: S, offer: string, response: 'accepted' | 'declined') => api().post(`${base}/shift-offers/${offer}/respond`).set('Cookie', s.cookie).send({ response });
const offersFor = (shift: string) => ctx.db.query<{ id: string; status: string; origin: string; professional_id: string; created_by: string; message: string | null; expires_at: Date }>(
  'SELECT id, status, origin, professional_id, created_by, message, expires_at FROM shift_offers WHERE shift_id = $1 ORDER BY created_at, id', [shift]);
const rowFor = async (shift: string) => (await ctx.db.query<{ status: string; started_by: string; escalated_at: Date | null; escalation: any }>('SELECT status, started_by, escalated_at, escalation FROM shift_recovery WHERE shift_id = $1', [shift]))[0];
const stop = (shift: string) => rec(`/shifts/${shift}/stop`, ownerA).post();
const escalationNotes = async (s: S) => (await notifs(s)).filter((n) => n.type === 'shift_recovery.escalated');

describe('unfilled shift recovery', () => {
  let pro3: S, pro4: S, p1: string, p2: string, p3: string, p4: string;
  let s1: string;

  beforeAll(async () => {
    await ctx.db.query(`UPDATE legal_signoffs SET signed_off = true, reference = 'test review', signed_off_at = now()`); // these features stay off until legal sign-off is recorded
    pro3 = await makePro('pro3@example.com', true);
    pro4 = await makePro('pro4@example.com', true);
    [p1, p2, p3, p4] = [await proId(pro1), await proId(pro2), await proId(pro3), await proId(pro4)];
  });

  it('is off by default, changeable only by owners and admins, and validated', async () => {
    const got = await rec('/settings', recruiter).get();
    expect(got.body.settings).toEqual({ enabled: false, maxOutreach: 5, offerHours: 12, escalateHours: 48, minLeadHours: 2, includeFloatPool: true });
    expect(got.body.approverActive).toBeNull();
    expect((await rec('/settings', recruiter).put(SETTINGS)).status).toBe(403); // org.update
    expect((await rec('/settings', scheduler).put(SETTINGS)).status).toBe(403);
    expect((await rec('/settings', ownerB).put(SETTINGS)).status).toBe(404); // not a member of orgA
    expect((await rec('/settings', ownerA).put({ ...SETTINGS, maxOutreach: 0 })).status).toBe(422);
    expect((await rec('/settings', ownerA).put({ ...SETTINGS, escalateHours: 1 })).status).toBe(422);
    expect((await rec('/settings', ownerA).put({ ...SETTINGS, offerHours: 100 })).status).toBe(422);
    expect((await rec('/shifts/' + (await newShift()) + '/start', recruiter).post()).status).toBe(409); // switch it on first
    expect((await rec('/run', recruiter).post()).status).toBe(409);
  });

  it('does nothing for an organization that has not switched it on', async () => {
    s1 = await newShift({ positions: 1 });
    const a1 = await applyTo(pro1, s1);
    const o1 = await manualOffer(a1, s1);
    expect((await answer(pro1, o1, 'declined')).status).toBe(200);
    await applyTo(pro3, s1);
    const sum = await runShiftRecovery(ctx.deps, { now: new Date() });
    expect(sum.organizations).toBe(0);
    expect(await rowFor(s1)).toBeUndefined();
    expect(await offersFor(s1)).toHaveLength(1);
  });

  it('records who approved it, and audits turning it on', async () => {
    expect((await rec('/settings', ownerA).put(SETTINGS)).status).toBe(200);
    const got = await rec('/settings', recruiter).get();
    expect(got.body).toMatchObject({ enabledBy: 'Test User', approverActive: true });
    const [a] = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'shift_recovery.enabled'`);
    expect(a).toBeDefined();
  });

  it('offers a declined shift to the next eligible applicant, never re-asking or skipping the rules', async () => {
    await applyTo(pro2, s1); // unverified credentials: pending, so never offered
    const sum = await runShiftRecovery(ctx.deps, { now: new Date() });
    expect(sum.offersSent).toBeGreaterThanOrEqual(1);
    const offers = await offersFor(s1);
    expect(offers).toHaveLength(2);
    const auto = offers.find((o) => o.origin === 'recovery')!;
    expect(auto).toMatchObject({ professional_id: p3, status: 'sent', created_by: ownerA.id });
    expect(auto.message).toMatch(/automatically/);
    expect(offers.find((o) => o.professional_id === p1)!.status).toBe('declined'); // the person who declined is not asked again
    expect(offers.some((o) => o.professional_id === p2)).toBe(false);
    expect((await notifs(pro3)).some((n) => n.type === 'shift_offer.sent')).toBe(true);
    const [log] = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'shift_recovery.outreach' AND target_id = $1`, [auto.id]);
    expect(log).toBeDefined();
    expect(await rowFor(s1)).toMatchObject({ status: 'active', started_by: 'auto', escalated_at: null }); // still has an offer waiting: not escalated yet
  });

  it('does not pile on more offers while one is still waiting', async () => {
    const before = (await offersFor(s1)).length;
    await runShiftRecovery(ctx.deps, { now: new Date() });
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect((await offersFor(s1)).length).toBe(before);
  });

  it('escalates once, with the shortage and next steps, when no one else can be asked', async () => {
    const auto = (await offersFor(s1)).find((o) => o.origin === 'recovery')!;
    expect((await answer(pro3, auto.id, 'declined')).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    const row = await rowFor(s1);
    expect(row!.escalated_at).not.toBeNull();
    expect(row!.escalation).toMatchObject({ openPositions: 1, positions: 1, liveOutreach: 0 });
    expect(row!.escalation.outreach.declined).toBe(2);
    expect(row!.escalation.candidates.pendingVerification).toBeGreaterThanOrEqual(1);
    expect(row!.escalation.reasons.join()).toMatch(/no one else eligible/);
    expect(row!.escalation.steps.join(' ')).toMatch(/credentials are verified/);
    const notes = await escalationNotes(recruiter);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/Shift still unfilled/);
    expect(notes[0].body).toMatch(/Next steps/);
    expect(await escalationNotes(scheduler)).toHaveLength(0); // scheduler cannot act on it
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect(await escalationNotes(recruiter)).toHaveLength(1); // not repeated
    const list = (await rec('', recruiter).get()).body.shifts.find((x: any) => x.shift_id === s1);
    expect(list).toMatchObject({ status: 'active', open_positions: 1, waiting: 0, automatic_outreach: 1 });
    expect(list.escalated_at).not.toBeNull();
    await stop(s1);
  });

  it('continues the outreach when an offer simply expires', async () => {
    const s2 = await newShift({ positions: 1 });
    const a1 = await applyTo(pro1, s2);
    await applyTo(pro3, s2);
    const manual = await manualOffer(a1, s2);
    const later = new Date(Date.now() + 49 * 3_600_000); // the 48-hour offer has now run out
    await runShiftRecovery(ctx.deps, { now: later });
    const offers = await offersFor(s2);
    expect(offers.find((o) => o.id === manual)!.status).toBe('expired');
    expect(offers.find((o) => o.origin === 'recovery')).toMatchObject({ professional_id: p3, status: 'sent' });
    await stop(s2);
  });

  it('reaches opted-in float pool members when applicants run out, only if allowed', async () => {
    const regionId = (await api().post('/api/v1/admin/exchange/regions').set('Cookie', platformAdmin.cookie).send({ name: 'Georgia', states: ['GA'] })).body.region.id as string;
    expect((await api().post(`${base}/float-pool/join`).set('Cookie', pro4.cookie).send({ regionId, accept: true })).status).toBe(201);
    expect((await api().post(`${orgUrl()}/exchange/participation`).set('Cookie', ownerA.cookie).send({ regionId, acceptTerms: true })).status).toBe(201);
    const s3 = await newShift({ positions: 1 });
    const a1 = await applyTo(pro1, s3);
    expect((await answer(pro1, await manualOffer(a1, s3), 'declined')).status).toBe(200);

    expect((await rec('/settings', ownerA).put({ ...SETTINGS, includeFloatPool: false })).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect(await ctx.db.query('SELECT 1 FROM float_requests WHERE shift_id = $1', [s3])).toHaveLength(0);
    expect((await rowFor(s3))!.escalated_at).not.toBeNull(); // nobody to ask, so it escalated
    expect((await rowFor(s3))!.escalation.steps.join(' ')).toMatch(/float pool outreach/);

    expect((await rec('/settings', ownerA).put(SETTINGS)).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    const [req] = await ctx.db.query<{ professional_id: string; origin: string; status: string; created_by: string }>('SELECT professional_id, origin, status, created_by FROM float_requests WHERE shift_id = $1', [s3]);
    expect(req).toMatchObject({ professional_id: p4, origin: 'recovery', status: 'pending', created_by: ownerA.id });
    const mine = await api().get(`${base}/float-pool/requests`).set('Cookie', pro4.cookie);
    expect(mine.body.requests.some((r: any) => r.status === 'pending')).toBe(true);
    // The person is still anonymous to the facility: nothing about them was exposed by the automatic request.
    expect((await ctx.db.query('SELECT 1 FROM applications WHERE professional_id = $1', [p4])).length).toBe(0);
    await stop(s3);
  });

  it('stops at the facility\'s limit and says so', async () => {
    expect((await rec('/settings', ownerA).put({ ...SETTINGS, maxOutreach: 1, includeFloatPool: false })).status).toBe(200);
    const s4 = await newShift({ positions: 2 });
    const a1 = await applyTo(pro1, s4);
    await applyTo(pro3, s4);
    const a4 = await applyTo(pro4, s4);
    expect((await answer(pro1, await manualOffer(a1, s4), 'declined')).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    const auto = (await offersFor(s4)).filter((o) => o.origin === 'recovery');
    expect(auto).toHaveLength(1); // two positions open, but the limit is one automatic offer
    expect((await answer(auto[0]!.professional_id === p3 ? pro3 : pro4, auto[0]!.id, 'declined')).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect((await offersFor(s4)).filter((o) => o.origin === 'recovery')).toHaveLength(1);
    expect((await rowFor(s4))!.escalation.reasons.join()).toMatch(/limit of 1/);
    expect((await rowFor(s4))!.escalation.steps.join(' ')).toMatch(/Raise the limit|limit/);
    void a4;
    await stop(s4);
    expect((await rec('/settings', ownerA).put(SETTINGS)).status).toBe(200);
  });

  it('will not send offers it cannot price, and tells the facility why', async () => {
    const s5 = await newShift({ positions: 1, rate: null });
    const a1 = await applyTo(pro1, s5);
    await applyTo(pro3, s5);
    expect((await answer(pro1, await manualOffer(a1, s5, 5500), 'declined')).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect((await offersFor(s5)).filter((o) => o.origin === 'recovery')).toHaveLength(0);
    const row = await rowFor(s5);
    expect(row!.escalation.reasons.join()).toMatch(/no hourly rate/);
    expect(row!.escalation.steps.join(' ')).toMatch(/Set an hourly rate/);
    await stop(s5);
  });

  it('does not start new automatic offers right before the shift, and escalates instead', async () => {
    const s6 = await newShift({ positions: 1, inHours: 1 });
    const a1 = await applyTo(pro1, s6);
    await applyTo(pro3, s6);
    expect((await answer(pro1, await manualOffer(a1, s6), 'declined')).status).toBe(200);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect((await offersFor(s6)).filter((o) => o.origin === 'recovery')).toHaveLength(0);
    expect((await rowFor(s6))!.escalation.reasons.join()).toMatch(/too close/);
    await stop(s6);
  });

  it('lets a facility start recovery by hand, escalates when time is short even with offers out, and can be stopped', async () => {
    const s7 = await newShift({ positions: 1, inHours: 30 });
    await applyTo(pro1, s7);
    await applyTo(pro3, s7);
    expect((await rec(`/shifts/${s7}/start`, scheduler).post()).status).toBe(403); // applications.manage
    expect((await rec(`/shifts/${s7}/start`, ownerB, orgB).post()).status).toBe(409); // orgB never switched recovery on, and could not reach orgA's shift anyway
    expect((await rec(`/shifts/${s7}/start`, recruiter).post()).status).toBe(202);
    await runShiftRecovery(ctx.deps, { now: new Date() });
    const offers = await offersFor(s7);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.origin).toBe('recovery');
    const row = await rowFor(s7);
    expect(row).toMatchObject({ started_by: 'manual' });
    expect(row!.escalation.reasons.join()).toMatch(/starts in \d+ hours/); // an offer is waiting, but the shift is close
    expect(row!.escalation.liveOutreach).toBe(1);
    expect((await rec(`/shifts/${s7}/stop`, scheduler).post()).status).toBe(403);
    expect((await stop(s7)).status).toBe(204);
    expect((await stop(s7)).status).toBe(404); // already stopped
    const after = (await offersFor(s7)).length;
    await answer(offers[0]!.professional_id === p1 ? pro1 : pro3, offers[0]!.id, 'declined');
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect((await offersFor(s7)).length).toBe(after); // stopped means stopped
  });

  it('marks a shift filled once it is, and offers nothing more', async () => {
    const s8 = await newShift({ positions: 1 });
    const a1 = await applyTo(pro1, s8);
    await applyTo(pro3, s8);
    expect((await rec(`/shifts/${s8}/start`, recruiter).post()).status).toBe(202);
    expect((await answer(pro1, await manualOffer(a1, s8), 'accepted')).status).toBe(200);
    const before = (await offersFor(s8)).length;
    await runShiftRecovery(ctx.deps, { now: new Date() });
    expect((await rowFor(s8))!.status).toBe('filled');
    expect((await offersFor(s8)).length).toBe(before);
  });

  it('pauses when the person who approved it is no longer an active member', async () => {
    const s9 = await newShift({ positions: 1, inHours: 300 }); // not overlapping the shift booked above
    const a1 = await applyTo(pro1, s9);
    await applyTo(pro3, s9);
    expect((await answer(pro1, await manualOffer(a1, s9), 'declined')).status).toBe(200);
    await ctx.db.query(`UPDATE shift_recovery_settings SET enabled_by = $1 WHERE organization_id = $2`, [pro1.id, orgA]); // someone who is not a member
    expect((await rec('/settings', recruiter).get()).body.approverActive).toBe(false);
    expect((await runShiftRecovery(ctx.deps, { now: new Date() })).organizations).toBe(0);
    expect((await offersFor(s9)).filter((o) => o.origin === 'recovery')).toHaveLength(0);
    await ctx.db.query(`UPDATE shift_recovery_settings SET enabled_by = $1 WHERE organization_id = $2`, [ownerA.id, orgA]);
    await stop(s9).catch(() => undefined);
  });

  it('can be run on demand, and keeps organizations apart', async () => {
    const run = await rec('/run', recruiter).post();
    expect(run.status).toBe(200);
    expect(run.body.summary).toMatchObject({ organizations: 1 });
    expect((await rec('/run', scheduler).post()).status).toBe(403);
    expect((await rec('/run', ownerB, orgB).post()).status).toBe(409); // orgB never switched it on
    expect((await rec('', ownerB, orgB).get()).body.shifts).toEqual([]);
    expect((await rec('', ownerB, orgA).get()).status).toBe(404);
    expect((await rec('/shifts/' + s1 + '/stop', ownerB, orgB).post()).status).toBe(404);
    expect((await api().get(url('')).send()).status).toBe(401);
  });

  it('turns off cleanly', async () => {
    expect((await rec('/settings', ownerA).put({ ...SETTINGS, enabled: false })).status).toBe(200);
    expect((await rec('/settings', ownerA).get()).body.settings.enabled).toBe(false);
    expect((await runShiftRecovery(ctx.deps, { now: new Date() })).organizations).toBe(0);
    const [d] = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'shift_recovery.disabled'`);
    expect(d).toBeDefined();
  });
});
