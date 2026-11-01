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

const forecast = (s: S, query = '', org = orgA) => api().get(`${orgUrl(org)}/forecast${query}`).set('Cookie', s.cookie);
const SEED = (jobId: string, orgId: string, weeksBack: number, extra = '0') => ctx.db.query(
  `INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions)
   SELECT $1, $2, ((date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g) + interval '1 day 10 hours') AT TIME ZONE 'UTC'),
          ((date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g) + interval '1 day 18 hours') AT TIME ZONE 'UTC'), 2 + (g % 3) + ${extra}
     FROM generate_series(1, $3::int) g`, [jobId, orgId, weeksBack]);

describe('demand forecast', () => {
  it('says it cannot forecast when there is no history, rather than inventing one', async () => {
    const res = await forecast(ownerB, '', orgB);
    expect(res.status).toBe(200);
    expect(res.body.overall).toMatchObject({ status: 'insufficient_history' });
    expect(res.body.overall.reason).toMatch(/weeks/);
    expect(res.body.overall.forecast).toBeUndefined();
    expect(res.body.byProfession).toEqual([]);
  });

  it('forecasts from the organization\'s own weekly shift history', async () => {
    await SEED(jobId, orgA, 12); // 12 complete weeks of 2 + (g % 3) positions
    const res = await forecast(ownerA);
    expect(res.status).toBe(200);
    const o = res.body.overall;
    expect(o.status).toBe('ok');
    expect(o.history).toHaveLength(12);
    expect(o.history.reduce((s: number, h: any) => s + h.positions, 0)).toBe(Array.from({ length: 12 }, (_, i) => 2 + ((i + 1) % 3)).reduce((a, b) => a + b, 0));
    expect(o.forecast).toHaveLength(8);
    expect(o.forecast[0].week).toBe(res.body.currentWeek);
    for (const p of o.forecast) { expect(p.low).toBeLessThanOrEqual(p.expected); expect(p.expected).toBeLessThanOrEqual(p.high); expect(p.low).toBeGreaterThanOrEqual(0); }
    expect(o.method).toMatch(/Seasonality is not modelled/);
    expect(['low', 'medium', 'high']).toContain(o.confidence);
    expect(o.backtest.weeks).toBeGreaterThan(0);
    expect(res.body.byProfession[0]).toMatchObject({ status: 'ok' });
    expect(res.body.byProfession.length).toBeLessThanOrEqual(5);
  });

  it('treats positions already posted as a floor and estimates what may go unfilled', async () => {
    const res = await forecast(ownerA);
    const posted = res.body.overall.forecast.filter((f: any) => f.alreadyPosted > 0);
    expect(posted.length).toBeGreaterThan(0); // the setup shift ten days out
    for (const f of posted) expect(f.expected).toBeGreaterThanOrEqual(f.alreadyPosted);
    // Nothing was ever filled in this history, so everything expected is expected to go unfilled.
    expect(res.body.recentFillRate).toBe(0);
    for (const f of res.body.overall.forecast) expect(f.expectedUnfilled).toBe(f.expected);

    await ctx.db.query(`INSERT INTO shifts (job_id, organization_id, starts_at, ends_at, positions) SELECT job_id, organization_id, now() + interval '3 days', now() + interval '3 days 8 hours', 40 FROM shifts WHERE id = $1`, [shiftId]);
    const big = (await forecast(ownerA)).body.overall.forecast;
    expect(Math.max(...big.map((f: any) => f.expected))).toBeGreaterThanOrEqual(40);
    expect(big.every((f: any) => f.low <= f.high)).toBe(true);
  });

  it('respects the requested horizon and rejects silly ones', async () => {
    expect((await forecast(ownerA, '?horizon=4')).body.overall.forecast).toHaveLength(4);
    expect((await forecast(ownerA, '?horizon=12')).body.overall.forecast).toHaveLength(12);
    expect((await forecast(ownerA, '?horizon=3')).status).toBe(422);
    expect((await forecast(ownerA, '?horizon=13')).status).toBe(422);
    expect((await forecast(ownerA, '?horizon=abc')).status).toBe(422);
  });

  it('stays inside the organization', async () => {
    expect((await forecast(ownerB, '', orgA)).status).toBe(404);
    expect((await api().get(`${orgUrl()}/forecast`)).status).toBe(401);
    expect((await forecast(scheduler)).status).toBe(200); // jobs.read
    const other = (await forecast(ownerB, '', orgB)).body.overall;
    expect(other.status).toBe('insufficient_history'); // orgA's history never leaks into orgB
  });
});
