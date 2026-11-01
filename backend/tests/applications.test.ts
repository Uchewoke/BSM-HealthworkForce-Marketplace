import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { localMinuteOfWeek } from '../src/modules/matching/availability.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let ownerA: S, recruiter: S, readonly: S, scheduler: S, ownerB: S, reviewer: S, superAdmin: S;
let pro1: S, pro2: S, pro3: S, pro4: S, pro5: S;
let orgA: string, orgB: string, jobId: string, permJobId: string, shiftId: string, rnId: string, icuId: string, locA: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
const base = '/api/v1/professionals/me';
const allDays = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '23:59' }));

const decideCred = (id: string, to: string, extra: object = {}) =>
  api().post(`/api/v1/admin/credentials/${id}/status`).set('Cookie', reviewer.cookie).send({ to, ...extra });

async function addCredential(p: S, body: object, finish: 'verified' | 'pending' = 'verified', method: 'primary_source' | 'document_review' = 'primary_source') {
  const c = (await api().post(`${base}/credentials`).set('Cookie', p.cookie).send(body)).body.credential;
  await api().post(`${base}/credentials/${c.id}/documents`).set('Cookie', p.cookie).set('Content-Type', 'application/pdf').send(PDF);
  expect((await api().post(`${base}/credentials/${c.id}/submit`).set('Cookie', p.cookie)).status).toBe(200);
  if (finish === 'verified') {
    await decideCred(c.id, 'pending_review');
    expect((await decideCred(c.id, 'verified', method === 'primary_source' ? { method, sourceReference: 'Nursys lookup 2026-10-30' } : { method })).status).toBe(200);
  }
  return c.id as string;
}
const LICENSE = { kind: 'license', credentialType: 'RN', jurisdiction: 'GA', number: 'RN-1234567', issueDate: '2023-01-01', expirationDate: '2099-01-01' };
const BLS = { kind: 'certification', credentialType: 'BLS', issueDate: '2025-01-01', expirationDate: '2099-01-01' };

async function makePro(email: string, o: { avail?: object[]; prefs?: object; startDate?: string; specialty?: boolean } = {}) {
  const s = await ctx.userWithSession(email);
  await api().post('/api/v1/professionals').set('Cookie', s.cookie).send({ professionId: rnId, state: 'GA' });
  if (o.specialty !== false) await api().put(`${base}/specialties`).set('Cookie', s.cookie).send({ specialtyIds: [icuId] });
  await api().post(`${base}/experience`).set('Cookie', s.cookie).send({ employer: 'Hospital', title: 'RN', specialtyId: icuId, startDate: o.startDate ?? '2015-01-01', isCurrent: true });
  await api().put(`${base}/availability`).set('Cookie', s.cookie).send({ windows: o.avail ?? allDays });
  await api().put(`${base}/preferences`).set('Cookie', s.cookie).send(o.prefs ?? { employmentTypes: ['per_diem'], shiftTypes: ['day'], preferredStates: ['GA'], minHourlyRateCents: 4500 });
  return s;
}
const apply = (s: S, id = jobId, body: object = { shiftIds: [shiftId] }) => api().post(`/api/v1/jobs/${id}/apply`).set('Cookie', s.cookie).send(body);
const candidates = (s: S = recruiter, org = orgA, job = jobId, q = '') => api().get(`/api/v1/organizations/${org}/jobs/${job}/candidates${q}`).set('Cookie', s.cookie);
const facilityStatus = (appId: string, to: string, s: S = recruiter, reason?: string, org = orgA) =>
  api().post(`/api/v1/organizations/${org}/applications/${appId}/status`).set('Cookie', s.cookie).send({ to, reason });
const proStatus = (appId: string, to: string, s: S) => api().post(`${base}/applications/${appId}/status`).set('Cookie', s.cookie).send({ to });
const appIdOf = async (s: S) => (await api().get(`${base}/applications`).set('Cookie', s.cookie)).body.applications[0].id as string;
const notifs = async (s: S) => (await api().get('/api/v1/notifications').set('Cookie', s.cookie)).body.notifications as any[];

beforeAll(async () => {
  ctx = await makeTestApp();
  ownerA = await ctx.userWithSession('owner.a@example.com');
  recruiter = await ctx.userWithSession('recruiter@example.com');
  readonly = await ctx.userWithSession('readonly@example.com');
  scheduler = await ctx.userWithSession('scheduler@example.com');
  ownerB = await ctx.userWithSession('owner.b@example.com');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  superAdmin = await ctx.adminSession('super@bsm.example', 'platform_super_admin');

  orgA = (await api().post('/api/v1/organizations').set('Cookie', ownerA.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'read_only'), ($1,$4,'scheduler')`, [orgA, recruiter.id, readonly.id, scheduler.id]);
  const f = await api().post(`/api/v1/organizations/${orgA}/facilities`).set('Cookie', ownerA.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
  locA = (await api().post(`/api/v1/organizations/${orgA}/facilities/${f.body.facility.id}/locations`).set('Cookie', ownerA.cookie)
    .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' })).body.location.id;

  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', ownerA.cookie)).body.professions as any[];
  const rn = tax.find((p) => p.code === 'rn');
  rnId = rn.id;
  icuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;

  const jobsUrl = `/api/v1/organizations/${orgA}/jobs`;
  const mkJob = async (extra: object) => (await api().post(jobsUrl).set('Cookie', ownerA.cookie).send({
    title: 'ICU Nurse', description: 'Critical care nursing in a 24-bed ICU with excellent staffing support.', locationId: locA, professionId: rnId, specialtyId: icuId,
    employmentType: 'per_diem', payMinCents: 5000, payMaxCents: 6500, minYearsExperience: 2, ...extra,
  })).body.job.id as string;
  jobId = await mkJob({});
  await api().put(`${jobsUrl}/${jobId}/requirements`).set('Cookie', ownerA.cookie).send({ requirements: [
    { kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }, { kind: 'certification', credentialType: 'BLS' }] });
  const day = new Date(Date.now() + 10 * 86_400_000);
  const at = (h: number) => { const d = new Date(day); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
  shiftId = (await api().post(`${jobsUrl}/${jobId}/shifts`).set('Cookie', ownerA.cookie).send({ startsAt: at(14), endsAt: at(22), positions: 3 })).body.shift.id;
  expect((await api().post(`${jobsUrl}/${jobId}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' })).status).toBe(200);
  permJobId = await mkJob({ title: 'Permanent RN', employmentType: 'permanent', payUnit: 'year', payMinCents: 8_000_000, payMaxCents: 9_000_000, noCredentialRequirements: true });
  expect((await api().post(`${jobsUrl}/${permJobId}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' })).status).toBe(200);

  // Professionals
  pro1 = await makePro('pro1@example.com');
  await addCredential(pro1, LICENSE); await addCredential(pro1, BLS, 'verified', 'document_review');
  pro2 = await makePro('pro2@example.com');
  await addCredential(pro2, LICENSE, 'pending'); await addCredential(pro2, BLS);
  pro3 = await makePro('pro3@example.com');
  pro4 = await makePro('pro4@example.com', { startDate: '2022-01-01', prefs: { employmentTypes: ['permanent'], shiftTypes: ['night'], preferredStates: ['TX'], minHourlyRateCents: 12000 } });
  await addCredential(pro4, LICENSE); await addCredential(pro4, BLS);
  const shiftDow = Math.floor(localMinuteOfWeek(new Date(at(14)), 'America/New_York') / 1440);
  pro5 = await makePro('pro5@example.com', { avail: allDays.filter((w) => w.dayOfWeek !== shiftDow) });
  await addCredential(pro5, LICENSE); await addCredential(pro5, BLS);
});

describe('applying', () => {
  it('requires sign-in and a professional profile', async () => {
    expect((await api().post(`/api/v1/jobs/${jobId}/apply`).send({})).status).toBe(401);
    expect((await apply(readonly)).status).toBe(404);
  });

  it('refuses applicants who clearly miss mandatory requirements, and says why', async () => {
    const res = await apply(pro3);
    expect(res.status).toBe(409);
    expect(res.body.error.details.outcome).toBe('ineligible');
    expect(res.body.error.details.reasons.map((r: any) => r.code)).toContain('credential_missing');
    expect(await ctx.db.query(`SELECT 1 FROM applications a JOIN professionals p ON p.id = a.professional_id JOIN users u ON u.id = p.user_id WHERE u.email = 'pro3@example.com'`)).toHaveLength(0);
  });

  it('refuses shifts the applicant is not available for', async () => {
    const res = await apply(pro5);
    expect(res.status).toBe(409);
    expect(res.body.error.details.outcome).toBe('unavailable');
  });

  it('accepts eligible and pending-verification applicants and stores the evaluation', async () => {
    const ok = await apply(pro1, jobId, { shiftIds: [shiftId], coverNote: 'Available any week.' });
    expect(ok.status).toBe(201);
    expect(ok.body.eligibility.outcome).toBe('eligible');
    const pending = await apply(pro2);
    expect(pending.status).toBe(201);
    expect(pending.body.eligibility).toMatchObject({ outcome: 'pending_verification' });
    expect((await apply(pro4)).status).toBe(201);
    const [m] = await ctx.db.query<{ outcome: string; rules_version: string; score: string | null; trigger: string }>(
      `SELECT outcome, rules_version, score, trigger FROM candidate_matches WHERE application_id = $1`, [ok.body.application.id]);
    expect(m).toMatchObject({ outcome: 'eligible', rules_version: 'eligibility-v1', trigger: 'apply' });
    expect(Number(m!.score)).toBeGreaterThan(0);
  });

  it('prevents duplicates, unlisted jobs, bad shifts and conflicts of interest', async () => {
    expect((await apply(pro1)).status).toBe(409);
    expect((await apply(pro1, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await apply(pro2, permJobId, { shiftIds: [shiftId] })).status).toBe(422);
    expect((await apply(pro2, permJobId, { shiftIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(422);
    await api().post('/api/v1/professionals').set('Cookie', ownerA.cookie).send({ professionId: rnId });
    expect((await apply(ownerA, permJobId, {})).status).toBe(409); // own organization's job
  });

  it('notifies only staff who can manage applications, without personal details in the email', async () => {
    for (const staff of [ownerA, recruiter]) {
      const n = (await notifs(staff)).filter((x) => x.type === 'application.submitted');
      expect(n.length).toBe(3);
      expect(n[0].body).toMatch(/applied/);
    }
    expect((await notifs(readonly)).length).toBe(0);
    expect((await notifs(scheduler)).length).toBe(0);
    const emails = ctx.email.messages.filter((m) => m.template === 'notification' && m.to === 'recruiter@example.com');
    expect(emails.length).toBe(3);
    expect(JSON.stringify(emails)).not.toMatch(/pro1|Test User|Nursys/);
    expect(emails[0]!.title).toBe('New application: ICU Nurse');
    expect((await notifs(recruiter))[0].email_status).toBe('not_delivered'); // no provider: never reported as sent
  });
});

describe('candidate review', () => {
  it('ranks eligible candidates with explanations and lists others with reasons, not hidden', async () => {
    const res = await candidates();
    expect(res.status).toBe(200);
    const list = res.body.candidates as any[];
    expect(list.map((c) => c.eligibility.outcome)).toEqual(['eligible', 'eligible', 'pending_verification']);
    expect(list.map((c) => c.rank)).toEqual([1, 2, null]);
    expect(list[0].score).toBeGreaterThan(list[1].score);
    expect(list[2].score).toBeNull();
    expect(list[2].eligibility.reasons[0].code).toBe('credential_pending');
    expect(list[0].applicant.name).toBe('Test User');
    expect(res.body.note).toMatch(/never overrides/);
  });

  it('all staff can view candidates; other tenants cannot', async () => {
    expect((await candidates(readonly)).status).toBe(200);
    expect((await candidates(scheduler)).status).toBe(200); // every role can read; only managers can change status
    expect((await candidates(ownerB, orgB)).status).toBe(404); // job is not in org B
    expect((await candidates(ownerB, orgA)).status).toBe(404);
    expect((await candidates(recruiter, orgA, jobId, '?pageSize=1')).body.candidates).toHaveLength(1);
    expect((await candidates(recruiter, orgA, jobId, '?pageSize=100')).status).toBe(422);
  });

  it('shows facilities credential statuses only: no numbers, documents or review notes', async () => {
    const list = (await candidates()).body.candidates;
    const detail = await api().get(`/api/v1/organizations/${orgA}/applications/${list[0].applicationId}`).set('Cookie', recruiter.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.applicant.credentials.find((c: any) => c.credential_type === 'RN')).toMatchObject({ effective_status: 'verified', status_label: 'Verified with the primary source' });
    expect(detail.body.applicant.credentials.find((c: any) => c.credential_type === 'BLS').status_label).toBe('Documents reviewed (not verified with the primary source)');
    expect(JSON.stringify(detail.body)).not.toMatch(/RN-1234567|storage_key|number_enc|Nursys|internal_note|@example\.com/);
    expect(detail.body.ranking.factors).toHaveLength(7);
    expect(detail.body.eligibility.requirements.every((r: any) => r.result === 'met')).toBe(true);
    const pendingId = list[2].applicationId;
    const pendingDetail = await api().get(`/api/v1/organizations/${orgA}/applications/${pendingId}`).set('Cookie', recruiter.cookie);
    expect(pendingDetail.body.ranking).toBeNull();
    expect(pendingDetail.body.eligibility.outcome).toBe('pending_verification');
  });

  it('shows the professional their own reasons, but not the facility ranking', async () => {
    const id = await appIdOf(pro2);
    const mine = await api().get(`${base}/applications/${id}`).set('Cookie', pro2.cookie);
    expect(mine.body.eligibility.outcome).toBe('pending_verification');
    expect(mine.body.eligibility.requirements.find((r: any) => r.requirement.kind === 'license').result).toBe('pending');
    expect(JSON.stringify(mine.body)).not.toMatch(/"score"|"ranking"|factors/);
    expect((await api().get(`${base}/applications/${id}`).set('Cookie', pro1.cookie)).status).toBe(404);
    expect((await api().get(`/api/v1/organizations/${orgA}/applications/${id}`).set('Cookie', ownerB.cookie)).status).toBe(404);
  });

  it('ranking weights are configurable by platform settings managers only and versioned in stored matches', async () => {
    expect((await api().put('/api/v1/admin/settings/ranking-weights').set('Cookie', reviewer.cookie).send({ specialty: 25, experience: 20, location: 15, availability: 15, compensation: 10, workHistory: 10, completeness: 5 })).status).toBe(403);
    expect((await api().put('/api/v1/admin/settings/ranking-weights').set('Cookie', superAdmin.cookie).send({ specialty: 50, experience: 20, location: 15, availability: 15, compensation: 10, workHistory: 10, completeness: 5 })).status).toBe(422);
    const ok = await api().put('/api/v1/admin/settings/ranking-weights').set('Cookie', superAdmin.cookie).send({ specialty: 10, experience: 30, location: 10, availability: 10, compensation: 20, workHistory: 10, completeness: 10 });
    expect(ok.body.version).toBe(1);
    const list = (await candidates()).body.candidates;
    expect(list.map((c: any) => c.rank)).toEqual([1, 2, null]); // re-evaluated live with the new weights
    const detail = await api().get(`/api/v1/organizations/${orgA}/applications/${list[0].applicationId}`).set('Cookie', recruiter.cookie);
    expect(detail.body.ranking.factors.find((f: any) => f.key === 'experience').weight).toBe(30);
  });
});

describe('status changes cannot bypass eligibility', () => {
  let app1: string, app2: string, app4: string;

  it('enforces the allowed transitions and required reasons', async () => {
    [app1, app2, app4] = [await appIdOf(pro1), await appIdOf(pro2), await appIdOf(pro4)];
    expect((await facilityStatus(app1, 'offer_sent')).status).toBe(409); // cannot jump from submitted
    expect((await facilityStatus(app1, 'rejected')).status).toBe(422);
    expect((await facilityStatus(app1, 'under_review')).status).toBe(200);
    expect((await facilityStatus(app1, 'shortlisted')).status).toBe(200);
    expect((await facilityStatus(app1, 'withdrawn')).status).toBe(422); // not a facility action
    expect((await facilityStatus(app1, 'accepted')).status).toBe(422);
    expect((await proStatus(app1, 'rejected', pro1)).status).toBe(422); // not a professional action
  });

  it('only staff who can manage applications may change status, and only in their own organization', async () => {
    expect((await facilityStatus(app2, 'under_review', readonly)).status).toBe(403);
    expect((await facilityStatus(app2, 'under_review', scheduler)).status).toBe(403);
    expect((await facilityStatus(app2, 'under_review', ownerB, undefined, orgB)).status).toBe(404);
    expect((await facilityStatus(app2, 'under_review', ownerB, undefined, orgA)).status).toBe(404);
    expect((await proStatus(app2, 'withdrawn', pro1)).status).toBe(404); // someone else's application
  });

  it('refuses an offer to a candidate who is not eligible, records why, and leaves the status alone', async () => {
    await facilityStatus(app2, 'shortlisted');
    const res = await facilityStatus(app2, 'offer_sent');
    expect(res.status).toBe(409);
    expect(res.body.error.details.outcome).toBe('pending_verification');
    expect(res.body.error.details.reasons[0].code).toBe('credential_pending');
    const [a] = await ctx.db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [app2]);
    expect(a!.status).toBe('shortlisted');
    const [snap] = await ctx.db.query(`SELECT 1 FROM candidate_matches WHERE application_id = $1 AND trigger = 'offer' AND outcome = 'pending_verification'`, [app2]);
    expect(snap).toBeTruthy();
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'application.transition_refused_ineligible' AND target_id = $1`, [app2]);
    expect(log).toBeTruthy();
  });

  it('a high ranking score does not help: eligibility is judged first', async () => {
    const pendingScoreHidden = (await candidates()).body.candidates.find((c: any) => c.applicationId === app2);
    expect(pendingScoreHidden.score).toBeNull();
    expect((await facilityStatus(app2, 'offer_sent')).status).toBe(409);
  });

  it('sends an offer to an eligible candidate, snapshotting the decision and notifying them', async () => {
    const res = await facilityStatus(app1, 'offer_sent');
    expect(res.status).toBe(200);
    const [snap] = await ctx.db.query<{ outcome: string; score: string }>(`SELECT outcome, score FROM candidate_matches WHERE application_id = $1 AND trigger = 'offer'`, [app1]);
    expect(snap).toMatchObject({ outcome: 'eligible' });
    expect((await notifs(pro1)).some((n) => n.type === 'application.offer_sent' && n.title.startsWith('Update on your application'))).toBe(true);
  });

  it('blocks acceptance if a required credential expired after the offer, and allows it once valid', async () => {
    await ctx.db.query(`UPDATE credentials SET issue_date = '2019-01-01', expiration_date = '2020-01-01' WHERE professional_id = (SELECT id FROM professionals WHERE user_id = $1) AND credential_type = 'RN'`, [pro1.id]);
    const blocked = await proStatus(app1, 'accepted', pro1);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.outcome).toBe('expired_credential');
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [app1]))[0]!.status).toBe('offer_sent');
    await ctx.db.query(`UPDATE credentials SET issue_date = '2023-01-01', expiration_date = '2099-01-01' WHERE professional_id = (SELECT id FROM professionals WHERE user_id = $1) AND credential_type = 'RN'`, [pro1.id]);
    expect((await proStatus(app1, 'accepted', pro1)).status).toBe(200);
    const accepts = await ctx.db.query<{ outcome: string }>(`SELECT outcome FROM candidate_matches WHERE application_id = $1 AND trigger = 'accept'`, [app1]);
    expect(accepts.map((a) => a.outcome).sort()).toEqual(['eligible', 'expired_credential']); // the refusal is recorded too
    expect((await facilityStatus(app1, 'rejected', recruiter, 'Changed our minds')).status).toBe(409); // accepted is final here
  });

  it('keeps other accepted shifts from overlapping', async () => {
    // pro1 accepted the shift above; evaluating pro1 for the same shift on a different job must now flag a conflict.
    const jobsUrl = `/api/v1/organizations/${orgA}/jobs`;
    const second = (await api().post(jobsUrl).set('Cookie', ownerA.cookie).send({
      title: 'Second ICU', description: 'Another critical care opening with the same coverage needs.', locationId: locA, professionId: rnId, specialtyId: icuId,
      employmentType: 'per_diem', noCredentialRequirements: true })).body.job.id;
    const orig = (await ctx.db.query<{ starts_at: string; ends_at: string }>('SELECT starts_at, ends_at FROM shifts WHERE id = $1', [shiftId]))[0]!;
    const sh = (await api().post(`${jobsUrl}/${second}/shifts`).set('Cookie', ownerA.cookie).send({
      startsAt: new Date(new Date(orig.starts_at).getTime() + 3600_000).toISOString(), endsAt: new Date(new Date(orig.ends_at).getTime() - 3600_000).toISOString() })).body.shift.id;
    await api().post(`${jobsUrl}/${second}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' });
    const res = await apply(pro1, second, { shiftIds: [sh] });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reasons.map((r: any) => r.code)).toContain('shift_conflict');
  });

  it('lets the professional withdraw, and notifies staff', async () => {
    expect((await proStatus(app4, 'withdrawn', pro4)).status).toBe(200);
    expect((await proStatus(app4, 'withdrawn', pro4)).status).toBe(409);
    expect((await notifs(recruiter)).some((n) => n.type === 'application.withdrawn')).toBe(true);
    expect((await candidates()).body.candidates.map((c: any) => c.applicationId)).not.toContain(app4); // closed hidden by default
    expect((await candidates(recruiter, orgA, jobId, '?includeClosed=true')).body.candidates.map((c: any) => c.applicationId)).toContain(app4);
    const hist = (await api().get(`${base}/applications/${app4}`).set('Cookie', pro4.cookie)).body.history.map((h: any) => h.to_status);
    expect(hist).toEqual(['submitted', 'withdrawn']);
  });

  it('records rejections with a reason shown to the professional', async () => {
    expect((await facilityStatus(app2, 'rejected', recruiter, 'We selected another candidate.')).status).toBe(200);
    const n = (await notifs(pro2)).find((x) => x.type === 'application.rejected');
    expect(n.body).toContain('We selected another candidate.');
  });
});

describe('notifications', () => {
  it('are private, readable, countable and markable as read', async () => {
    const mine = await notifs(pro1);
    expect(mine.length).toBeGreaterThan(0);
    const count = (await api().get('/api/v1/notifications/unread-count').set('Cookie', pro1.cookie)).body.unread;
    expect(count).toBe(mine.filter((n) => !n.read_at).length);
    expect((await api().post(`/api/v1/notifications/${mine[0].id}/read`).set('Cookie', pro2.cookie)).status).toBe(404); // someone else's
    expect((await api().post(`/api/v1/notifications/${mine[0].id}/read`).set('Cookie', pro1.cookie)).status).toBe(204);
    expect((await api().get('/api/v1/notifications/unread-count').set('Cookie', pro1.cookie)).body.unread).toBe(count - 1);
    expect((await api().get('/api/v1/notifications?unread=true').set('Cookie', pro1.cookie)).body.total).toBe(count - 1);
    await api().post('/api/v1/notifications/read-all').set('Cookie', pro1.cookie);
    expect((await api().get('/api/v1/notifications/unread-count').set('Cookie', pro1.cookie)).body.unread).toBe(0);
    expect((await api().get('/api/v1/notifications')).status).toBe(401);
  });

  it('respect email preferences', async () => {
    const put = await api().put('/api/v1/notifications/preferences').set('Cookie', pro3.cookie).send({ preferences: [{ category: 'review_decisions', emailEnabled: false }] });
    expect(put.status).toBe(200);
    const prefs = (await api().get('/api/v1/notifications/preferences').set('Cookie', pro3.cookie)).body.preferences;
    expect(prefs).toEqual([{ category: 'application_updates', emailEnabled: true }, { category: 'review_decisions', emailEnabled: false }, { category: 'support_updates', emailEnabled: true }, { category: 'billing_updates', emailEnabled: true }]);
    const before = ctx.email.messages.length;
    const credId = await addCredential(pro3, { ...LICENSE, credentialType: 'RN (pref)' }, 'pending');
    await decideCred(credId, 'pending_review');
    await decideCred(credId, 'needs_more_information', { reason: 'Please re-upload a clearer scan.' });
    const n = (await notifs(pro3)).find((x) => x.type === 'credential.needs_more_information');
    expect(n).toMatchObject({ category: 'review_decisions', email_status: 'skipped', body: 'Please re-upload a clearer scan.' });
    expect(ctx.email.messages.length).toBe(before);
    expect((await api().put('/api/v1/notifications/preferences').set('Cookie', pro3.cookie).send({ preferences: [{ category: 'marketing', emailEnabled: true }] })).status).toBe(422);
  });
});
