/**
 * Release 1 acceptance journey, driven end to end through the HTTP API only (registration, email verification, MFA,
 * review, publishing, application, offer). The only direct database use is to read evidence at the end.
 * There is no browser UI yet, so this covers server behavior, authorization and state, not UI states.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, PASSWORD } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
const state: Record<string, any> = {};

/** Real sign-up: register, read the emailed token, verify, sign in. */
async function signUp(email: string) {
  expect((await api().post('/api/v1/auth/register').send({ email, password: PASSWORD, fullName: email.split('@')[0] })).status).toBe(202);
  expect((await api().post('/api/v1/auth/verify-email').send({ token: ctx.email.last(email, 'verify_email')!.token })).status).toBe(200);
  const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  return { cookie: cookieOf(login), id: login.body.user.id as string };
}

beforeAll(async () => { ctx = await makeTestApp(); });

describe('Release 1: facility onboarding', () => {
  it('1. a facility registers and submits its organization for review', async () => {
    state.owner = await signUp('owner@alpha-health.example');
    const org = await api().post('/api/v1/organizations').set('Cookie', state.owner.cookie).send({ name: 'Alpha Health', type: 'facility' });
    state.orgId = org.body.organization.id;
    expect((await api().post(`/api/v1/organizations/${state.orgId}/submit`).set('Cookie', state.owner.cookie)).status).toBe(422); // incomplete
    await api().patch(`/api/v1/organizations/${state.orgId}`).set('Cookie', state.owner.cookie)
      .send({ legalName: 'Alpha Health LLC', contactEmail: 'ops@alpha-health.example', contactPhone: '+1 404-555-0100', website: 'https://alpha-health.example', state: 'GA' });
    expect((await api().post(`/api/v1/organizations/${state.orgId}/submit`).set('Cookie', state.owner.cookie)).body.organization.status).toBe('submitted');
  });

  it('2. an unapproved facility cannot use restricted functions; a BSM reviewer approves with MFA', async () => {
    expect((await api().post(`/api/v1/organizations/${state.orgId}/facilities`).set('Cookie', state.owner.cookie).send({ name: 'Too Early', facilityType: 'hospital' })).status).toBe(403);
    state.reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
    const admin = (to: string, extra: object = {}) => api().post(`/api/v1/admin/organizations/${state.orgId}/status`).set('Cookie', state.reviewer.cookie).send({ to, ...extra });
    expect((await admin('approved')).status).toBe(409); // must be under review first
    expect((await admin('under_review')).status).toBe(200);
    expect((await admin('approved')).status).toBe(200);
    expect((await api().get('/api/v1/notifications').set('Cookie', state.owner.cookie)).body.notifications.some((n: any) => n.type === 'organization.approved')).toBe(true);
  });

  it('3. the approved facility adds locations, departments and a teammate', async () => {
    const f = await api().post(`/api/v1/organizations/${state.orgId}/facilities`).set('Cookie', state.owner.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
    expect(f.status).toBe(201);
    const l = await api().post(`/api/v1/organizations/${state.orgId}/facilities/${f.body.facility.id}/locations`).set('Cookie', state.owner.cookie)
      .send({ name: 'Main Campus', addressLine1: '100 Peachtree St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' });
    state.locationId = l.body.location.id;
    expect((await api().post(`/api/v1/organizations/${state.orgId}/facilities/${f.body.facility.id}/locations/${state.locationId}/departments`).set('Cookie', state.owner.cookie).send({ name: 'ICU' })).status).toBe(201);

    expect((await api().post(`/api/v1/organizations/${state.orgId}/invitations`).set('Cookie', state.owner.cookie).send({ email: 'recruiter@alpha-health.example', role: 'recruiter' })).status).toBe(201);
    state.recruiter = await signUp('recruiter@alpha-health.example');
    const accept = await api().post('/api/v1/invitations/accept').set('Cookie', state.recruiter.cookie).send({ token: ctx.email.last('recruiter@alpha-health.example', 'org_invitation')!.token });
    expect(accept.body).toMatchObject({ organizationId: state.orgId, role: 'recruiter' });
  });
});

describe('Release 1: professional onboarding and credentials', () => {
  it('4-5. a professional registers independently and builds a profile', async () => {
    state.pro = await signUp('nurse@example.com');
    const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', state.pro.cookie)).body.professions;
    const rn = tax.find((p: any) => p.code === 'rn');
    state.rnId = rn.id;
    state.icuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;
    const base = '/api/v1/professionals/me';
    expect((await api().post('/api/v1/professionals').set('Cookie', state.pro.cookie).send({ professionId: rn.id, headline: 'ICU nurse', state: 'GA' })).status).toBe(201);
    await api().put(`${base}/specialties`).set('Cookie', state.pro.cookie).send({ specialtyIds: [state.icuId] });
    await api().post(`${base}/education`).set('Cookie', state.pro.cookie).send({ institution: 'Georgia State University', degree: 'BSN', startYear: 2012, endYear: 2016 });
    await api().post(`${base}/experience`).set('Cookie', state.pro.cookie).send({ employer: 'Grady Memorial', title: 'Staff RN', specialtyId: state.icuId, startDate: '2016-06-01', isCurrent: true });
    await api().put(`${base}/preferences`).set('Cookie', state.pro.cookie).send({ employmentTypes: ['per_diem'], shiftTypes: ['day'], preferredStates: ['GA'], minHourlyRateCents: 4500 });
    await api().put(`${base}/availability`).set('Cookie', state.pro.cookie).send({ windows: Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '23:59' })) });
  });

  it('6. credentials are uploaded privately, and submission is not verification', async () => {
    const base = '/api/v1/professionals/me/credentials';
    const mk = async (body: object) => (await api().post(base).set('Cookie', state.pro.cookie).send(body)).body.credential.id as string;
    state.licenseId = await mk({ kind: 'license', credentialType: 'RN', jurisdiction: 'GA', number: 'RN-7654321', issueDate: '2022-01-01', expirationDate: '2099-01-01' });
    state.blsId = await mk({ kind: 'certification', credentialType: 'BLS', issueDate: '2025-01-01', expirationDate: '2099-01-01' });
    for (const id of [state.licenseId, state.blsId]) {
      const up = await api().post(`${base}/${id}/documents`).set('Cookie', state.pro.cookie).set('Content-Type', 'application/pdf').set('X-File-Name', 'scan.pdf').send(PDF);
      expect(up.status).toBe(201);
      state.docId ??= up.body.document.id;
      expect((await api().post(`${base}/${id}/submit`).set('Cookie', state.pro.cookie)).status).toBe(200);
    }
    const view = (await api().get(`${base}/${state.licenseId}`).set('Cookie', state.pro.cookie)).body.credential;
    expect(view).toMatchObject({ effective_status: 'submitted', status_label: 'Submitted, awaiting review', verified_at: null });
    // A facility member cannot reach the document, even with the id.
    expect((await api().post(`${base}/${state.licenseId}/documents/${state.docId}/access`).set('Cookie', state.owner.cookie)).status).toBe(404);
    expect((await api().post(`/api/v1/admin/credential-documents/${state.docId}/access`).set('Cookie', state.owner.cookie)).status).toBe(403);
  });

  it('7. a reviewer records outcomes; the professional sees accurate statuses', async () => {
    const decide = (id: string, to: string, extra: object = {}) => api().post(`/api/v1/admin/credentials/${id}/status`).set('Cookie', state.reviewer.cookie).send({ to, ...extra });
    expect((await decide(state.licenseId, 'verified', { method: 'primary_source', sourceReference: 'x' })).status).toBe(409); // not picked up yet
    for (const id of [state.licenseId, state.blsId]) await decide(id, 'pending_review');
    expect((await api().get(`/api/v1/professionals/me/credentials/${state.licenseId}`).set('Cookie', state.pro.cookie)).body.credential.status_label).toBe('Pending review');
    expect((await decide(state.licenseId, 'verified', { method: 'primary_source', sourceReference: 'Nursys lookup, 2026-10-30' })).status).toBe(200);
    expect((await decide(state.blsId, 'verified', { method: 'document_review' })).status).toBe(200);
    const list = (await api().get('/api/v1/professionals/me/credentials').set('Cookie', state.pro.cookie)).body.credentials;
    expect(list.find((c: any) => c.credential_type === 'RN').status_label).toBe('Verified with the primary source');
    expect(list.find((c: any) => c.credential_type === 'BLS').status_label).toBe('Documents reviewed (not verified with the primary source)');
    expect((await api().get('/api/v1/professionals/me').set('Cookie', state.pro.cookie)).body.completeness.complete).toBe(true);
  });
});

describe('Release 1: jobs, applications and decisions', () => {
  it('8. the facility publishes a job with explicit requirements and a shift', async () => {
    const jobs = `/api/v1/organizations/${state.orgId}/jobs`;
    state.jobId = (await api().post(jobs).set('Cookie', state.owner.cookie).send({
      title: 'ICU Staff Nurse', description: 'Critical care nursing in a 24-bed ICU with strong staffing ratios and orientation.', locationId: state.locationId,
      professionId: state.rnId, specialtyId: state.icuId, employmentType: 'per_diem', payMinCents: 5000, payMaxCents: 6500, minYearsExperience: 2,
    })).body.job.id;
    expect((await api().post(`${jobs}/${state.jobId}/status`).set('Cookie', state.owner.cookie).send({ to: 'published' })).status).toBe(422);
    await api().put(`${jobs}/${state.jobId}/requirements`).set('Cookie', state.owner.cookie).send({ requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }, { kind: 'certification', credentialType: 'BLS' }] });
    const start = new Date(Date.now() + 9 * 86_400_000); start.setUTCHours(14, 0, 0, 0);
    const end = new Date(start); end.setUTCHours(22);
    state.shiftId = (await api().post(`${jobs}/${state.jobId}/shifts`).set('Cookie', state.owner.cookie).send({ startsAt: start.toISOString(), endsAt: end.toISOString(), positions: 2 })).body.shift.id;
    expect((await api().post(`${jobs}/${state.jobId}/status`).set('Cookie', state.recruiter.cookie).send({ to: 'published' })).status).toBe(403); // recruiters cannot publish
    expect((await api().post(`${jobs}/${state.jobId}/status`).set('Cookie', state.owner.cookie).send({ to: 'published' })).status).toBe(200);
  });

  it('9-10. the professional finds the job and applies directly; the facility is notified', async () => {
    const found = await api().get('/api/v1/jobs').query({ state: 'GA', employmentType: 'per_diem', q: 'icu' }).set('Cookie', state.pro.cookie);
    expect(found.body.jobs.map((j: any) => j.id)).toContain(state.jobId);
    const applied = await api().post(`/api/v1/jobs/${state.jobId}/apply`).set('Cookie', state.pro.cookie).send({ shiftIds: [state.shiftId], coverNote: 'Happy to cover.' });
    expect(applied.status).toBe(201);
    expect(applied.body.eligibility.outcome).toBe('eligible');
    state.appId = applied.body.application.id;
    const note = (await api().get('/api/v1/notifications').set('Cookie', state.recruiter.cookie)).body.notifications.find((n: any) => n.type === 'application.submitted');
    expect(note.title).toBe('New application: ICU Staff Nurse');
  });

  it('11. the facility reviews the ranked candidate and moves the application through allowed steps', async () => {
    const org = `/api/v1/organizations/${state.orgId}`;
    const cands = (await api().get(`${org}/jobs/${state.jobId}/candidates`).set('Cookie', state.recruiter.cookie)).body.candidates;
    expect(cands[0]).toMatchObject({ applicationId: state.appId, rank: 1, eligibility: { outcome: 'eligible' } });
    const detail = (await api().get(`${org}/applications/${state.appId}`).set('Cookie', state.recruiter.cookie)).body;
    expect(JSON.stringify(detail)).not.toMatch(/RN-7654321|storage_key|nurse@example\.com/);
    const set = (to: string, reason?: string) => api().post(`${org}/applications/${state.appId}/status`).set('Cookie', state.recruiter.cookie).send({ to, reason });
    expect((await set('offer_sent')).status).toBe(409); // not from "submitted"
    for (const to of ['under_review', 'shortlisted', 'interview_requested', 'interviewed']) expect((await set(to)).status).toBe(200);
    expect((await set('offer_sent')).status).toBe(200);
  });

  it('12. both parties see status updates; the professional accepts the offer', async () => {
    const mine = (await api().get('/api/v1/notifications').set('Cookie', state.pro.cookie)).body.notifications.map((n: any) => n.type);
    expect(mine).toEqual(expect.arrayContaining(['application.under_review', 'application.shortlisted', 'application.offer_sent']));
    const acc = await api().post(`/api/v1/professionals/me/applications/${state.appId}/status`).set('Cookie', state.pro.cookie).send({ to: 'accepted' });
    expect(acc.status).toBe(200);
    const view = await api().get(`/api/v1/professionals/me/applications/${state.appId}`).set('Cookie', state.pro.cookie);
    expect(view.body.application.status).toBe('accepted');
    expect(view.body.history.map((h: any) => h.to_status)).toEqual(['submitted', 'under_review', 'shortlisted', 'interview_requested', 'interviewed', 'offer_sent', 'accepted']);
    expect((await api().get('/api/v1/notifications').set('Cookie', state.owner.cookie)).body.notifications.some((n: any) => n.type === 'application.accepted')).toBe(true);
  });
});

describe('Release 1: isolation, authorization and audit across the whole journey', () => {
  it('13. another facility and another professional cannot reach any of it', async () => {
    const rivalOwner = await signUp('owner@rival.example');
    const rivalOrg = (await api().post('/api/v1/organizations').set('Cookie', rivalOwner.cookie).send({ name: 'Rival Health', type: 'facility' })).body.organization.id;
    const rival = await signUp('rival.nurse@example.com');
    await api().post('/api/v1/professionals').set('Cookie', rival.cookie).send({ professionId: state.rnId });
    const org = `/api/v1/organizations/${state.orgId}`;
    for (const [method, path] of [
      ['get', `${org}`], ['get', `${org}/jobs/${state.jobId}`], ['get', `${org}/applications/${state.appId}`], ['get', `${org}/jobs/${state.jobId}/candidates`], ['get', `${org}/members`],
    ] as const) {
      expect((await (api() as any)[method](`/api/v1${path.replace('/api/v1', '')}`).set('Cookie', rivalOwner.cookie)).status).toBe(404);
    }
    expect((await api().get(`/api/v1/organizations/${rivalOrg}/applications/${state.appId}`).set('Cookie', rivalOwner.cookie)).status).toBe(404);
    expect((await api().post(`/api/v1/organizations/${rivalOrg}/applications/${state.appId}/status`).set('Cookie', rivalOwner.cookie).send({ to: 'rejected', reason: 'Not mine to reject' })).status).toBe(404);
    expect((await api().get(`/api/v1/professionals/me/applications/${state.appId}`).set('Cookie', rival.cookie)).status).toBe(404);
    expect((await api().get(`/api/v1/professionals/me/credentials/${state.licenseId}`).set('Cookie', rival.cookie)).status).toBe(404);
    expect((await api().post(`/api/v1/professionals/me/applications/${state.appId}/status`).set('Cookie', rival.cookie).send({ to: 'withdrawn' })).status).toBe(404);
  });

  it('14. malformed and out-of-range input is rejected consistently', async () => {
    const bad = await api().post(`/api/v1/organizations/${state.orgId}/jobs`).set('Cookie', state.owner.cookie).send({ title: 'x', employmentType: 'gig', positionsCount: 9999 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'VALIDATION_FAILED', requestId: expect.any(String) });
    expect((await api().get('/api/v1/jobs?pageSize=9999').set('Cookie', state.pro.cookie)).status).toBe(422);
  });

  it('15. the audit log tells the story of the journey, and is append-only', async () => {
    const auditor = await ctx.adminSession('auditor@bsm.example', 'auditor');
    const actions = (await api().get('/api/v1/admin/audit-logs?pageSize=200').set('Cookie', auditor.cookie)).body.auditLogs.map((l: any) => l.action);
    for (const expected of [
      'auth.register', 'auth.email_verified', 'auth.login', 'auth.mfa_enabled', 'organization.created', 'organization.status.submitted', 'organization.status.approved',
      'invitation.accepted', 'credential.status.verified', 'credential_document.uploaded', 'job.status.published', 'application.submitted',
      'application.status.offer_sent', 'application.status.accepted' ]) {
      expect(actions, expected).toContain(expected);
    }
    await expect(ctx.db.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    // Sensitive values never reach the audit trail either.
    const dump = JSON.stringify(await ctx.db.query('SELECT metadata FROM audit_logs'));
    expect(dump).not.toMatch(/RN-7654321|correct horse|Nursys lookup/);
  });
});
