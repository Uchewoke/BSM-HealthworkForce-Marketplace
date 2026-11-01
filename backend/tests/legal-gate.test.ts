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

const legal = (s: S) => ({
  get: () => api().get('/api/v1/admin/legal-signoffs').set('Cookie', s.cookie),
  put: (feature: string, b: object) => api().put(`/api/v1/admin/legal-signoffs/${feature}`).set('Cookie', s.cookie).send(b),
});
const SET = { enabled: true, maxOutreach: 5, offerHours: 12, escalateHours: 48, minLeadHours: 2, includeFloatPool: true };

describe('legal sign-off gate for the float pool and automatic outreach', () => {
  let superAdmin: S, regionId: string;

  beforeAll(async () => {
    superAdmin = await ctx.adminSession('super@bsm.example', 'platform_super_admin');
    regionId = (await api().post('/api/v1/admin/exchange/regions').set('Cookie', platformAdmin.cookie).send({ name: 'Georgia', states: ['GA'] })).body.region.id;
  });

  it('starts switched off, and only a super admin can see or change it', async () => {
    const list = await legal(superAdmin).get();
    expect(list.body.signoffs.map((x: any) => [x.feature, x.signedOff])).toEqual([['float_pool', false], ['shift_recovery', false]]);
    expect(list.body.signoffs[0].label).toMatch(/float pool/i);
    expect((await legal(platformAdmin).get()).status).toBe(403); // platform_admin lacks settings_manage
    expect((await legal(finance).get()).status).toBe(403);
    expect((await api().get('/api/v1/admin/legal-signoffs').set('Cookie', ownerA.cookie)).status).toBe(403);
    expect((await api().get('/api/v1/admin/legal-signoffs')).status).toBe(401);
    expect((await legal(platformAdmin).put('float_pool', { signedOff: true, reference: 'memo' })).status).toBe(403);
  });

  it('keeps the shared pool closed to everyone, and says why', async () => {
    const closed = (res: { status: number; body: any }) => { expect(res.status).toBe(403); expect(res.body.error.details).toMatchObject({ code: 'legal_signoff_required', feature: 'float_pool' }); expect(res.body.error.message).toMatch(/not available yet/); };
    expect((await api().get(`${base}/float-pool`).set('Cookie', pro1.cookie)).body.available).toBe(false);
    closed(await api().post(`${base}/float-pool/join`).set('Cookie', pro1.cookie).send({ regionId, accept: true }));
    expect((await api().get(`${orgUrl()}/exchange/regions`).set('Cookie', ownerA.cookie)).body.available).toBe(false);
    closed(await api().post(`${orgUrl()}/exchange/participation`).set('Cookie', ownerA.cookie).send({ regionId, acceptTerms: true }));
    closed(await api().get(`${orgUrl()}/exchange/pool?regionId=${regionId}`).set('Cookie', recruiter.cookie));
    closed(await api().get(`${orgUrl()}/exchange/shifts?regionId=${regionId}`).set('Cookie', recruiter.cookie));
    closed(await api().get(`${orgUrl()}/exchange/pool/summary?regionId=${regionId}`).set('Cookie', recruiter.cookie));
    expect((await ctx.db.query('SELECT 1 FROM float_pool_members')).length).toBe(0);
  });

  it('keeps automatic outreach off, while still letting an organization switch it off', async () => {
    const settings = await api().get(`${orgUrl()}/shift-recovery/settings`).set('Cookie', recruiter.cookie);
    expect(settings.body.available).toBe(false);
    const enable = await api().put(`${orgUrl()}/shift-recovery/settings`).set('Cookie', ownerA.cookie).send(SET);
    expect(enable.status).toBe(403);
    expect(enable.body.error.details).toMatchObject({ feature: 'shift_recovery' });
    expect((await api().put(`${orgUrl()}/shift-recovery/settings`).set('Cookie', ownerA.cookie).send({ ...SET, enabled: false })).status).toBe(200); // turning it off is always allowed
    expect((await api().post(`${orgUrl()}/shift-recovery/shifts/${shiftId}/start`).set('Cookie', recruiter.cookie)).status).toBe(403);
    expect((await api().post(`${orgUrl()}/shift-recovery/run`).set('Cookie', recruiter.cookie)).status).toBe(403);
  });

  it('needs a reference to the legal review, records who signed off and when, and is audited', async () => {
    expect((await legal(superAdmin).put('float_pool', { signedOff: true })).status).toBe(422);
    expect((await legal(superAdmin).put('float_pool', { signedOff: true, reference: 'x' })).status).toBe(422);
    expect((await legal(superAdmin).put('not_a_feature', { signedOff: true, reference: 'memo 1' })).status).toBe(422);
    expect((await legal(superAdmin).put('float_pool', { signedOff: true, reference: 'Counsel memo 2026-11-04, ticket LEG-12', note: 'Approved for the Georgia pilot' })).status).toBe(200);
    const list = (await legal(superAdmin).get()).body.signoffs.find((x: any) => x.feature === 'float_pool');
    expect(list).toMatchObject({ signedOff: true, reference: 'Counsel memo 2026-11-04, ticket LEG-12', note: 'Approved for the Georgia pilot', signedOffBy: 'Test User' });
    expect(list.signedOffAt).not.toBeNull();
    const [a] = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action = 'legal.signoff_recorded'`);
    expect(a).toBeDefined();
    // the other feature is untouched
    expect((await legal(superAdmin).get()).body.signoffs.find((x: any) => x.feature === 'shift_recovery').signedOff).toBe(false);
  });

  it('opens the pool once signed off', async () => {
    expect((await api().get(`${base}/float-pool`).set('Cookie', pro1.cookie)).body.available).toBe(true);
    expect((await api().post(`${base}/float-pool/join`).set('Cookie', pro1.cookie).send({ regionId, accept: true })).status).toBe(201);
    expect((await api().post(`${orgUrl()}/exchange/participation`).set('Cookie', ownerA.cookie).send({ regionId, acceptTerms: true })).status).toBe(201);
    expect((await api().get(`${orgUrl()}/exchange/pool?regionId=${regionId}`).set('Cookie', recruiter.cookie)).status).toBe(200);
    // automatic outreach is still gated by its own sign-off
    expect((await api().put(`${orgUrl()}/shift-recovery/settings`).set('Cookie', ownerA.cookie).send(SET)).status).toBe(403);
  });

  it('revoking stops the pool at once and withdraws what is waiting', async () => {
    const ref = (await api().get(`${orgUrl()}/exchange/pool?regionId=${regionId}&shiftId=${shiftId}`).set('Cookie', recruiter.cookie)).body.pool[0].talentRef;
    const sent = await api().post(`${orgUrl()}/exchange/requests`).set('Cookie', recruiter.cookie).send({ talentRef: ref, shiftId });
    expect(sent.status).toBe(201);
    expect((await legal(superAdmin).put('float_pool', { signedOff: false, note: 'Counsel asked us to pause' })).status).toBe(200);
    const [row] = await ctx.db.query<{ status: string; failure_reason: string }>('SELECT status, failure_reason FROM float_requests WHERE id = $1', [sent.body.request.id]);
    expect(row).toMatchObject({ status: 'withdrawn' });
    expect(row!.failure_reason).toMatch(/switched off/);
    const accept = await api().post(`${base}/float-pool/requests/${sent.body.request.id}/respond`).set('Cookie', pro1.cookie).send({ response: 'accepted' });
    expect(accept.status).toBe(403);
    expect((await api().get(`${orgUrl()}/exchange/pool?regionId=${regionId}`).set('Cookie', recruiter.cookie)).status).toBe(403);
    expect((await api().post(`${base}/float-pool/leave`).set('Cookie', pro1.cookie).send({ regionId })).status).toBe(204); // people can always leave
    expect((await ctx.db.query(`SELECT action FROM audit_logs WHERE action = 'legal.signoff_revoked'`)).length).toBe(1);
  });

  it('runs automatic outreach only while signed off, whatever an organization switched on', async () => {
    expect((await legal(superAdmin).put('shift_recovery', { signedOff: true, reference: 'Counsel memo 2026-11-04, ticket LEG-13' })).status).toBe(200);
    expect((await api().put(`${orgUrl()}/shift-recovery/settings`).set('Cookie', ownerA.cookie).send({ ...SET, includeFloatPool: false })).status).toBe(200);
    expect((await runShiftRecovery(ctx.deps, { now: new Date() })).organizations).toBe(1);
    expect((await legal(superAdmin).put('shift_recovery', { signedOff: false })).status).toBe(200);
    const stopped = await runShiftRecovery(ctx.deps, { now: new Date() });
    expect(stopped).toEqual({ organizations: 0, shiftsChecked: 0, offersSent: 0, requestsSent: 0, escalated: 0 });
    expect((await api().post(`${orgUrl()}/shift-recovery/run`).set('Cookie', recruiter.cookie)).status).toBe(403);
  });
});
