import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let owner: S, recruiter: S, scheduler: S, readonly: S, ownerB: S, reviewer: S;
let p1: S, p2: S, p3: S, p4: S;
let orgA: string, orgB: string, jobId: string, jobB: string, locA: string, rnId: string, ptId: string, icuId: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n');
const base = '/api/v1/professionals/me';
const allDays = Array.from({ length: 7 }, (_, d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '23:59' }));
const talent = (s: S = recruiter, org = orgA, q = '') => api().get(`/api/v1/organizations/${org}/talent${q}`).set('Cookie', s.cookie);
const invite = (body: object, s: S = recruiter, org = orgA) => api().post(`/api/v1/organizations/${org}/talent/invitations`).set('Cookie', s.cookie).send(body);
const decide = (id: string, to: string, extra: object = {}) => api().post(`/api/v1/admin/credentials/${id}/status`).set('Cookie', reviewer.cookie).send({ to, ...extra });
const setDiscoverable = (s: S, discoverable: boolean) => api().put(`${base}/discoverability`).set('Cookie', s.cookie).send({ discoverable });

async function credential(p: S, body: object, verify: boolean) {
  const c = (await api().post(`${base}/credentials`).set('Cookie', p.cookie).send(body)).body.credential;
  await api().post(`${base}/credentials/${c.id}/documents`).set('Cookie', p.cookie).set('Content-Type', 'application/pdf').send(PDF);
  await api().post(`${base}/credentials/${c.id}/submit`).set('Cookie', p.cookie);
  if (verify) { await decide(c.id, 'pending_review'); await decide(c.id, 'verified', { method: 'primary_source', sourceReference: 'Nursys lookup 2026-10-30' }); }
}
const LICENSE = { kind: 'license', credentialType: 'RN', jurisdiction: 'GA', number: 'RN-SECRET-5551234', issueDate: '2022-01-01', expirationDate: '2099-01-01' };

async function makePro(email: string, o: { professionId?: string; verified?: boolean; state?: string; start?: string; employment?: string[] } = {}) {
  const s = await ctx.userWithSession(email);
  await api().post('/api/v1/professionals').set('Cookie', s.cookie).send({ professionId: o.professionId ?? rnId, headline: 'Jane Doe, travel RN', summary: 'Call me at 404-555-0199', phone: '404-555-0199', city: 'Atlanta', state: o.state ?? 'GA' });
  if (!o.professionId) await api().put(`${base}/specialties`).set('Cookie', s.cookie).send({ specialtyIds: [icuId] });
  await api().post(`${base}/experience`).set('Cookie', s.cookie).send({ employer: 'Secret Hospital System', title: 'Staff RN', specialtyId: o.professionId ? undefined : icuId, startDate: o.start ?? '2015-01-01', isCurrent: true });
  await api().post(`${base}/education`).set('Cookie', s.cookie).send({ institution: 'Secret University', degree: 'BSN' });
  await api().put(`${base}/preferences`).set('Cookie', s.cookie).send({ employmentTypes: o.employment ?? ['per_diem'], shiftTypes: ['day'], preferredStates: ['GA'], minHourlyRateCents: 4800 });
  await api().put(`${base}/availability`).set('Cookie', s.cookie).send({ windows: allDays });
  if (!o.professionId) { await credential(s, LICENSE, o.verified ?? true); await credential(s, { kind: 'certification', credentialType: 'BLS', expirationDate: '2099-01-01' }, o.verified ?? true); }
  return s;
}

beforeAll(async () => {
  ctx = await makeTestApp({ globalLimit: { max: 100_000, windowMs: 60_000 } }); // this suite sends many requests from one IP
  owner = await ctx.userWithSession('owner@alpha.example');
  recruiter = await ctx.userWithSession('recruiter@alpha.example');
  scheduler = await ctx.userWithSession('scheduler@alpha.example');
  readonly = await ctx.userWithSession('readonly@alpha.example');
  ownerB = await ctx.userWithSession('owner@beta.example');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  orgA = (await api().post('/api/v1/organizations').set('Cookie', owner.cookie).send({ name: 'Alpha Health', type: 'facility' })).body.organization.id;
  orgB = (await api().post('/api/v1/organizations').set('Cookie', ownerB.cookie).send({ name: 'Beta Health', type: 'facility' })).body.organization.id;
  await ctx.db.query(`UPDATE organizations SET status = 'approved'`);
  await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'recruiter'), ($1,$3,'scheduler'), ($1,$4,'read_only')`, [orgA, recruiter.id, scheduler.id, readonly.id]);

  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', owner.cookie)).body.professions as any[];
  const rn = tax.find((p) => p.code === 'rn');
  rnId = rn.id; ptId = tax.find((p) => p.code === 'pt').id; icuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;

  const mkOrgJob = async (org: string, who: S, title: string) => {
    const f = await api().post(`/api/v1/organizations/${org}/facilities`).set('Cookie', who.cookie).send({ name: `${title} Hospital`, facilityType: 'hospital' });
    const l = (await api().post(`/api/v1/organizations/${org}/facilities/${f.body.facility.id}/locations`).set('Cookie', who.cookie)
      .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' })).body.location.id as string;
    const id = (await api().post(`/api/v1/organizations/${org}/jobs`).set('Cookie', who.cookie).send({
      title, description: 'Critical care nursing with strong staffing ratios and orientation support.', locationId: l, professionId: rnId, specialtyId: icuId,
      employmentType: 'permanent', payUnit: 'year', minYearsExperience: 2 })).body.job.id as string;
    await api().put(`/api/v1/organizations/${org}/jobs/${id}/requirements`).set('Cookie', who.cookie).send({ requirements: [{ kind: 'license', credentialType: 'RN', jurisdiction: 'GA' }] });
    expect((await api().post(`/api/v1/organizations/${org}/jobs/${id}/status`).set('Cookie', who.cookie).send({ to: 'published' })).status).toBe(200);
    return { id, l };
  };
  const a = await mkOrgJob(orgA, owner, 'ICU Nurse'); jobId = a.id; locA = a.l;
  jobB = (await mkOrgJob(orgB, ownerB, 'Beta ICU Nurse')).id;

  p1 = await makePro('p1.private@example.com');                            // verified RN-GA, experienced
  p2 = await makePro('p2.private@example.com', { verified: false, start: '2021-01-01' });   // credentials only submitted
  p3 = await makePro('p3.private@example.com', { professionId: ptId, state: 'FL' }); // physical therapist, no credentials
  p4 = await makePro('p4.private@example.com', { employment: ['permanent'] });          // never opts in
});

describe('opt-in discoverability', () => {
  it('is off by default and nobody appears until they opt in', async () => {
    expect((await api().get(`${base}/discoverability`).set('Cookie', p1.cookie)).body.discoverable).toBe(false);
    expect((await api().get(base).set('Cookie', p1.cookie)).body.professional.discoverable).toBe(false);
    expect((await talent()).body.total).toBe(0);
  });

  it('lets a professional turn it on and off at any time, and audits the change', async () => {
    expect((await api().put(`${base}/discoverability`).set('Cookie', p1.cookie).send({ discoverable: 'yes' })).status).toBe(422);
    expect((await setDiscoverable(p1, true)).body.discoverable).toBe(true);
    expect((await talent()).body.total).toBe(1);
    expect((await setDiscoverable(p1, false)).status).toBe(200);
    expect((await talent()).body.total).toBe(0);
    await setDiscoverable(p1, true);
    for (const p of [p2, p3]) await setDiscoverable(p, true);
    expect((await talent()).body.total).toBe(3);
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'professional.discoverability_changed' AND metadata->>'discoverable' = 'true'`);
    expect(log).toBeTruthy();
  });

  it('never shows suspended or restricted accounts', async () => {
    await ctx.db.query(`UPDATE professionals SET account_status = 'restricted' WHERE user_id = $1`, [p3.id]);
    expect((await talent()).body.total).toBe(2);
    await ctx.db.query(`UPDATE professionals SET account_status = 'active' WHERE user_id = $1`, [p3.id]);
    expect((await talent()).body.total).toBe(3);
  });
});

describe('access control', () => {
  it('requires sign-in, an approved organization and a role that may search', async () => {
    expect((await api().get(`/api/v1/organizations/${orgA}/talent`)).status).toBe(401);
    for (const s of [scheduler, readonly]) expect((await talent(s)).status).toBe(403);
    expect((await talent(owner)).status).toBe(200);
    expect((await talent(ownerB, orgA)).status).toBe(404); // another tenant
    await ctx.db.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [orgB]);
    expect((await talent(ownerB, orgB)).status).toBe(403);
    await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [orgB]);
  });
});

describe('anonymized cards', () => {
  it('contain professional facts and credential status only: no identity, contact details, free text or numbers', async () => {
    const res = await talent(recruiter, orgA, '?professionId=' + rnId);
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    for (const leak of ['Jane Doe', 'Test User', 'private@example.com', '404-555-0199', 'Secret Hospital', 'Secret University', 'RN-SECRET', '5551234', 'Call me', 'minHourly', '4800', p1.id]) {
      expect(json, leak).not.toContain(leak);
    }
    const card = res.body.talent.find((c: any) => c.yearsExperience >= 9);
    expect(card).toMatchObject({ profession: 'Registered Nurse', specialties: ['Critical Care / ICU'], city: 'Atlanta', state: 'GA' });
    expect(card.talentRef).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(card.credentials.find((c: any) => c.credentialType === 'RN')).toMatchObject({ jurisdiction: 'GA', status: 'verified', statusLabel: 'Verified with the primary source' });
    expect(card.availability.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Object.keys(card).sort()).toEqual(['availability', 'city', 'credentials', 'match', 'profession', 'specialties', 'state', 'talentRef', 'yearsExperience']);
  });

  it('uses a different reference per organization and for each person', async () => {
    const a1 = (await talent()).body.talent.map((c: any) => c.talentRef);
    const a2 = (await talent()).body.talent.map((c: any) => c.talentRef);
    expect(a2.sort()).toEqual(a1.sort());           // stable within one organization
    expect(new Set(a1).size).toBe(a1.length);
    const b = (await talent(ownerB, orgB)).body.talent.map((c: any) => c.talentRef);
    expect(b.filter((r: string) => a1.includes(r))).toEqual([]); // cannot correlate people across organizations
  });
});

describe('filters, pagination and abuse limits', () => {
  it('filters by profession, specialty, state, work arrangement, license and verification', async () => {
    expect((await talent(recruiter, orgA, `?professionId=${ptId}`)).body.total).toBe(1);
    expect((await talent(recruiter, orgA, `?specialtyId=${icuId}`)).body.total).toBe(2);
    expect((await talent(recruiter, orgA, '?state=fl')).body.total).toBe(1);
    expect((await talent(recruiter, orgA, '?employmentType=per_diem')).body.total).toBe(3);
    expect((await talent(recruiter, orgA, '?employmentType=permanent')).body.total).toBe(0); // p4 never opted in
    expect((await talent(recruiter, orgA, '?licenseType=rn&licenseState=GA')).body.total).toBe(2);   // submitted counts
    expect((await talent(recruiter, orgA, '?licenseType=rn&licenseState=GA&verifiedOnly=true')).body.total).toBe(1);
    expect((await talent(recruiter, orgA, '?verifiedOnly=true')).body.total).toBe(1);
    expect((await talent(recruiter, orgA, '?licenseType=rn&licenseState=TX')).body.total).toBe(0);
    expect((await talent(recruiter, orgA, '?minYears=8')).body.total).toBe(2);                     // the RN with 11 years and the PT with 11 years
    expect((await talent(recruiter, orgA, `?minYears=8&professionId=${rnId}`)).body.total).toBe(1); // the other RN has about 5
  });

  it('rejects bad input and caps how deep or wide a search can go', async () => {
    for (const q of ['?pageSize=26', '?page=0', '?state=Georgia', '?professionId=nope', '?sort=name', '?minYears=-1', '?page=100']) {
      expect((await talent(recruiter, orgA, q)).status, q).toBe(422);
    }
    expect((await talent(recruiter, orgA, '?pageSize=1&page=2')).body.talent).toHaveLength(1);
  });

  it('records every search in the audit log without the results', async () => {
    const [row] = await ctx.db.query<{ metadata: { filters: string[]; results: number } }>(`SELECT metadata FROM audit_logs WHERE action = 'talent.search' ORDER BY created_at DESC LIMIT 1`);
    expect(row!.metadata).toHaveProperty('results');
    expect(JSON.stringify(row!.metadata)).not.toMatch(/Atlanta|talentRef/);
  });

  it('rate limits search per user', async () => {
    const heavy = await ctx.userWithSession('heavy@alpha.example');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'hiring_manager')`, [orgA, heavy.id]);
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await talent(heavy, orgA, '?pageSize=1')).status;
    expect(last).toBe(429);
  });
});

describe('matching a job to the talent pool', () => {
  it('ranks eligible people first with explanations and keeps everyone else visible with reasons', async () => {
    const res = await talent(recruiter, orgA, `?professionId=${rnId}&jobId=${jobId}`);
    const m = res.body.talent.map((c: any) => c.match);
    expect(m[0]).toMatchObject({ outcome: 'eligible' });
    expect(m[0].score).toBeGreaterThan(0);
    expect(m[1].outcome).toBe('pending_verification');
    expect(m[1].score).toBeNull();
    expect(m[1].reasons[0].code).toBe('credential_pending');
    const wrongProfession = (await talent(recruiter, orgA, `?professionId=${ptId}&jobId=${jobId}`)).body.talent[0].match;
    expect(wrongProfession.outcome).toBe('ineligible');
    expect((await talent(recruiter, orgA, `?jobId=${jobB}`)).status).toBe(404); // another organization's job
  });
});

describe('invitations to apply', () => {
  let ref1: string, inviteId: string;

  it('lets a facility invite a discoverable professional to one of its open jobs, notifying only them', async () => {
    ref1 = (await talent(recruiter, orgA, `?professionId=${rnId}&jobId=${jobId}`)).body.talent[0].talentRef;
    expect((await invite({ talentRef: ref1, jobId }, scheduler)).status).toBe(403);
    expect((await invite({ talentRef: 'unknown-reference-value', jobId })).status).toBe(404);
    expect((await invite({ talentRef: ref1, jobId }, ownerB, orgB)).status).toBe(404);        // a reference only works in its own organization
    expect((await invite({ talentRef: ref1, jobId: jobB })).status).toBe(422);                   // not this organization's job
    const res = await invite({ talentRef: ref1, jobId, message: 'We think your ICU experience is a great fit.' });
    expect(res.status).toBe(201);
    inviteId = res.body.invitation.id;
    expect((await invite({ talentRef: ref1, jobId })).status).toBe(409); // a pending invitation already exists
  });

  it('shows the professional the invitation, with the facility and job, never the sender\'s identity', async () => {
    const note = (await api().get('/api/v1/notifications').set('Cookie', p1.cookie)).body.notifications.find((n: any) => n.type === 'talent.invited');
    expect(note.title).toBe('Alpha Health invited you to apply: ICU Nurse');
    expect((await api().get('/api/v1/notifications').set('Cookie', p2.cookie)).body.notifications.some((n: any) => n.type === 'talent.invited')).toBe(false);
    const list = (await api().get(`${base}/invitations`).set('Cookie', p1.cookie)).body.invitations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: inviteId, status: 'pending', organization_name: 'Alpha Health', job_title: 'ICU Nurse', job_open: true, message: 'We think your ICU experience is a great fit.' });
    expect(JSON.stringify(list)).not.toMatch(/recruiter@alpha|invited_by/);
    expect((await api().get(`${base}/invitations`).set('Cookie', p2.cookie)).body.invitations).toHaveLength(0);
  });

  it('keeps the person anonymous to the facility until they apply, then links the application', async () => {
    const before = (await api().get(`/api/v1/organizations/${orgA}/talent/invitations`).set('Cookie', recruiter.cookie)).body.invitations;
    expect(before[0]).toMatchObject({ status: 'pending', talent_ref: ref1, profession: 'Registered Nurse', application_id: null });
    expect(JSON.stringify(before)).not.toMatch(/p1\.private|Test User/);

    const applied = await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', p1.cookie).send({});
    expect(applied.status).toBe(201);
    const after = (await api().get(`/api/v1/organizations/${orgA}/talent/invitations`).set('Cookie', recruiter.cookie)).body.invitations;
    expect(after[0]).toMatchObject({ status: 'applied', application_id: applied.body.application.id });
    const detail = await api().get(`/api/v1/organizations/${orgA}/applications/${applied.body.application.id}`).set('Cookie', recruiter.cookie);
    expect(detail.status).toBe(200); // identity is revealed through the application flow, as for any applicant
    expect((await invite({ talentRef: ref1, jobId })).status).toBe(409); // already applied
  });

  it('supports declining and withdrawing, and re-inviting afterwards', async () => {
    const ref2 = (await talent(recruiter, orgA, `?professionId=${rnId}&jobId=${jobId}`)).body.talent.find((c: any) => c.match.outcome === 'pending_verification').talentRef;
    const first = await invite({ talentRef: ref2, jobId });
    expect(first.status).toBe(201);
    const mine = (await api().get(`${base}/invitations`).set('Cookie', p2.cookie)).body.invitations[0];
    expect((await api().post(`${base}/invitations/${mine.id}/decline`).set('Cookie', p1.cookie)).status).toBe(404); // not theirs
    expect((await api().post(`${base}/invitations/${mine.id}/decline`).set('Cookie', p2.cookie)).status).toBe(204);
    expect((await api().post(`${base}/invitations/${mine.id}/decline`).set('Cookie', p2.cookie)).status).toBe(404); // already answered
    const second = await invite({ talentRef: ref2, jobId });
    expect(second.status).toBe(201);
    expect((await api().delete(`/api/v1/organizations/${orgA}/talent/invitations/${second.body.invitation.id}`).set('Cookie', scheduler.cookie)).status).toBe(403);
    expect((await api().delete(`/api/v1/organizations/${orgA}/talent/invitations/${second.body.invitation.id}`).set('Cookie', ownerB.cookie)).status).toBe(404);
    expect((await api().delete(`/api/v1/organizations/${orgA}/talent/invitations/${second.body.invitation.id}`).set('Cookie', recruiter.cookie)).status).toBe(204);
    expect((await api().get(`${base}/invitations`).set('Cookie', p2.cookie)).body.invitations.map((i: any) => i.status)).toEqual(['withdrawn', 'declined']);
  });

  it('stops new invitations when a professional opts out, and when a job is no longer open', async () => {
    const ref2 = (await talent(recruiter, orgA, `?professionId=${rnId}&jobId=${jobId}`)).body.talent.find((c: any) => c.match.outcome === 'pending_verification').talentRef;
    await setDiscoverable(p2, false);
    expect((await talent(recruiter, orgA, `?professionId=${rnId}`)).body.total).toBe(1);
    expect((await invite({ talentRef: ref2, jobId })).status).toBe(409);
    await setDiscoverable(p2, true);
    await api().post(`/api/v1/organizations/${orgA}/jobs/${jobId}/status`).set('Cookie', owner.cookie).send({ to: 'paused' });
    expect((await invite({ talentRef: ref2, jobId })).status).toBe(422);
    await api().post(`/api/v1/organizations/${orgA}/jobs/${jobId}/status`).set('Cookie', owner.cookie).send({ to: 'published' });
  });

  it('limits how many invitations an organization can send per day, and audits them', async () => {
    const ref3 = (await talent(recruiter, orgA, `?professionId=${ptId}`)).body.talent[0].talentRef;
    const [p3row] = await ctx.db.query<{ id: string }>('SELECT id FROM professionals WHERE user_id = $1', [p3.id]);
    for (let i = 0; i < 30; i++) {
      await ctx.db.query(`INSERT INTO talent_invitations (organization_id, job_id, professional_id, invited_by, status, expires_at) VALUES ($1,$2,$3,$4,'declined', now() + interval '1 day')`, [orgA, jobId, p3row!.id, recruiter.id]);
    }
    expect((await invite({ talentRef: ref3, jobId })).status).toBe(429);
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'talent.invited' AND organization_id = $1`, [orgA]);
    expect(log).toBeTruthy();
  });
});
