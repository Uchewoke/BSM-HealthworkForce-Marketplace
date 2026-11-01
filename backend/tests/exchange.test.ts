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

const adminX = (path: string, s: S = platformAdmin) => ({
  get: () => api().get(`/api/v1/admin/exchange${path}`).set('Cookie', s.cookie),
  post: (b: object) => api().post(`/api/v1/admin/exchange${path}`).set('Cookie', s.cookie).send(b),
  patch: (b: object) => api().patch(`/api/v1/admin/exchange${path}`).set('Cookie', s.cookie).send(b),
});
const poolBase = `${base}/float-pool`;
const ex = (path: string, s: S, org = orgA) => ({
  get: () => api().get(`${orgUrl(org)}/exchange${path}`).set('Cookie', s.cookie),
  post: (b: object) => api().post(`${orgUrl(org)}/exchange${path}`).set('Cookie', s.cookie).send(b),
  del: () => api().delete(`${orgUrl(org)}/exchange${path}`).set('Cookie', s.cookie),
});
/** The anonymous reference this organization was given for a person (created when they appear in a search). */
const refOf = async (s: S) => (await ctx.db.query<{ ref: string }>('SELECT ref FROM talent_refs WHERE organization_id = $1 AND professional_id = $2', [orgA, await proId(s)]))[0]!.ref;
const respond = (s: S, id: string, response: string) => api().post(`${poolBase}/requests/${id}/respond`).set('Cookie', s.cookie).send({ response });

describe('regional float pool', () => {
  let regionId: string, otherRegionId: string, pro3: S;
  let ref1: string, ref2: string, requestId: string;

  beforeAll(async () => {
    await ctx.db.query(`UPDATE legal_signoffs SET signed_off = true, reference = 'test review', signed_off_at = now()`); // these features stay off until legal sign-off is recorded
    pro3 = await makePro('pro3@example.com', true);
  });

  it('lets only marketplace staff create and manage regions', async () => {
    expect((await adminX('/regions', finance).post({ name: 'Georgia', states: ['GA'] })).status).toBe(403);
    expect((await api().post('/api/v1/admin/exchange/regions').set('Cookie', ownerA.cookie).send({ name: 'Georgia', states: ['GA'] })).status).toBe(403);
    expect((await adminX('/regions').post({ name: 'Georgia', states: [] })).status).toBe(422);
    expect((await adminX('/regions').post({ name: 'Georgia', states: ['Georgia'] })).status).toBe(422);
    const created = await adminX('/regions').post({ name: 'Georgia', states: ['GA', 'GA'] });
    expect(created.status).toBe(201);
    regionId = created.body.region.id;
    expect(created.body.region.states).toEqual(['GA']); // duplicates collapse
    expect((await adminX('/regions').post({ name: 'georgia', states: ['GA'] })).status).toBe(409); // names are unique, ignoring case
    otherRegionId = (await adminX('/regions').post({ name: 'Ohio', states: ['OH'] })).body.region.id;
    expect((await adminX(`/regions/${otherRegionId}`).patch({ name: 'Ohio Valley' })).body.region.name).toBe('Ohio Valley');
    expect((await adminX('/regions').get()).body.regions).toHaveLength(2);
  });

  it('asks a professional for explicit, versioned consent before they join', async () => {
    const info = await api().get(poolBase).set('Cookie', pro1.cookie);
    expect(info.body.terms.version).toBe('float-pool-v1');
    expect(info.body.terms.text).toMatch(/only if you accept/);
    expect(info.body.regions.map((r: any) => r.name)).toContain('Georgia');
    expect((await api().post(`${poolBase}/join`).set('Cookie', pro1.cookie).send({ regionId })).status).toBe(422);
    expect((await api().post(`${poolBase}/join`).set('Cookie', pro1.cookie).send({ regionId, accept: false })).status).toBe(422);
    for (const s of [pro1, pro2, pro3]) expect((await api().post(`${poolBase}/join`).set('Cookie', s.cookie).send({ regionId, accept: true })).status).toBe(201);
    const [m] = await ctx.db.query<{ consent_version: string }>('SELECT consent_version FROM float_pool_members WHERE professional_id = $1', [await proId(pro1)]);
    expect(m!.consent_version).toBe('float-pool-v1');
    expect((await api().post(`${poolBase}/join`).set('Cookie', ownerA.cookie).send({ regionId, accept: true })).status).toBe(404); // not a professional
  });

  it('keeps the pool closed to facilities until they accept the exchange terms', async () => {
    expect((await ex(`/pool?regionId=${regionId}`, recruiter).get()).status).toBe(403);
    const regions = await ex('/regions', ownerA).get();
    expect(regions.body.regions.find((r: any) => r.name === 'Georgia')).toMatchObject({ has_location: true, participation: null });
    expect(regions.body.terms.text).toMatch(/must not try to identify/);
    expect((await ex('/participation', ownerA).post({ regionId })).status).toBe(422);
    expect((await ex('/participation', scheduler).post({ regionId, acceptTerms: true })).status).toBe(403); // org.update
    expect((await ex('/participation', ownerA).post({ regionId: otherRegionId, acceptTerms: true })).status).toBe(422); // no location in Ohio
    expect((await ex('/participation', ownerA).post({ regionId, acceptTerms: true })).status).toBe(201);
    expect((await ex(`/pool?regionId=${regionId}`, ownerB, orgB).get()).status).toBe(403); // orgB never joined
    expect((await ex(`/pool?regionId=${regionId}`, ownerB, orgA).get()).status).toBe(404); // and is not a member of orgA
  });

  it('shows anonymous cards only, with real availability, and hides small counts', async () => {
    const res = await ex(`/pool?regionId=${regionId}`, recruiter).get();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const raw = JSON.stringify(res.body);
    for (const leak of ['pro1@example.com', 'pro2@example.com', 'Test User', 'full_name', 'email', await proId(pro1), pro1.id, 'professional_id']) expect(raw).not.toContain(leak);
    const card = res.body.pool[0];
    expect(card.talentRef).toEqual(expect.any(String));
    expect(card.availability).toHaveLength(7);
    expect(card.availability[0]).toMatchObject({ dayOfWeek: 0, startTime: '00:00' });
    expect(card.credentials.length).toBeGreaterThan(0);
    const sum = await ex(`/pool/summary?regionId=${regionId}`, recruiter).get();
    expect(sum.body.professions).toEqual([{ profession: expect.any(String), members: null, label: 'fewer than 5' }]);
  });

  it('matches the pool to one shift: only people who can actually work it', async () => {
    const eligible = await ex(`/pool?regionId=${regionId}&shiftId=${shiftId}`, recruiter).get();
    expect(eligible.body.pool.every((c: any) => c.match.outcome === 'eligible')).toBe(true);
    expect(eligible.body.total).toBe(2); // pro1 and pro3 are verified; pro2 is not
    const all = await ex(`/pool?regionId=${regionId}&shiftId=${shiftId}&show=all`, recruiter).get();
    expect(all.body.total).toBe(3);
    const pending = all.body.pool.find((c: any) => c.match.outcome !== 'eligible');
    expect(pending.match.reasons.length).toBeGreaterThan(0);
    expect(all.body.pool.at(-1).match.outcome).not.toBe('eligible'); // ineligible people sort last
    ref1 = await refOf(pro1);
    ref2 = await refOf(pro2);
    expect(pending.talentRef).toBe(ref2);
    expect((await ex(`/pool?regionId=${regionId}&shiftId=${'11111111-1111-4111-8111-111111111111'}`, recruiter).get()).status).toBe(404);
  });

  it('sends a request only for a shift the person could really work', async () => {
    expect((await ex('/requests', scheduler).post({ talentRef: ref1, shiftId })).status).toBe(403); // applications.manage
    expect((await ex('/requests', recruiter).post({ talentRef: 'not-a-real-reference-1234', shiftId })).status).toBe(404);
    const refused = await ex('/requests', recruiter).post({ talentRef: ref2, shiftId });
    expect(refused.status).toBe(409); // not eligible
    expect(refused.body.error.details.reasons.length).toBeGreaterThan(0);
    const sent = await ex('/requests', recruiter).post({ talentRef: ref1, shiftId, message: 'We could use you on the unit.' });
    expect(sent.status).toBe(201);
    requestId = sent.body.request.id;
    expect((await ex('/requests', recruiter).post({ talentRef: ref1, shiftId })).status).toBe(409); // already pending
    const [row] = await ctx.db.query<{ hourly_rate_cents: number }>('SELECT hourly_rate_cents FROM float_requests WHERE id = $1', [requestId]);
    expect(row!.hourly_rate_cents).toBe(5500); // defaults to the shift's rate
  });

  it('lists your own open shifts in the region to choose from', async () => {
    const res = await ex(`/shifts?regionId=${regionId}`, recruiter).get();
    expect(res.status).toBe(200);
    expect(res.body.shifts.map((x: any) => x.id)).toContain(shiftId);
    expect(res.body.shifts[0]).toMatchObject({ state: 'GA', open_positions: 2 });
    expect((await ex(`/shifts?regionId=${otherRegionId}`, recruiter).get()).status).toBe(403); // not a participant there
  });

  it('keeps the person anonymous to the facility until they accept', async () => {
    const list = await ex('/requests', recruiter).get();
    expect(list.body.requests[0]).toMatchObject({ id: requestId, status: 'pending', application_id: null });
    const raw = JSON.stringify(list.body);
    for (const leak of ['Test User', 'pro1@example.com', 'full_name']) expect(raw).not.toContain(leak);
    expect((await ctx.db.query('SELECT 1 FROM applications WHERE source = $1', ['float_pool'])).length).toBe(0);
    const mine = await api().get(`${poolBase}/requests`).set('Cookie', pro1.cookie);
    expect(mine.body.requests[0]).toMatchObject({ id: requestId, status: 'pending', organization_name: 'Alpha Health', hourly_rate_cents: 5500 });
    expect((await notifs(pro1)).some((n) => n.type === 'float_request.sent' && n.body.includes('only if you accept'))).toBe(true);
    expect((await respond(pro2, requestId, 'accepted')).status).toBe(404); // someone else's request
  });

  it('books the shift through the normal offer path when they accept', async () => {
    const res = await respond(pro1, requestId, 'accepted');
    expect(res.status).toBe(200);
    expect(res.body.assignmentId).toEqual(expect.any(String));
    const [app] = await ctx.db.query<{ source: string; status: string; id: string }>(`SELECT id, source, status FROM applications WHERE professional_id = $1`, [await proId(pro1)]);
    expect(app).toMatchObject({ source: 'float_pool', status: 'submitted' });
    const [offer] = await ctx.db.query<{ status: string; hourly_rate_cents: number }>('SELECT status, hourly_rate_cents FROM shift_offers WHERE application_id = $1', [app!.id]);
    expect(offer).toMatchObject({ status: 'accepted', hourly_rate_cents: 5500 });
    const [asg] = await ctx.db.query<{ status: string; shift_id: string }>('SELECT status, shift_id FROM assignments WHERE id = $1', [res.body.assignmentId]);
    expect(asg).toMatchObject({ status: 'confirmed', shift_id: shiftId });
    // Now, and only now, the facility can see who it is, through the ordinary application view.
    const detail = await api().get(`${orgUrl()}/applications/${app!.id}`).set('Cookie', recruiter.cookie);
    expect(detail.body.application.full_name).toBe('Test User');
    expect(detail.body.application.source).toBe('float_pool');
    expect((await ex('/requests', recruiter).get()).body.requests[0]).toMatchObject({ status: 'accepted', application_id: app!.id });
    expect((await notifs(recruiter)).some((n) => n.type === 'float_request.accepted')).toBe(true);
    expect((await respond(pro1, requestId, 'accepted')).status).toBe(404); // cannot answer twice
    const audit = (await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'float_request.%' OR action LIKE 'shift_offer.%'`)).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['float_request.sent', 'float_request.accepted', 'shift_offer.sent', 'shift_offer.accepted']));
  });

  it('lets a person decline without telling the facility who they are', async () => {
    const ref3 = await refOf(pro3);
    const sent = await ex('/requests', recruiter).post({ talentRef: ref3, shiftId, hourlyRateCents: 6000 });
    expect(sent.status).toBe(201);
    expect((await respond(pro3, sent.body.request.id, 'declined')).status).toBe(200);
    const n = (await notifs(recruiter)).find((x) => x.type === 'float_request.declined');
    expect(JSON.stringify(n)).not.toMatch(/Test User|pro3/);
    expect((await ex('/requests', recruiter).get()).body.requests.find((r: any) => r.id === sent.body.request.id)).toMatchObject({ status: 'declined', application_id: null });
    expect((await ctx.db.query('SELECT 1 FROM applications WHERE professional_id = $1', [await proId(pro3)])).length).toBe(0);
  });

  it('lets a facility withdraw a request, and lets a person leave the pool', async () => {
    const sent = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(sent.status).toBe(201);
    expect((await ex(`/requests/${sent.body.request.id}`, scheduler).del()).status).toBe(403);
    expect((await ex(`/requests/${sent.body.request.id}`, recruiter).del()).status).toBe(204);
    expect((await ex(`/requests/${sent.body.request.id}`, recruiter).del()).status).toBe(404); // already withdrawn
    const again = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(again.status).toBe(201);
    expect((await api().post(`${poolBase}/leave`).set('Cookie', pro3.cookie).send({ regionId })).status).toBe(204);
    expect((await api().post(`${poolBase}/leave`).set('Cookie', pro3.cookie).send({ regionId })).status).toBe(404);
    expect((await respond(pro3, again.body.request.id, 'accepted')).status).toBe(404); // leaving withdrew it
    expect((await ex(`/pool?regionId=${regionId}`, recruiter).get()).body.total).toBe(2); // pro3 no longer shown
  });

  it('refuses a stale acceptance and leaves no trace of the person', async () => {
    const proIdThree = await proId(pro3);
    await api().post(`${poolBase}/join`).set('Cookie', pro3.cookie).send({ regionId, accept: true });
    const sent = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(sent.status).toBe(201);
    await ctx.db.query(`UPDATE shifts SET status = 'cancelled' WHERE id = $1`, [shiftId]); // the facility changed its mind meanwhile
    const res = await respond(pro3, sent.body.request.id, 'accepted');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no longer open/);
    expect((await ctx.db.query('SELECT 1 FROM applications WHERE professional_id = $1', [proIdThree])).length).toBe(0); // nothing created, so no identity revealed
    expect((await ex('/requests', recruiter).get()).body.requests.find((r: any) => r.id === sent.body.request.id).status).toBe('failed');
    await ctx.db.query(`UPDATE shifts SET status = 'open' WHERE id = $1`, [shiftId]);
  });

  it('leaves nothing behind when the booking fails part-way, so the facility never learns who the person is', async () => {
    const proIdThree = await proId(pro3);
    const sent = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(sent.status).toBe(201);
    // Make the last step of the booking (creating the assignment) fail AFTER the application and the offer were created.
    await ctx.db.query(`CREATE OR REPLACE FUNCTION test_block_assignments() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $$ LANGUAGE plpgsql`);
    await ctx.db.query('CREATE TRIGGER test_block BEFORE INSERT ON assignments FOR EACH ROW EXECUTE FUNCTION test_block_assignments()');
    try {
      const res = await respond(pro3, sent.body.request.id, 'accepted');
      expect(res.status).toBe(409);
      expect((await ctx.db.query('SELECT 1 FROM applications WHERE professional_id = $1', [proIdThree])).length).toBe(0);
      expect((await ctx.db.query('SELECT 1 FROM shift_offers WHERE professional_id = $1', [proIdThree])).length).toBe(0);
      expect((await ctx.db.query(`SELECT 1 FROM assignments WHERE professional_id = $1`, [proIdThree])).length).toBe(0);
      const [row] = await ctx.db.query<{ status: string; failure_reason: string; application_id: string | null }>('SELECT status, failure_reason, application_id FROM float_requests WHERE id = $1', [sent.body.request.id]);
      expect(row).toMatchObject({ status: 'failed', application_id: null });
      expect(row!.failure_reason).toMatch(/could not be booked/);
    } finally {
      await ctx.db.query('DROP TRIGGER test_block ON assignments');
    }
  });

  it('expires unanswered requests', async () => {
    const sent = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(sent.status).toBe(201);
    await ctx.db.query(`UPDATE float_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [sent.body.request.id]);
    expect((await respond(pro3, sent.body.request.id, 'accepted')).status).toBe(404);
    expect((await api().get(`${poolBase}/requests`).set('Cookie', pro3.cookie)).body.requests.find((r: any) => r.id === sent.body.request.id).status).toBe('expired');
  });

  it('lets staff suspend a facility, which closes the pool to it', async () => {
    const pending = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(pending.status).toBe(201);
    const participant = (await adminX('/participants').get()).body.participants.find((p: any) => p.organization_id === orgA);
    expect((await adminX(`/participants/${participant.id}/status`, finance).post({ status: 'suspended', reason: 'Tried to contact members' })).status).toBe(403);
    expect((await adminX(`/participants/${participant.id}/status`).post({ status: 'suspended' })).status).toBe(422); // reason required
    expect((await adminX(`/participants/${participant.id}/status`).post({ status: 'suspended', reason: 'Tried to contact members' })).status).toBe(200);
    expect((await ex(`/pool?regionId=${regionId}`, recruiter).get()).status).toBe(403);
    expect((await ex('/participation', ownerA).post({ regionId, acceptTerms: true })).status).toBe(403); // cannot simply rejoin
    expect((await respond(pro3, pending.body.request.id, 'accepted')).status).toBe(404); // its pending requests were withdrawn
    expect((await notifs(ownerA)).some((n) => n.type === 'exchange.participation_suspended')).toBe(true);
    expect((await adminX(`/participants/${participant.id}/status`).post({ status: 'active', reason: 'Reviewed and cleared' })).status).toBe(200);
    expect((await ex(`/pool?regionId=${regionId}`, recruiter).get()).status).toBe(200);
  });

  it('only requests shifts inside the pool\'s region', async () => {
    await ctx.db.query(`UPDATE exchange_regions SET states = ARRAY['FL'] WHERE id = $1`, [regionId]);
    expect((await ex(`/pool?regionId=${regionId}`, recruiter).get()).status).toBe(200);
    const res = await ex('/requests', recruiter).post({ talentRef: await refOf(pro3), shiftId });
    expect(res.status).toBe(409); // the shift is in Georgia, the region now covers Florida
    expect((await ex(`/pool?regionId=${regionId}&shiftId=${shiftId}`, recruiter).get()).status).toBe(422);
    await ctx.db.query(`UPDATE exchange_regions SET states = ARRAY['GA'] WHERE id = $1`, [regionId]);
  });
});
