import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let owner: S, other: S, admin: S, orgId: string, otherOrgId: string;

const PROFILE = {
  legalName: 'Alpha Care Center LLC', contactEmail: 'ops@alpha.example', contactPhone: '+1 404-555-0100',
  website: 'https://alpha.example', state: 'ga',
};
const LOCATION = {
  name: 'Main Campus', addressLine1: '100 Peachtree St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York',
};
const decide = (id: string, to: string, extra: object = {}) =>
  api().post(`/api/v1/admin/organizations/${id}/status`).set('Cookie', admin.cookie).send({ to, ...extra });

beforeAll(async () => {
  ctx = await makeTestApp();
  owner = await ctx.userWithSession('owner@alpha.example');
  other = await ctx.userWithSession('owner@beta.example');
  admin = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  orgId = (await api().post('/api/v1/organizations').set('Cookie', owner.cookie).send({ name: 'Alpha Care', type: 'facility' })).body.organization.id;
  otherOrgId = (await api().post('/api/v1/organizations').set('Cookie', other.cookie).send({ name: 'Beta Hospital', type: 'facility' })).body.organization.id;
});

describe('submit for review', () => {
  it('rejects submission until the profile is complete and lists what is missing', async () => {
    const res = await api().post(`/api/v1/organizations/${orgId}/submit`).set('Cookie', owner.cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing).toEqual(expect.arrayContaining(['legalName', 'contactEmail', 'contactPhone', 'state']));
  });

  it('validates profile fields', async () => {
    const patch = (b: object) => api().patch(`/api/v1/organizations/${orgId}`).set('Cookie', owner.cookie).send(b);
    expect((await patch({ state: 'Georgia' })).status).toBe(422);
    expect((await patch({ website: 'javascript:alert(1)' })).status).toBe(422);
    expect((await patch({ contactPhone: 'abc' })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
  });

  it('only roles with submit permission can submit', async () => {
    const ro = await ctx.userWithSession('ro@alpha.example');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'read_only')`, [orgId, ro.id]);
    expect((await api().post(`/api/v1/organizations/${orgId}/submit`).set('Cookie', ro.cookie)).status).toBe(403);
  });

  it('submits a complete profile and locks it from further edits', async () => {
    const upd = await api().patch(`/api/v1/organizations/${orgId}`).set('Cookie', owner.cookie).send(PROFILE);
    expect(upd.status).toBe(200);
    expect(upd.body.organization.state).toBe('GA');
    const sub = await api().post(`/api/v1/organizations/${orgId}/submit`).set('Cookie', owner.cookie);
    expect(sub.status).toBe(200);
    expect(sub.body.organization.status).toBe('submitted');
    expect((await api().patch(`/api/v1/organizations/${orgId}`).set('Cookie', owner.cookie).send({ name: 'Changed Name' })).status).toBe(409);
    expect((await api().post(`/api/v1/organizations/${orgId}/submit`).set('Cookie', owner.cookie)).status).toBe(409);
  });
});

describe('admin review', () => {
  it('restricts the review queue to platform reviewers with MFA', async () => {
    expect((await api().get('/api/v1/admin/organizations').set('Cookie', owner.cookie)).status).toBe(403);
    const noMfa = await ctx.userWithSession('nomfa@bsm.example', 'verification_reviewer');
    const res = await api().get('/api/v1/admin/organizations').set('Cookie', noMfa.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ mfaRequired: true });
    const support = await ctx.adminSession('support@bsm.example', 'support_agent');
    expect((await api().get('/api/v1/admin/organizations').set('Cookie', support.cookie)).status).toBe(403);
  });

  it('lists the queue with pagination and rejects bad query values', async () => {
    const res = await api().get('/api/v1/admin/organizations').query({ status: 'submitted', pageSize: 5 }).set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 5, total: 1 });
    expect(res.body.organizations[0].id).toBe(orgId);
    expect((await api().get('/api/v1/admin/organizations').query({ pageSize: 500 }).set('Cookie', admin.cookie)).status).toBe(422);
    expect((await api().get('/api/v1/admin/organizations').query({ sort: 'name; DROP TABLE users' }).set('Cookie', admin.cookie)).status).toBe(422);
  });

  it('enforces the state machine and required reasons', async () => {
    expect((await decide(orgId, 'approved')).status).toBe(409); // must be under review first
    expect((await decide(orgId, 'under_review')).status).toBe(200);
    expect((await decide(orgId, 'rejected')).status).toBe(422); // reason required
    const info = await decide(orgId, 'needs_information', { reason: 'Please add a facility license number.', internalNote: 'Looks thin' });
    expect(info.status).toBe(200);
    expect(info.body.organization).toMatchObject({ status: 'needs_information', previousStatus: 'under_review' });
  });

  it('shows the facility the decision and reason but not internal notes or reviewer identity', async () => {
    const res = await api().get(`/api/v1/organizations/${orgId}/reviews`).set('Cookie', owner.cookie);
    const last = res.body.reviews.at(-1);
    expect(last).toMatchObject({ to_status: 'needs_information', reason: 'Please add a facility license number.' });
    expect(JSON.stringify(res.body)).not.toMatch(/Looks thin|internal_note|reviewer@bsm/);
    const detail = await api().get(`/api/v1/admin/organizations/${orgId}`).set('Cookie', admin.cookie);
    expect(detail.body.reviews.at(-1).internal_note).toBe('Looks thin');
  });

  it('lets the facility fix the profile, resubmit, and be approved', async () => {
    expect((await api().patch(`/api/v1/organizations/${orgId}`).set('Cookie', owner.cookie).send({ website: 'https://alpha.example/about' })).status).toBe(200);
    expect((await api().post(`/api/v1/organizations/${orgId}/submit`).set('Cookie', owner.cookie)).status).toBe(200);
    expect((await decide(orgId, 'under_review')).status).toBe(200);
    expect((await decide(orgId, 'approved')).status).toBe(200);
    const org = await api().get(`/api/v1/organizations/${orgId}`).set('Cookie', owner.cookie);
    expect(org.body.organization.status).toBe('approved');
    const history = (await api().get(`/api/v1/organizations/${orgId}/reviews`).set('Cookie', owner.cookie)).body.reviews;
    expect(history.map((h: { to_status: string }) => h.to_status)).toEqual(
      ['submitted', 'under_review', 'needs_information', 'submitted', 'under_review', 'approved']);
  });

  it('audits every decision', async () => {
    const rows = await ctx.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'organization.status.%'`, [orgId]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['organization.status.approved', 'organization.status.needs_information', 'organization.status.submitted']));
    expect((await decide(otherOrgId, 'under_review')).status).toBe(409); // never submitted
  });
});

describe('facilities, locations, departments', () => {
  let facilityId: string, locationId: string;
  const base = () => `/api/v1/organizations/${orgId}/facilities`;

  it('blocks writes until the organization is approved (reads still work)', async () => {
    const blocked = await api().post(`/api/v1/organizations/${otherOrgId}/facilities`).set('Cookie', other.cookie).send({ name: 'Beta Main', facilityType: 'hospital' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ organizationStatus: 'draft' });
    expect((await api().get(`/api/v1/organizations/${otherOrgId}/facilities`).set('Cookie', other.cookie)).status).toBe(200);
  });

  it('creates and lists the facility → location → department hierarchy', async () => {
    const f = await api().post(base()).set('Cookie', owner.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
    expect(f.status).toBe(201);
    facilityId = f.body.facility.id;
    expect((await api().post(base()).set('Cookie', owner.cookie).send({ name: 'alpha hospital', facilityType: 'clinic' })).status).toBe(409); // duplicate name

    const l = await api().post(`${base()}/${facilityId}/locations`).set('Cookie', owner.cookie).send({ ...LOCATION, state: 'ga' });
    expect(l.status).toBe(201);
    expect(l.body.location.state).toBe('GA');
    locationId = l.body.location.id;

    const d = await api().post(`${base()}/${facilityId}/locations/${locationId}/departments`).set('Cookie', owner.cookie).send({ name: 'ICU' });
    expect(d.status).toBe(201);
    const list = await api().get(`${base()}/${facilityId}/locations/${locationId}/departments`).set('Cookie', owner.cookie);
    expect(list.body.departments.map((x: { name: string }) => x.name)).toEqual(['ICU']);

    const off = await api().patch(`${base()}/${facilityId}/locations/${locationId}/departments/${d.body.department.id}`).set('Cookie', owner.cookie).send({ active: false });
    expect(off.body.department.active).toBe(false);
  });

  it('validates location input', async () => {
    const post = (b: object) => api().post(`${base()}/${facilityId}/locations`).set('Cookie', owner.cookie).send({ ...LOCATION, name: 'X Site', ...b });
    expect((await post({ timezone: 'Mars/Olympus' })).status).toBe(422);
    expect((await post({ postalCode: 'ABCDE' })).status).toBe(422);
    expect((await post({ state: 'Georgia' })).status).toBe(422);
  });

  it('enforces role permissions on writes', async () => {
    const ro = await ctx.userWithSession('viewer@alpha.example');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'read_only')`, [orgId, ro.id]);
    expect((await api().get(base()).set('Cookie', ro.cookie)).status).toBe(200);
    expect((await api().post(base()).set('Cookie', ro.cookie).send({ name: 'Nope Place', facilityType: 'clinic' })).status).toBe(403);
  });

  it('prevents cross-tenant access, even by combining ids from different organizations', async () => {
    // Other tenant cannot see or use Alpha's records through either path.
    expect((await api().get(base()).set('Cookie', other.cookie)).status).toBe(404);
    expect((await api().get(`/api/v1/organizations/${otherOrgId}/facilities/${facilityId}/locations`).set('Cookie', other.cookie)).status).toBe(404);
    expect((await api().patch(`/api/v1/organizations/${otherOrgId}/facilities/${facilityId}`).set('Cookie', other.cookie).send({ name: 'Hijacked' })).status).toBeGreaterThanOrEqual(403); // 403 (org not approved) or 404, never success
    const [f] = await ctx.db.query<{ name: string }>('SELECT name FROM facilities WHERE id = $1', [facilityId]);
    expect(f!.name).toBe('Alpha Hospital');
  });

  it('is enforced by the database too: a location cannot point at another organization\'s facility', async () => {
    await expect(ctx.db.query(
      `INSERT INTO facility_locations (organization_id, facility_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,$2,'Bad','1 St','X','GA','30303','America/New_York')`, [otherOrgId, facilityId])).rejects.toThrow();
  });

  it('suspension blocks writes again', async () => {
    expect((await decide(orgId, 'suspended')).status).toBe(422); // reason required
    expect((await decide(orgId, 'suspended', { reason: 'Compliance review pending.' })).status).toBe(200);
    expect((await api().post(base()).set('Cookie', owner.cookie).send({ name: 'Another Site', facilityType: 'clinic' })).status).toBe(403);
    expect((await decide(orgId, 'approved', { reason: 'Review complete.' })).status).toBe(200);
  });
});

describe('invitations and members', () => {
  const inv = () => `/api/v1/organizations/${orgId}/invitations`;
  let token: string, invitationId: string, inviteeSession: S;

  it('owner invites; token is emailed but never returned or listed', async () => {
    const res = await api().post(inv()).set('Cookie', owner.cookie).send({ email: 'Nurse.Manager@Alpha.example', role: 'hiring_manager' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    invitationId = res.body.invitation.id;
    const msg = ctx.email.last('nurse.manager@alpha.example', 'org_invitation')!;
    expect(msg.orgName).toBe('Alpha Care');
    token = msg.token!;
    const list = await api().get(inv()).set('Cookie', owner.cookie);
    expect(list.body.invitations).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    const [row] = await ctx.db.query<{ token_hash: string }>('SELECT token_hash FROM organization_invitations WHERE id = $1', [invitationId]);
    expect(row!.token_hash).not.toBe(token);
  });

  it('blocks privilege escalation and ownership invites', async () => {
    expect((await api().post(inv()).set('Cookie', owner.cookie).send({ email: 'x@alpha.example', role: 'facility_owner' })).status).toBe(422);
    const hm = await ctx.userWithSession('hm@alpha.example');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'hiring_manager')`, [orgId, hm.id]);
    expect((await api().post(inv()).set('Cookie', hm.cookie).send({ email: 'y@alpha.example', role: 'read_only' })).status).toBe(403); // no members.invite
    const adm = await ctx.userWithSession('adm@alpha.example');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'facility_admin')`, [orgId, adm.id]);
    expect((await api().post(inv()).set('Cookie', adm.cookie).send({ email: 'z@alpha.example', role: 'finance' })).status).toBe(403); // finance has billing.read; admin does not
    expect((await api().post(inv()).set('Cookie', adm.cookie).send({ email: 'z@alpha.example', role: 'recruiter' })).status).toBe(201);
  });

  it('another tenant cannot list or revoke these invitations', async () => {
    expect((await api().get(inv()).set('Cookie', other.cookie)).status).toBe(404);
    expect((await api().delete(`${inv()}/${invitationId}`).set('Cookie', other.cookie)).status).toBe(404);
  });

  it('only the invited address can accept, and only once', async () => {
    expect((await api().post('/api/v1/invitations/accept').set('Cookie', other.cookie).send({ token })).status).toBe(400);
    const invitee = await ctx.userWithSession('nurse.manager@alpha.example');
    inviteeSession = invitee;
    expect((await api().post('/api/v1/invitations/accept').send({ token })).status).toBe(401);
    const ok = await api().post('/api/v1/invitations/accept').set('Cookie', invitee.cookie).send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ organizationId: orgId, role: 'hiring_manager' });
    expect((await api().get(`/api/v1/organizations/${orgId}`).set('Cookie', invitee.cookie)).status).toBe(200);
    expect((await api().post('/api/v1/invitations/accept').set('Cookie', invitee.cookie).send({ token })).status).toBe(400);
  });

  it('revoked and superseded invitations cannot be accepted', async () => {
    const send = async (email: string) => {
      await api().post(inv()).set('Cookie', owner.cookie).send({ email, role: 'read_only' });
      return ctx.email.last(email, 'org_invitation')!.token;
    };
    const t1 = await send('later@alpha.example');
    const t2 = await send('later@alpha.example'); // re-invite supersedes the first
    const later = await ctx.userWithSession('later@alpha.example');
    expect((await api().post('/api/v1/invitations/accept').set('Cookie', later.cookie).send({ token: t1 })).status).toBe(400);
    const pending = (await api().get(inv()).set('Cookie', owner.cookie)).body.invitations.find((i: { email: string }) => i.email === 'later@alpha.example');
    expect((await api().delete(`${inv()}/${pending.id}`).set('Cookie', owner.cookie)).status).toBe(204);
    expect((await api().post('/api/v1/invitations/accept').set('Cookie', later.cookie).send({ token: t2 })).status).toBe(400);
  });

  it('manages members without allowing escalation, self-edits, or touching the owner', async () => {
    const members = (await api().get(`/api/v1/organizations/${orgId}/members`).set('Cookie', owner.cookie)).body.members as { id: string; email: string; role: string }[];
    const byEmail = (e: string) => members.find((m) => m.email === e)!;
    const hm = byEmail('nurse.manager@alpha.example');
    const ownerRow = byEmail('owner@alpha.example');
    const adm = await ctx.userWithSession('adm2@alpha.example');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'facility_admin')`, [orgId, adm.id]);
    const url = (id: string) => `/api/v1/organizations/${orgId}/members/${id}`;

    expect((await api().patch(url(ownerRow.id)).set('Cookie', adm.cookie).send({ role: 'read_only' })).status).toBe(403);
    expect((await api().delete(url(ownerRow.id)).set('Cookie', adm.cookie)).status).toBe(403);
    expect((await api().patch(url(ownerRow.id)).set('Cookie', owner.cookie).send({ role: 'read_only' })).status).toBe(403); // self
    expect((await api().patch(url(hm.id)).set('Cookie', owner.cookie).send({ role: 'facility_owner' })).status).toBe(422);
    expect((await api().patch(url(hm.id)).set('Cookie', owner.cookie).send({ role: 'scheduler' })).status).toBe(200);
    expect((await api().patch(url(otherMember())).set('Cookie', owner.cookie).send({ role: 'scheduler' })).status).toBe(404); // not in this org
    expect((await api().delete(url(hm.id)).set('Cookie', owner.cookie)).status).toBe(204);
    expect((await api().get(`/api/v1/organizations/${orgId}`).set('Cookie', inviteeSession.cookie)).status).toBe(404);
  });
});

function otherMember() {
  return '00000000-0000-4000-8000-000000000000';
}
