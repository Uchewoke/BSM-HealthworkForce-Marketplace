import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let ownerA: S, recruiter: S, scheduler: S, ownerB: S, reviewer: S;
let agencyOwner: S, agencyRecruiter: S, agencyReader: S, agencyOwner2: S;
let pro1: S, pro2: S;
let orgA: string, orgB: string, agency: string, agency2: string, jobId: string, shiftId: string, rnId: string, icuId: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
const base = '/api/v1/professionals/me';
const orgUrl = (org = orgA) => `/api/v1/organizations/${org}`;
const ag = (org = agency) => `/api/v1/organizations/${org}/agency`;
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
const submit = (s: S, professionalId: string, body: object = {}, org = agency) =>
  api().post(`${ag(org)}/jobs/${jobId}/submissions`).set('Cookie', s.cookie).send({ professionalId, ...body });

beforeAll(async () => {
  ctx = await makeTestApp();
  ownerA = await ctx.userWithSession('owner.a@example.com');
  recruiter = await ctx.userWithSession('recruiter@example.com');
  scheduler = await ctx.userWithSession('scheduler@example.com');
  ownerB = await ctx.userWithSession('owner.b@example.com');
  agencyOwner = await ctx.userWithSession('agency.owner@example.com');
  agencyRecruiter = await ctx.userWithSession('agency.recruiter@example.com');
  agencyReader = await ctx.userWithSession('agency.reader@example.com');
  agencyOwner2 = await ctx.userWithSession('agency2.owner@example.com');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');

  orgA = (await api().post('/api/v1/organizations').set('Cookie', ownerA.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  agency = (await api().post('/api/v1/organizations').set('Cookie', agencyOwner.cookie).send({ name: 'Care Staffing Co', type: 'agency' })).body.organization.id;
  agency2 = (await api().post('/api/v1/organizations').set('Cookie', agencyOwner2.cookie).send({ name: 'Other Agency', type: 'agency' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'scheduler')`, [orgA, recruiter.id, scheduler.id]);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'agency_recruiter'), ($1,$3,'agency_read_only')`, [agency, agencyRecruiter.id, agencyReader.id]);

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

describe('staffing agencies', () => {
  let rosterId: string, pro2Roster: string, submissionId: string;

  it('creates agency organizations with an agency owner', async () => {
    const [o] = await ctx.db.query<{ type: string }>('SELECT type FROM organizations WHERE id = $1', [agency]);
    expect(o!.type).toBe('agency');
    const [m] = await ctx.db.query<{ role: string }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [agency, agencyOwner.id]);
    expect(m!.role).toBe('agency_owner');
  });

  it('keeps facility and agency capabilities apart', async () => {
    expect([403, 404]).toContain((await api().get(`${orgUrl(agency)}/jobs`).set('Cookie', agencyOwner.cookie)).status);
    expect((await api().post(`${orgUrl(agency)}/invitations`).set('Cookie', agencyOwner.cookie).send({ email: 'x@example.com', role: 'recruiter' })).status).toBe(403);
    expect((await api().get(`${ag(orgA)}/roster`).set('Cookie', ownerA.cookie)).status).toBe(403); // facility roles carry no agency permissions
  });

  it('invites a professional without revealing whether the address has an account', async () => {
    const known = await api().post(`${ag()}/roster/invitations`).set('Cookie', agencyRecruiter.cookie).send({ email: 'pro1@example.com' });
    const unknown = await api().post(`${ag()}/roster/invitations`).set('Cookie', agencyRecruiter.cookie).send({ email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect((await api().post(`${ag()}/roster/invitations`).set('Cookie', agencyReader.cookie).send({ email: 'pro1@example.com' })).status).toBe(403);
    await api().post(`${ag()}/roster/invitations`).set('Cookie', agencyRecruiter.cookie).send({ email: 'pro2@example.com' });
    const roster = await api().get(`${ag()}/roster`).set('Cookie', agencyReader.cookie);
    expect(roster.body.roster).toHaveLength(2);
    expect(roster.body.roster.every((r: any) => r.status === 'invited')).toBe(true);
    expect((await notifs(pro1)).some((n) => n.type === 'agency.roster_invited')).toBe(true);
  });

  it('only joins the roster when the professional accepts', async () => {
    rosterId = (await api().get(`${base}/agencies`).set('Cookie', pro1.cookie)).body.agencies[0].id;
    pro2Roster = (await api().get(`${base}/agencies`).set('Cookie', pro2.cookie)).body.agencies[0].id;
    expect((await submit(agencyRecruiter, await proId(pro1))).status).toBe(404); // invited is not consent
    expect((await api().post(`${base}/agencies/${rosterId}/respond`).set('Cookie', pro2.cookie).send({ response: 'accept' })).status).toBe(404);
    expect((await api().post(`${base}/agencies/${rosterId}/respond`).set('Cookie', pro1.cookie).send({ response: 'accept' })).status).toBe(200);
    expect((await api().post(`${base}/agencies/${pro2Roster}/respond`).set('Cookie', pro2.cookie).send({ response: 'accept' })).status).toBe(200);
  });

  it('shows agencies only the jobs a facility granted them', async () => {
    expect((await api().get(`${ag()}/jobs`).set('Cookie', agencyRecruiter.cookie)).body.jobs).toHaveLength(0);
    expect((await submit(agencyRecruiter, await proId(pro1))).status).toBe(404);

    expect((await api().post(`${orgUrl()}/jobs/${jobId}/agencies`).set('Cookie', scheduler.cookie).send({ agencyId: agency })).status).toBe(201); // jobs.manage
    expect((await api().post(`${orgUrl()}/jobs/${jobId}/agencies`).set('Cookie', ownerB.cookie).send({ agencyId: agency })).status).toBe(404);
    expect((await api().get(`${ag()}/jobs`).set('Cookie', agencyRecruiter.cookie)).body.jobs).toHaveLength(1);
    expect((await api().get(`${ag(agency2)}/jobs`).set('Cookie', agencyOwner2.cookie)).body.jobs).toHaveLength(0);
    const detail = await api().get(`${ag()}/jobs/${jobId}`).set('Cookie', agencyReader.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.shifts).toHaveLength(1);
    expect(detail.body.requirements.length).toBeGreaterThan(0);
    expect((await api().get(`${ag(agency2)}/jobs/${jobId}`).set('Cookie', agencyOwner2.cookie)).status).toBe(404); // not granted
    const members = (await api().get(`${ag()}/roster`).set('Cookie', agencyReader.cookie)).body.roster;
    expect(members.every((m: any) => m.status === 'active' && m.professional_id)).toBe(true);
    const found = await api().get(`${orgUrl()}/agencies?q=care`).set('Cookie', ownerA.cookie);
    expect(found.body.agencies).toEqual([{ id: agency, name: 'Care Staffing Co' }]);
  });

  it('submits a roster candidate as an application through the normal eligibility gate', async () => {
    const res = await submit(agencyRecruiter, await proId(pro1), { shiftIds: [shiftId] });
    expect(res.status).toBe(201);
    expect(res.body.eligibility.outcome).toBe('eligible');
    submissionId = res.body.submission.id;
    expect((await submit(agencyRecruiter, await proId(pro1))).status).toBe(409); // duplicate

    const detail = await api().get(`${orgUrl()}/applications/${submissionId}`).set('Cookie', recruiter.cookie);
    expect(detail.body.application.submitted_by_agency).toBe('Care Staffing Co');
    expect((await notifs(recruiter)).some((n) => n.title.startsWith('New agency submission'))).toBe(true);
    expect((await api().get(`${ag()}/submissions`).set('Cookie', agencyReader.cookie)).body.total).toBe(1);
    expect((await api().get(`${ag(agency2)}/submissions`).set('Cookie', agencyOwner2.cookie)).body.total).toBe(0);
  });

  it('refuses candidates who are off the roster, or whose permissions are insufficient', async () => {
    expect((await submit(agencyReader, await proId(pro2))).status).toBe(403);
    expect((await api().post(`${orgUrl()}/jobs/${jobId}/agencies`).set('Cookie', ownerA.cookie).send({ agencyId: agency2 })).status).toBe(201);
    expect((await submit(agencyOwner2, await proId(pro2), {}, agency2)).status).toBe(404); // not on agency2's roster
  });

  it('flows through offers to a placement the agency can see', async () => {
    const o = await api().post(`${orgUrl()}/applications/${submissionId}/shift-offers`).set('Cookie', recruiter.cookie).send({ shiftId });
    expect(o.status).toBe(201);
    expect((await api().post(`${base}/shift-offers/${o.body.offer.id}/respond`).set('Cookie', pro1.cookie).send({ response: 'accepted' })).status).toBe(200);
    const placements = await api().get(`${ag()}/placements`).set('Cookie', agencyReader.cookie);
    expect(placements.body.placements).toHaveLength(1);
    expect(placements.body.placements[0]).toMatchObject({ status: 'confirmed', hourly_rate_cents: 5500 });
    expect((await api().get(`${ag(agency2)}/placements`).set('Cookie', agencyOwner2.cookie)).body.placements).toHaveLength(0);
  });

  it('lets a professional leave, and a facility revoke access', async () => {
    expect((await api().delete(`${base}/agencies/${pro2Roster}`).set('Cookie', pro2.cookie)).status).toBe(204);
    expect((await api().delete(`${ag()}/roster/${rosterId}`).set('Cookie', agencyOwner.cookie)).status).toBe(204);
    expect((await submit(agencyRecruiter, await proId(pro1))).status).toBe(404);
    expect((await api().delete(`${orgUrl()}/jobs/${jobId}/agencies/${agency}`).set('Cookie', ownerA.cookie)).status).toBe(204);
    expect((await api().get(`${ag()}/jobs`).set('Cookie', agencyRecruiter.cookie)).body.jobs).toHaveLength(0);
  });

  it('puts agencies in the admin review queue, separate from facilities', async () => {
    await ctx.db.query(`UPDATE organizations SET status = 'submitted' WHERE id = $1`, [agency2]);
    const q = await api().get('/api/v1/admin/organizations?type=agency&status=submitted').set('Cookie', reviewer.cookie);
    expect(q.body.organizations.map((o: any) => o.id)).toEqual([agency2]);
    expect((await api().get('/api/v1/admin/organizations?status=submitted').set('Cookie', reviewer.cookie)).body.organizations).toHaveLength(0);
  });
});
