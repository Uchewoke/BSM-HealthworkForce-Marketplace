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
const myInvoices = (s: S, org = orgA) => api().get(`${orgUrl(org)}/billing/invoices`).set('Cookie', s.cookie);

describe('manual invoicing', () => {
  let invoiceId: string, assignmentId: string;

  beforeAll(async () => {
    // One completed 8-hour assignment at $55/h, created through the real offer flow.
    const app1 = (await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pro1.cookie).send({ shiftIds: [shiftId] })).body.application.id as string;
    const o = await api().post(`${orgUrl()}/applications/${app1}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId });
    const acc = await api().post(`${base}/shift-offers/${o.body.offer.id}/respond`).set('Cookie', pro1.cookie).send({ response: 'accepted' });
    expect(acc.status).toBe(200);
    await ctx.db.query(`UPDATE shifts SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [shiftId]);
    assignmentId = acc.body.assignmentId as string;
  });

  it('is limited to finance staff with MFA', async () => {
    expect((await api().get('/api/v1/admin/billing/fee')).status).toBe(401);
    expect((await admin(platformAdmin).get('/fee')).status).toBe(403);
    expect((await api().get('/api/v1/admin/billing/fee').set('Cookie', ownerA.cookie)).status).toBe(403);
    expect((await admin().get('/fee')).body).toEqual({ bps: null, configured: false });
  });

  it('lets finance staff find organizations by name', async () => {
    expect((await admin().get('/organizations?q=alp')).body.organizations).toEqual([{ id: orgA, name: 'Alpha Health', type: 'facility' }]);
    expect((await admin(platformAdmin).get('/organizations?q=alp')).status).toBe(403);
  });

  it('refuses to invoice until a fee is configured, and validates the fee', async () => {
    expect((await admin().post('/invoices', { organizationId: orgA, ...period() })).status).toBe(409);
    expect((await admin().put('/fee', { bps: 20_000 })).status).toBe(422);
    expect((await admin().put('/fee', { bps: 1000 })).body).toEqual({ bps: 1000, configured: true });
    expect((await admin().post('/invoices', { organizationId: orgA, periodStart: '2026-02-01', periodEnd: '2026-01-01' })).status).toBe(422);
  });

  it('only bills hours from an approved timesheet', async () => {
    const p = period();
    const preview = () => admin().get(`/unbilled?organizationId=${orgA}&periodStart=${p.periodStart}&periodEnd=${p.periodEnd}`);
    const first = await preview();
    expect(first.body.items).toHaveLength(0);
    expect(first.body.awaitingTimesheet).toHaveLength(1);
    expect((await admin().post('/invoices', { organizationId: orgA, ...p })).status).toBe(409); // nothing billable yet
    const hours = { workedStart: new Date(Date.now() - 10 * 3_600_000).toISOString(), workedEnd: new Date(Date.now() - 2 * 3_600_000).toISOString(), breakMinutes: 30 };
    expect((await api().put(`${base}/assignments/${assignmentId}/timesheet`).set('Cookie', pro1.cookie).send(hours)).status).toBe(200);
    expect((await preview()).body.items).toHaveLength(0); // submitted is not approved
    const tsId = (await api().get(`${orgUrl()}/timesheets?status=submitted`).set('Cookie', recruiter.cookie)).body.timesheets[0].id;
    expect((await api().post(`${orgUrl()}/timesheets/${tsId}/review`).set('Cookie', recruiter.cookie).send({ decision: 'approve' })).status).toBe(200);
    expect((await preview()).body.awaitingTimesheet).toHaveLength(0);
  });

  it('previews and creates a draft with the fee computed per line, hidden from the organization', async () => {
    const p = period();
    const pre = await admin().get(`/unbilled?organizationId=${orgA}&periodStart=${p.periodStart}&periodEnd=${p.periodEnd}`);
    expect(pre.body.items).toHaveLength(1);
    expect(pre.body.items[0]).toMatchObject({ minutes: 450, rate_cents: 5500, gross: 41_250, amount: 4_125 });
    const res = await admin().post('/invoices', { organizationId: orgA, ...p });
    expect(res.status).toBe(201);
    invoiceId = res.body.invoice.id;
    expect(res.body.invoice).toMatchObject({ status: 'draft', number: null, fee_bps: 1000 });
    expect(Number(res.body.invoice.total_cents)).toBe(4125);
    expect(res.body.lines).toHaveLength(1);
    expect((await admin().post('/invoices', { organizationId: orgA, ...p })).status).toBe(409); // already on a live invoice
    expect((await myInvoices(finMember)).body.invoices).toHaveLength(0);
    expect((await api().get(`${orgUrl()}/billing/invoices/${invoiceId}`).set('Cookie', finMember.cookie)).status).toBe(404);
  });

  it('frees the assignment when a draft is voided, so it can be billed again', async () => {
    expect((await admin().post(`/invoices/${invoiceId}/void`, {})).status).toBe(422); // reason required
    const v = await admin().post(`/invoices/${invoiceId}/void`, { reason: 'Wrong period' });
    expect(v.body.invoice.status).toBe('void');
    expect((await admin().post(`/invoices/${invoiceId}/issue`, {})).status).toBe(409);
    const again = await admin().post('/invoices', { organizationId: orgA, ...period() });
    expect(again.status).toBe(201);
    invoiceId = again.body.invoice.id;
  });

  it('numbers an invoice only when issued and shows it to billing contacts of that organization only', async () => {
    const issued = await admin().post(`/invoices/${invoiceId}/issue`, { dueInDays: 14 });
    expect(issued.status).toBe(200);
    expect(issued.body.invoice).toMatchObject({ status: 'issued', number: 'INV-000001' });
    expect((await admin().post(`/invoices/${invoiceId}/issue`, {})).status).toBe(409);
    const mine = await myInvoices(finMember);
    expect(mine.body.invoices.map((i: any) => i.id)).toEqual([invoiceId]);
    expect((await api().get(`${orgUrl()}/billing/invoices/${invoiceId}`).set('Cookie', finMember.cookie)).body.lines).toHaveLength(1);
    expect((await myInvoices(recruiter)).status).toBe(403); // no billing.read
    expect((await myInvoices(ownerB, orgB)).body.invoices).toHaveLength(0);
    expect((await api().get(`${orgUrl(orgB)}/billing/invoices/${invoiceId}`).set('Cookie', ownerB.cookie)).status).not.toBe(200);
    expect((await notifs(finMember)).some((n) => n.type === 'invoice.issued')).toBe(true);
  });

  it('records a manual payment once and keeps paid invoices final', async () => {
    expect((await admin().post(`/invoices/${invoiceId}/payment`, { method: 'bank_transfer' })).status).toBe(422);
    const paid = await admin().post(`/invoices/${invoiceId}/payment`, { method: 'bank_transfer', reference: 'ACH 2026-11-03' });
    expect(paid.body.invoice).toMatchObject({ status: 'paid', payment_method: 'bank_transfer', payment_reference: 'ACH 2026-11-03' });
    expect((await admin().post(`/invoices/${invoiceId}/payment`, { method: 'check', reference: 'again' })).status).toBe(409);
    expect((await admin().post(`/invoices/${invoiceId}/void`, { reason: 'Too late' })).status).toBe(409);
    expect((await notifs(finMember)).some((n) => n.type === 'invoice.paid')).toBe(true);
    const actions = (await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY created_at, id`, [invoiceId])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['invoice.created', 'invoice.issued', 'invoice.paid']));
  });
});
