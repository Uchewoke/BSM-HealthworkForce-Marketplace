import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { signDownloadToken } from '../src/modules/credentials/documents.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let pro: S, pro2: S, facility: S, reviewer: S, rnId: string, ccuId: string, otherProfessionSpecialty: string;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const base = '/api/v1/professionals/me';

const upload = (s: S, credId: string, body: Buffer = PDF, type = 'application/pdf', name = 'My License.pdf') =>
  api().post(`${base}/credentials/${credId}/documents`).set('Cookie', s.cookie).set('Content-Type', type).set('X-File-Name', encodeURIComponent(name)).send(body);
const newLicense = async (s: S, extra: object = {}) =>
  (await api().post(`${base}/credentials`).set('Cookie', s.cookie).send({
    kind: 'license', credentialType: 'RN', jurisdiction: 'ga', issuingAuthority: 'Georgia Board of Nursing', number: 'RN-1234567',
    issueDate: '2023-01-15', expirationDate: '2099-01-31', ...extra,
  })).body.credential as { id: string; [k: string]: any };
const admin = (method: 'get' | 'post', path: string, s: S = reviewer) => api()[method](`/api/v1/admin${path}`).set('Cookie', s.cookie);
const decide = (id: string, to: string, extra: object = {}, s: S = reviewer) => admin('post', `/credentials/${id}/status`, s).send({ to, ...extra });
const credFor = async (s: S, id: string) => (await api().get(`${base}/credentials/${id}`).set('Cookie', s.cookie)).body;

beforeAll(async () => {
  ctx = await makeTestApp();
  pro = await ctx.userWithSession('nurse@example.com');
  pro2 = await ctx.userWithSession('other.nurse@example.com');
  facility = await ctx.userWithSession('facility@example.com');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  await api().post('/api/v1/organizations').set('Cookie', facility.cookie).send({ name: 'Facility One', type: 'facility' });
  const tax = (await api().get('/api/v1/taxonomies/professions').set('Cookie', pro.cookie)).body.professions as any[];
  const rn = tax.find((p) => p.code === 'rn');
  rnId = rn.id;
  ccuId = rn.specialties.find((s: any) => s.name.startsWith('Critical')).id;
  otherProfessionSpecialty = tax.find((p) => p.code === 'pt').specialties[0].id;
});

describe('professional profile', () => {
  it('requires sign-in for taxonomy and has no profile until created', async () => {
    expect((await api().get('/api/v1/taxonomies/professions')).status).toBe(401);
    expect((await api().get(`${base}`).set('Cookie', pro.cookie)).status).toBe(404);
  });

  it('registers independently (no agency) and prevents duplicates and unknown professions', async () => {
    const bad = await api().post('/api/v1/professionals').set('Cookie', pro.cookie).send({ professionId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(422);
    const ok = await api().post('/api/v1/professionals').set('Cookie', pro.cookie).send({ professionId: rnId, headline: 'ICU RN', state: 'ga', phone: '404-555-0111' });
    expect(ok.status).toBe(201);
    expect((await api().post('/api/v1/professionals').set('Cookie', pro.cookie).send({ professionId: rnId })).status).toBe(409);
    await api().post('/api/v1/professionals').set('Cookie', pro2.cookie).send({ professionId: rnId });
  });

  it('starts incomplete and validates edits', async () => {
    const me = await api().get(base).set('Cookie', pro.cookie);
    expect(me.body.completeness).toMatchObject({ complete: false, percent: 0 });
    expect(me.body.professional.state).toBe('GA');
    const patch = (b: object) => api().patch(base).set('Cookie', pro.cookie).send(b);
    expect((await patch({ state: 'Georgia' })).status).toBe(422);
    expect((await patch({ phone: 'abc' })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ summary: 'Eight years of ICU experience.' })).status).toBe(200);
  });

  it('accepts only specialties from the professional\'s own profession', async () => {
    expect((await api().put(`${base}/specialties`).set('Cookie', pro.cookie).send({ specialtyIds: [otherProfessionSpecialty] })).status).toBe(422);
    expect((await api().put(`${base}/specialties`).set('Cookie', pro.cookie).send({ specialtyIds: [ccuId, ccuId] })).status).toBe(200);
    expect((await api().get(base).set('Cookie', pro.cookie)).body.specialties).toHaveLength(1);
  });

  it('manages education and experience, rejecting bad dates and other users\' records', async () => {
    const edu = await api().post(`${base}/education`).set('Cookie', pro.cookie).send({ institution: 'Georgia State University', degree: 'BSN', startYear: 2012, endYear: 2016 });
    expect(edu.status).toBe(201);
    expect((await api().post(`${base}/education`).set('Cookie', pro.cookie).send({ institution: 'X University', degree: 'BSN', startYear: 2016, endYear: 2012 })).status).toBe(422);
    const exp = await api().post(`${base}/experience`).set('Cookie', pro.cookie)
      .send({ employer: 'Grady Memorial', title: 'Staff RN', specialtyId: ccuId, startDate: '2016-06-01', isCurrent: true });
    expect(exp.status).toBe(201);
    expect((await api().post(`${base}/experience`).set('Cookie', pro.cookie).send({ employer: 'A', title: 'B', startDate: '2020-01-01', endDate: '2019-01-01' })).status).toBe(422);
    expect((await api().post(`${base}/experience`).set('Cookie', pro.cookie).send({ employer: 'A Hosp', title: 'RN', startDate: '2020-01-01', endDate: '2021-01-01', isCurrent: true })).status).toBe(422);

    const id = edu.body.item.id;
    expect((await api().put(`${base}/education/${id}`).set('Cookie', pro2.cookie).send({ institution: 'Hacked', degree: 'BSN' })).status).toBe(404);
    expect((await api().delete(`${base}/education/${id}`).set('Cookie', pro2.cookie)).status).toBe(404);
    const upd = await api().put(`${base}/education/${id}`).set('Cookie', pro.cookie).send({ institution: 'Georgia State University', degree: 'BSN', fieldOfStudy: 'Nursing', startYear: 2012, endYear: 2016 });
    expect(upd.body.item.field_of_study).toBe('Nursing');
    expect((await api().get(`${base}/education`).set('Cookie', pro.cookie)).body.education).toHaveLength(1);
  });

  it('stores preferences and availability with validation', async () => {
    const put = (b: object) => api().put(`${base}/preferences`).set('Cookie', pro.cookie).send(b);
    expect((await put({ employmentTypes: ['gig'], shiftTypes: [], preferredStates: [] })).status).toBe(422);
    expect((await put({ employmentTypes: ['per_diem'], shiftTypes: ['night'], preferredStates: ['ga'], minHourlyRateCents: 99_999_999 })).status).toBe(422);
    const ok = await put({ employmentTypes: ['per_diem', 'contract'], shiftTypes: ['night'], preferredStates: ['ga', 'fl'], maxTravelMiles: 50, minHourlyRateCents: 4500 });
    expect(ok.status).toBe(200);
    expect(ok.body.preferences.preferred_states).toEqual(['GA', 'FL']);

    const win = (b: object) => api().put(`${base}/availability`).set('Cookie', pro.cookie).send(b);
    expect((await win({ windows: [{ dayOfWeek: 7, startTime: '07:00', endTime: '19:00' }] })).status).toBe(422);
    expect((await win({ windows: [{ dayOfWeek: 1, startTime: '7am', endTime: '19:00' }] })).status).toBe(422);
    expect((await win({ windows: [{ dayOfWeek: 1, startTime: '07:00', endTime: '07:00' }] })).status).toBe(422);
    expect((await win({ windows: [{ dayOfWeek: 1, startTime: '19:00', endTime: '07:00' }, { dayOfWeek: 2, startTime: '19:00', endTime: '07:00' }] })).status).toBe(200); // overnight
    expect((await api().get(`${base}/availability`).set('Cookie', pro.cookie)).body.windows).toHaveLength(2);
  });

  it('profile completeness is separate from credential verification', async () => {
    await newLicense(pro, { credentialType: 'RN (draft)' });
    const me = (await api().get(base).set('Cookie', pro.cookie)).body;
    expect(me.completeness).toMatchObject({ complete: true, percent: 100, missing: [] });
    expect(me.credentialSummary).toEqual({ not_submitted: 1 }); // complete profile, zero verified credentials
  });
});

describe('credential records', () => {
  it('validates input and never returns or stores the number in clear', async () => {
    const post = (b: object) => api().post(`${base}/credentials`).set('Cookie', pro.cookie).send(b);
    expect((await post({ kind: 'license', credentialType: 'RN' })).status).toBe(422); // license needs jurisdiction
    expect((await post({ kind: 'certification', credentialType: 'BLS', issueDate: '2024-02-01', expirationDate: '2023-02-01' })).status).toBe(422);
    expect((await post({ kind: 'certification', credentialType: 'BLS', number: '<script>' })).status).toBe(422);
    const lic = await newLicense(pro);
    expect(lic).toMatchObject({ number_last4: '4567', status: 'not_submitted', effective_status: 'not_submitted', jurisdiction: 'GA' });
    expect(JSON.stringify(lic)).not.toMatch(/RN-1234567|number_enc/);
    const [row] = await ctx.db.query<{ number_enc: string }>('SELECT number_enc FROM credentials WHERE id = $1', [lic.id]);
    expect(row!.number_enc).not.toContain('1234567');
  });

  it('cannot be submitted without a document', async () => {
    const lic = await newLicense(pro, { credentialType: 'RN (no doc)' });
    expect((await api().post(`${base}/credentials/${lic.id}/submit`).set('Cookie', pro.cookie)).status).toBe(409);
  });

  it('shows expired credentials as expired and refuses to submit them', async () => {
    const lic = await newLicense(pro, { credentialType: 'RN (old)', issueDate: '2019-01-01', expirationDate: '2020-01-01' });
    expect(lic.effective_status).toBe('expired');
    expect(lic.status_label).toBe('Expired');
    await upload(pro, lic.id);
    expect((await api().post(`${base}/credentials/${lic.id}/submit`).set('Cookie', pro.cookie)).status).toBe(409);
  });
});

describe('private document upload and access', () => {
  let credId: string, docId: string, url: string, baseline: number;

  it('rejects wrong types, mislabeled content, oversized and malware-flagged files', async () => {
    credId = (await newLicense(pro, { credentialType: 'RN (upload)' })).id;
    baseline = ctx.storage.files.size;
    expect((await upload(pro, credId, Buffer.from('hello'), 'text/plain')).status).toBe(415);
    expect((await upload(pro, credId, PNG, 'application/pdf')).status).toBe(415); // PNG bytes labeled as PDF
    expect((await upload(pro, credId, Buffer.from('%PDF-1.4 EICAR-TEST'), 'application/pdf')).status).toBe(422);
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(11 * 1024 * 1024)]);
    expect((await upload(pro, credId, big)).status).toBe(413);
    expect(ctx.storage.files.size).toBe(baseline); // nothing was stored by the rejected uploads
  });

  it('stores an accepted file privately, honestly marked as not scanned', async () => {
    const res = await upload(pro, credId, PDF, 'application/pdf', '../../etc/passwd<>.pdf');
    expect(res.status).toBe(201);
    docId = res.body.document.id;
    expect(res.body.document).toMatchObject({ content_type: 'application/pdf', scan_status: 'not_scanned' });
    expect(res.body.document.original_name).not.toMatch(/[\\/<>]/);
    const [row] = await ctx.db.query<{ storage_key: string }>('SELECT storage_key FROM credential_documents WHERE id = $1', [docId]);
    expect(ctx.storage.files.get(row!.storage_key)!.equals(PDF)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(row!.storage_key);
  });

  it('enforces the per-credential document limit', async () => {
    for (let i = 0; i < 4; i++) expect((await upload(pro, credId)).status).toBe(201);
    expect((await upload(pro, credId)).status).toBe(409);
    const list = await api().get(`${base}/credentials/${credId}/documents`).set('Cookie', pro.cookie);
    for (const d of list.body.documents.slice(1)) await api().delete(`${base}/credentials/${credId}/documents/${d.id}`).set('Cookie', pro.cookie);
    expect((await api().get(`${base}/credentials/${credId}/documents`).set('Cookie', pro.cookie)).body.documents).toHaveLength(1);
    expect(ctx.storage.files.size).toBe(baseline + 1);
  });

  it('gives the owner a short-lived link that downloads with safe headers, and audits it', async () => {
    const acc = await api().post(`${base}/credentials/${credId}/documents/${docId}/access`).set('Cookie', pro.cookie);
    expect(acc.status).toBe(200);
    url = acc.body.url;
    const dl = await api().get(url).set('Cookie', pro.cookie);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['cache-control']).toMatch(/no-store/);
    const logs = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE action LIKE 'credential_document.%'`);
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['credential_document.uploaded', 'credential_document.access_link_created', 'credential_document.downloaded']));
  });

  it('rejects expired, tampered, unauthenticated and borrowed links', async () => {
    const expired = signDownloadToken(ctx.deps.config, { documentId: docId, userId: pro.id }, Date.now() - 120_000).token;
    expect((await api().get(`/api/v1/credential-documents/download?token=${expired}`).set('Cookie', pro.cookie)).status).toBe(403);
    expect((await api().get(`${url}x`).set('Cookie', pro.cookie)).status).toBe(403);
    expect((await api().get(url)).status).toBe(401);
    expect((await api().get(url).set('Cookie', pro2.cookie)).status).toBe(403); // another user presenting the owner's link
    expect((await api().get(url).set('Cookie', facility.cookie)).status).toBe(403);
  });

  it('never exposes the document or credential to other professionals or facility users', async () => {
    for (const other of [pro2, facility]) {
      expect((await api().get(`${base}/credentials/${credId}`).set('Cookie', other.cookie)).status).toBe(404);
      expect((await api().post(`${base}/credentials/${credId}/documents/${docId}/access`).set('Cookie', other.cookie)).status).toBe(404);
    }
    expect((await upload(pro2, credId)).status).toBe(404);
    expect((await api().post(`/api/v1/admin/credential-documents/${docId}/access`).set('Cookie', facility.cookie)).status).toBe(403);
    // A facility user who obtains a token bound to themselves still cannot read the document.
    const forged = signDownloadToken(ctx.deps.config, { documentId: docId, userId: facility.id }, Date.now()).token;
    expect((await api().get(`/api/v1/credential-documents/download?token=${forged}`).set('Cookie', facility.cookie)).status).toBe(404);
  });
});

describe('credential review', () => {
  let a: string, b: string;

  it('restricts review endpoints to credential reviewers with MFA', async () => {
    expect((await admin('get', '/credentials', facility)).status).toBe(403);
    const noMfa = await ctx.userWithSession('nomfa.reviewer@bsm.example', 'verification_reviewer');
    expect((await admin('get', '/credentials', noMfa)).body.error.details).toMatchObject({ mfaRequired: true });
    const support = await ctx.adminSession('support@bsm.example', 'support_agent');
    expect((await admin('get', '/credentials', support)).status).toBe(403);
    expect((await admin('get', '/credentials?pageSize=999')).status).toBe(422);
  });

  it('submission shows as submitted, never verified, and locks the record', async () => {
    a = (await newLicense(pro, { credentialType: 'RN (review A)' })).id;
    await upload(pro, a);
    expect((await api().post(`${base}/credentials/${a}/submit`).set('Cookie', pro.cookie)).status).toBe(200);
    const view = (await credFor(pro, a)).credential;
    expect(view).toMatchObject({ status: 'submitted', effective_status: 'submitted', status_label: 'Submitted, awaiting review', verified_at: null });
    expect((await api().patch(`${base}/credentials/${a}`).set('Cookie', pro.cookie).send({ credentialType: 'Changed' })).status).toBe(409);
    expect((await upload(pro, a)).status).toBe(409);
    expect((await api().delete(`${base}/credentials/${a}`).set('Cookie', pro.cookie)).status).toBe(409);
    expect((await api().post(`${base}/credentials/${a}/submit`).set('Cookie', pro.cookie)).status).toBe(409);
  });

  it('professionals cannot change review states', async () => {
    expect((await api().post(`/api/v1/admin/credentials/${a}/status`).set('Cookie', pro.cookie).send({ to: 'verified', method: 'document_review' })).status).toBe(403);
  });

  it('lists the queue and opens detail with the number, auditing the view', async () => {
    const q = await admin('get', '/credentials?status=submitted');
    expect(q.body.credentials.map((c: any) => c.id)).toContain(a);
    const d = await admin('get', `/credentials/${a}`);
    expect(d.body.credential).toMatchObject({ number: 'RN-1234567', professional_name: 'Test User', profession: 'Registered Nurse' });
    expect(d.body.documents).toHaveLength(1);
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.credential_viewed' AND target_id = $1`, [a]);
    expect(log).toBeTruthy();
  });

  it('reviewer reads the document through an audited link', async () => {
    const docs = (await admin('get', `/credentials/${a}`)).body.documents;
    const acc = await admin('post', `/credential-documents/${docs[0].id}/access`);
    expect(acc.status).toBe(200);
    expect((await api().get(acc.body.url).set('Cookie', reviewer.cookie)).status).toBe(200);
    const [row] = await ctx.db.query<{ metadata: { asReviewer: boolean } }>(`SELECT metadata FROM audit_logs WHERE action = 'credential_document.downloaded' ORDER BY created_at DESC LIMIT 1`);
    expect(row!.metadata.asReviewer).toBe(true);
  });

  it('enforces the review state machine and required inputs', async () => {
    expect((await decide(a, 'verified', { method: 'document_review' })).status).toBe(409); // must be picked up first
    expect((await decide(a, 'pending_review')).status).toBe(200);
    const pending = (await credFor(pro, a)).credential;
    expect(pending).toMatchObject({ effective_status: 'pending_review', status_label: 'Pending review', verified_at: null });
    expect((await decide(a, 'verified')).status).toBe(422); // method required
    expect((await decide(a, 'verified', { method: 'primary_source' })).status).toBe(422); // reference required
    expect((await decide(a, 'rejected')).status).toBe(422); // reason required
    const info = await decide(a, 'needs_more_information', { reason: 'The scan is cut off. Please re-upload the full page.', internalNote: 'Edge cropped' });
    expect(info.status).toBe(200);
  });

  it('shows the professional the reason (not internal notes) and lets them fix and resubmit', async () => {
    const view = await credFor(pro, a);
    expect(view.credential).toMatchObject({ effective_status: 'needs_more_information', latest_review_reason: 'The scan is cut off. Please re-upload the full page.' });
    expect(JSON.stringify(view)).not.toMatch(/Edge cropped|internal_note|reviewer@bsm/);
    expect((await upload(pro, a)).status).toBe(201);
    expect((await api().post(`${base}/credentials/${a}/submit`).set('Cookie', pro.cookie)).status).toBe(200);
    expect((await decide(a, 'pending_review')).status).toBe(200);
  });

  it('labels a document review honestly and a primary-source check only when a source is recorded', async () => {
    const ok = await decide(a, 'verified', { method: 'document_review', internalNote: 'Matches ID' });
    expect(ok.status).toBe(200);
    expect((await credFor(pro, a)).credential).toMatchObject({
      effective_status: 'verified', verification_method: 'document_review',
      status_label: 'Documents reviewed (not verified with the primary source)',
    });

    b = (await newLicense(pro, { credentialType: 'RN (review B)' })).id;
    await upload(pro, b);
    await api().post(`${base}/credentials/${b}/submit`).set('Cookie', pro.cookie);
    await decide(b, 'pending_review');
    const ps = await decide(b, 'verified', { method: 'primary_source', sourceReference: 'Nursys lookup, 2026-10-30' });
    expect(ps.status).toBe(200);
    expect((await credFor(pro, b)).credential.status_label).toBe('Verified with the primary source');
  });

  it('turns a verified credential into expired when its date passes, and blocks verifying expired ones', async () => {
    await ctx.db.query(`UPDATE credentials SET issue_date = '2019-01-01', expiration_date = '2020-01-01' WHERE id = $1`, [a]);
    expect((await credFor(pro, a)).credential).toMatchObject({ status: 'verified', effective_status: 'expired', status_label: 'Expired', verified_at: null });
    expect((await api().get(base).set('Cookie', pro.cookie)).body.credentialSummary.expired).toBeGreaterThanOrEqual(1);

    const c = (await newLicense(pro, { credentialType: 'RN (expiring)' })).id;
    await upload(pro, c);
    await api().post(`${base}/credentials/${c}/submit`).set('Cookie', pro.cookie);
    await decide(c, 'pending_review');
    await ctx.db.query(`UPDATE credentials SET issue_date = '2019-01-01', expiration_date = '2020-01-01' WHERE id = $1`, [c]);
    expect((await decide(c, 'verified', { method: 'document_review' })).status).toBe(409);
  });

  it('supports revocation and rejection with reasons, and keeps a full history', async () => {
    expect((await decide(b, 'revoked')).status).toBe(422);
    expect((await decide(b, 'revoked', { reason: 'License suspended by the board.' })).status).toBe(200);
    expect((await credFor(pro, b)).credential).toMatchObject({ effective_status: 'revoked', status_label: 'Revoked' });
    const history = (await admin('get', `/credentials/${b}`)).body.history.map((h: any) => h.to_status);
    expect(history).toEqual(['submitted', 'pending_review', 'verified', 'revoked']);
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'credential.status.verified' AND target_id = $1`, [b]);
    expect(log).toBeTruthy();
  });

  it('removes stored files when a never-submitted credential is deleted', async () => {
    const c = (await newLicense(pro, { credentialType: 'RN (delete me)' })).id;
    await upload(pro, c);
    const before = ctx.storage.files.size;
    expect((await api().delete(`${base}/credentials/${c}`).set('Cookie', pro.cookie)).status).toBe(204);
    expect(ctx.storage.files.size).toBe(before - 1);
  });
});

describe('taxonomy administration', () => {
  it('lets only taxonomy managers change reference data, and hides inactive professions', async () => {
    expect((await api().post('/api/v1/admin/taxonomies/professions').set('Cookie', reviewer.cookie).send({ code: 'dietitian', name: 'Dietitian' })).status).toBe(403);
    const pa = await ctx.adminSession('platform.admin@bsm.example', 'platform_admin');
    const created = await api().post('/api/v1/admin/taxonomies/professions').set('Cookie', pa.cookie).send({ code: 'dietitian', name: 'Dietitian' });
    expect(created.status).toBe(201);
    expect((await api().post('/api/v1/admin/taxonomies/professions').set('Cookie', pa.cookie).send({ code: 'dietitian', name: 'Dietitian 2' })).status).toBe(409);
    await api().patch(`/api/v1/admin/taxonomies/professions/${created.body.profession.id}`).set('Cookie', pa.cookie).send({ active: false });
    const list = (await api().get('/api/v1/taxonomies/professions').set('Cookie', pro.cookie)).body.professions;
    expect(list.find((p: any) => p.code === 'dietitian')).toBeUndefined();
    const newUser = await ctx.userWithSession('late.joiner@example.com');
    expect((await api().post('/api/v1/professionals').set('Cookie', newUser.cookie).send({ professionId: created.body.profession.id })).status).toBe(422);
  });
});
