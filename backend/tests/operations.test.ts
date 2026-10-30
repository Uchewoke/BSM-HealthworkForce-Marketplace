import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, PASSWORD } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let superAdmin: S, platformAdmin: S, reviewer: S, support: S, auditor: S, ownerA: S, alice: S, pro: S;
let orgA: string, locA: string, jobId: string, rnId: string;

const asAdmin = (method: 'get' | 'post' | 'put', path: string, s: S) => api()[method](`/api/v1/admin${path}`).set('Cookie', s.cookie);
const search = (q: object = {}) => api().get('/api/v1/jobs').query(q).set('Cookie', pro.cookie);
const jobsUrl = () => `/api/v1/organizations/${orgA}/jobs`;

async function publishedJob(title: string) {
  const id = (await api().post(jobsUrl()).set('Cookie', ownerA.cookie).send({
    title, description: 'A real description with enough detail to pass the publishing checks.', locationId: locA, professionId: rnId,
    employmentType: 'permanent', payUnit: 'year', noCredentialRequirements: true,
  })).body.job.id as string;
  return { id, publish: () => api().post(`${jobsUrl()}/${id}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' }) };
}

beforeAll(async () => {
  ctx = await makeTestApp();
  superAdmin = await ctx.adminSession('super@bsm.example', 'platform_super_admin');
  platformAdmin = await ctx.adminSession('padmin@bsm.example', 'platform_admin');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  support = await ctx.adminSession('support@bsm.example', 'support_agent');
  auditor = await ctx.adminSession('auditor@bsm.example', 'auditor');
  ownerA = await ctx.userWithSession('owner.a@example.com');
  alice = await ctx.userWithSession('alice.nurse@example.com');
  pro = await ctx.userWithSession('pro@example.com');

  orgA = (await api().post('/api/v1/organizations').set('Cookie', ownerA.cookie).send({ name: 'Alpha Health Group', type: 'facility' })).body.organization.id;
  await api().patch(`/api/v1/organizations/${orgA}`).set('Cookie', ownerA.cookie).send({ legalName: 'Alpha Health Group LLC', state: 'GA' });
  await ctx.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [orgA]);
  const f = await api().post(`/api/v1/organizations/${orgA}/facilities`).set('Cookie', ownerA.cookie).send({ name: 'Alpha Hospital', facilityType: 'hospital' });
  locA = (await api().post(`/api/v1/organizations/${orgA}/facilities/${f.body.facility.id}/locations`).set('Cookie', ownerA.cookie)
    .send({ name: 'Main', addressLine1: '1 Main St', city: 'Atlanta', state: 'GA', postalCode: '30303', timezone: 'America/New_York' })).body.location.id;
  rnId = (await api().get('/api/v1/taxonomies/professions').set('Cookie', ownerA.cookie)).body.professions.find((p: any) => p.code === 'rn').id;
  await api().post('/api/v1/professionals').set('Cookie', pro.cookie).send({ professionId: rnId });
  const j = await publishedJob('Day Shift RN');
  expect((await j.publish()).status).toBe(200);
  jobId = j.id;
});

describe('dashboard', () => {
  it('requires a platform role with MFA', async () => {
    expect((await api().get('/api/v1/admin/dashboard').set('Cookie', ownerA.cookie)).status).toBe(403);
    const noMfa = await ctx.userWithSession('nomfa@bsm.example', 'platform_admin');
    expect((await api().get('/api/v1/admin/dashboard').set('Cookie', noMfa.cookie)).body.error.details).toMatchObject({ mfaRequired: true });
    expect((await api().get('/api/v1/admin/dashboard')).status).toBe(401);
  });

  it('shows each role only the sections its permissions allow', async () => {
    const rev = (await asAdmin('get', '/dashboard', reviewer)).body;
    expect(Object.keys(rev)).toEqual(expect.arrayContaining(['organizations', 'credentials']));
    expect(rev).not.toHaveProperty('jobs');
    expect(rev).not.toHaveProperty('supportTickets');
    expect(rev).not.toHaveProperty('users');
    const sup = (await asAdmin('get', '/dashboard', support)).body;
    expect(Object.keys(sup)).toEqual(expect.arrayContaining(['supportTickets', 'unassignedOpenTickets', 'users']));
    expect(sup).not.toHaveProperty('organizations');
    const pa = (await asAdmin('get', '/dashboard', platformAdmin)).body;
    expect(pa.organizations.approved).toBe(1);
    expect(pa.jobs.published).toBe(1);
    expect(pa.users.total).toBeGreaterThan(5);
    expect(pa).not.toHaveProperty('credentials');
    expect(Object.keys((await asAdmin('get', '/dashboard', auditor)).body).sort()).toEqual(['generatedAt', 'role']);
  });
});

describe('audit search', () => {
  it('is limited to roles with audit access', async () => {
    for (const s of [support, reviewer, platformAdmin, ownerA]) expect((await asAdmin('get', '/audit-logs', s)).status).toBe(403);
    expect((await asAdmin('get', '/audit-logs', auditor)).status).toBe(200);
    expect((await asAdmin('get', '/audit-logs', superAdmin)).status).toBe(200);
  });

  it('filters by action prefix, actor, target, organization and time, with pagination', async () => {
    const all = (await asAdmin('get', '/audit-logs?pageSize=200', auditor)).body;
    expect(all.total).toBeGreaterThan(10);
    const orgs = (await asAdmin('get', '/audit-logs?action=organization.', auditor)).body;
    expect(orgs.auditLogs.length).toBeGreaterThan(0);
    expect(orgs.auditLogs.every((l: any) => l.action.startsWith('organization.'))).toBe(true);
    const byActor = (await asAdmin('get', '/audit-logs?actorEmail=owner.a@example.com', auditor)).body;
    expect(byActor.auditLogs.length).toBeGreaterThan(0);
    expect(byActor.auditLogs.every((l: any) => l.actor_email === 'owner.a@example.com')).toBe(true);
    const byOrg = (await asAdmin('get', `/audit-logs?organizationId=${orgA}`, auditor)).body;
    expect(byOrg.auditLogs.every((l: any) => l.organization_id === orgA)).toBe(true);
    expect((await asAdmin('get', '/audit-logs?targetType=job', auditor)).body.auditLogs.every((l: any) => l.target_type === 'job')).toBe(true);
    expect((await asAdmin('get', '/audit-logs?from=2999-01-01T00:00:00Z', auditor)).body.total).toBe(0);
    // Paginate over a stable filter: reading the log appends its own audit row, which would shift an unfiltered view.
    const p1 = (await asAdmin('get', '/audit-logs?action=auth.login&pageSize=3&page=1', auditor)).body.auditLogs.map((l: any) => l.id);
    const p2 = (await asAdmin('get', '/audit-logs?action=auth.login&pageSize=3&page=2', auditor)).body.auditLogs.map((l: any) => l.id);
    expect(p1).toHaveLength(3);
    expect(p1.filter((id: string) => p2.includes(id))).toEqual([]);
  });

  it('rejects unsafe or oversized filters and records that the log was read', async () => {
    expect((await asAdmin('get', "/audit-logs?action='; DROP TABLE users", auditor)).status).toBe(422);
    expect((await asAdmin('get', '/audit-logs?action=%25', auditor)).status).toBe(422);
    expect((await asAdmin('get', '/audit-logs?pageSize=500', auditor)).status).toBe(422);
    expect((await asAdmin('get', '/audit-logs?organizationId=nope', auditor)).status).toBe(422);
    const [row] = await ctx.db.query<{ metadata: { filters: string[] } }>(`SELECT metadata FROM audit_logs WHERE action = 'admin.audit_read' ORDER BY created_at DESC LIMIT 1`);
    expect(row).toBeTruthy();
  });
});

describe('user administration', () => {
  it('lets support search and view users but not change them', async () => {
    expect((await asAdmin('get', '/users?q=a', support)).status).toBe(422); // too short
    const found = await asAdmin('get', '/users?q=alice', support);
    expect(found.body.users.map((u: any) => u.email)).toEqual(['alice.nurse@example.com']);
    expect(JSON.stringify(found.body)).not.toMatch(/password_hash|argon2/);
    const detail = await asAdmin('get', `/users/${alice.id}`, support);
    expect(detail.body.user.email).toBe('alice.nurse@example.com');
    expect(detail.body.activeSessions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(detail.body)).not.toMatch(/password_hash/);
    expect((await asAdmin('post', `/users/${alice.id}/status`, support).send({ status: 'suspended', reason: 'Testing access' })).status).toBe(403);
    expect((await asAdmin('get', '/users?q=alice', ownerA)).status).toBe(403);
    expect((await asAdmin('get', '/users/not-a-uuid', support)).status).toBe(422);
  });

  it('records searches without storing what was searched', async () => {
    const [row] = await ctx.db.query<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM audit_logs WHERE action = 'admin.user_search' ORDER BY created_at DESC LIMIT 1`);
    expect(row!.metadata).toMatchObject({ queryLength: 5, results: 1 });
    expect(JSON.stringify(row!.metadata)).not.toContain('alice');
  });

  it('suspends a user: sessions are revoked, sign-in is refused, and it can be reversed', async () => {
    expect((await asAdmin('post', `/users/${alice.id}/status`, platformAdmin).send({ status: 'suspended' })).status).toBe(422); // reason required
    const res = await asAdmin('post', `/users/${alice.id}/status`, platformAdmin).send({ status: 'suspended', reason: 'Reported for fraudulent activity.' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set('Cookie', alice.cookie)).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: 'alice.nurse@example.com', password: PASSWORD })).status).toBe(401);
    expect((await asAdmin('post', `/users/${alice.id}/status`, platformAdmin).send({ status: 'suspended', reason: 'Again, please.' })).status).toBe(409);
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.user_suspended' AND target_id = $1`, [alice.id]);
    expect(log).toBeTruthy();
    expect((await asAdmin('post', `/users/${alice.id}/status`, platformAdmin).send({ status: 'active', reason: 'Review completed.' })).status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email: 'alice.nurse@example.com', password: PASSWORD })).status).toBe(200);
  });

  it('protects platform accounts and prevents self-changes', async () => {
    expect((await asAdmin('post', `/users/${platformAdmin.id}/status`, platformAdmin).send({ status: 'suspended', reason: 'Self suspend.' })).status).toBe(409);
    expect((await asAdmin('post', `/users/${reviewer.id}/status`, platformAdmin).send({ status: 'suspended', reason: 'Trying to lock out staff.' })).status).toBe(403);
    expect((await asAdmin('post', `/users/${reviewer.id}/status`, superAdmin).send({ status: 'suspended', reason: 'Offboarding.' })).status).toBe(200);
    expect((await asAdmin('get', '/dashboard', reviewer)).status).toBe(401); // existing session ended
    expect((await asAdmin('post', '/users/00000000-0000-4000-8000-000000000000/status', platformAdmin).send({ status: 'active', reason: 'Nobody home.' })).status).toBe(404);
  });
});

describe('marketplace oversight', () => {
  it('is limited to marketplace oversight roles', async () => {
    expect((await asAdmin('get', '/jobs', support)).status).toBe(403);
    expect((await asAdmin('get', '/jobs', ownerA)).status).toBe(403);
    const list = await asAdmin('get', '/jobs?status=published&pageSize=5', platformAdmin);
    expect(list.status).toBe(200);
    expect(list.body.jobs[0]).toMatchObject({ title: 'Day Shift RN', organization_name: 'Alpha Health Group', state: 'GA' });
    expect((await asAdmin('get', '/jobs?q=Alpha', platformAdmin)).body.total).toBeGreaterThan(0);
    expect((await asAdmin('get', '/jobs?status=draft&organizationId=' + orgA, platformAdmin)).body.jobs.every((j: any) => j.status === 'draft')).toBe(true);
    expect((await asAdmin('get', '/jobs?pageSize=500', platformAdmin)).status).toBe(422);
  });

  it('shows job detail and lets staff pause a job with a reason, notifying the facility', async () => {
    const detail = await asAdmin('get', `/jobs/${jobId}`, platformAdmin);
    expect(detail.body.job.title).toBe('Day Shift RN');
    expect(detail.body).toHaveProperty('history');
    expect((await asAdmin('post', `/jobs/${jobId}/status`, platformAdmin).send({ to: 'paused' })).status).toBe(422);
    expect((await asAdmin('post', `/jobs/${jobId}/status`, platformAdmin).send({ to: 'published', reason: 'Not allowed here.' })).status).toBe(422);
    expect((await asAdmin('post', `/jobs/${jobId}/status`, support).send({ to: 'paused', reason: 'No access.' })).status).toBe(403);
    const paused = await asAdmin('post', `/jobs/${jobId}/status`, platformAdmin).send({ to: 'paused', reason: 'Listing text needs correction.' });
    expect(paused.status).toBe(200);
    expect((await search()).body.jobs.map((j: any) => j.id)).not.toContain(jobId);
    const notes = (await api().get('/api/v1/notifications').set('Cookie', ownerA.cookie)).body.notifications;
    expect(notes.find((n: any) => n.type === 'job.admin_paused')).toMatchObject({ body: 'Listing text needs correction.' });
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.job_intervention' AND target_id = $1`, [jobId]);
    expect(log).toBeTruthy();
    expect((await asAdmin('post', `/jobs/${jobId}/status`, platformAdmin).send({ to: 'paused', reason: 'Already paused.' })).status).toBe(409);
    expect((await api().post(`${jobsUrl()}/${jobId}/status`).set('Cookie', ownerA.cookie).send({ to: 'published' })).status).toBe(200); // facility fixes and resumes
  });

  it('finds organizations in any status', async () => {
    const res = await asAdmin('get', '/organization-lookup?q=alpha', reviewer);
    expect(res.status).toBe(401); // reviewer was offboarded above
    const ok = await asAdmin('get', '/organization-lookup?q=alpha', platformAdmin);
    expect(ok.body.organizations.map((o: any) => o.name)).toEqual(['Alpha Health Group']);
    expect((await asAdmin('get', '/organization-lookup?q=a', platformAdmin)).status).toBe(422);
  });
});

describe('state configuration', () => {
  it('lists every state, enabled by default, and restricts changes to taxonomy managers', async () => {
    const list = (await asAdmin('get', '/states', platformAdmin)).body.states;
    expect(list).toHaveLength(51);
    expect(list.find((s: any) => s.state === 'GA')).toMatchObject({ enabled: true, configured: false });
    expect((await asAdmin('get', '/states', support)).status).toBe(403);
    expect((await asAdmin('put', '/states/GA', support).send({ enabled: false })).status).toBe(403);
    expect((await asAdmin('put', '/states/ZZ', platformAdmin).send({ enabled: false })).status).toBe(422);
    expect((await asAdmin('put', '/states/GA', platformAdmin).send({ enabled: 'no' })).status).toBe(422);
  });

  it('a disabled state hides its jobs, blocks publishing there, and can be re-enabled', async () => {
    expect((await search()).body.jobs.map((j: any) => j.id)).toContain(jobId);
    const off = await asAdmin('put', '/states/ga', platformAdmin).send({ enabled: false, notes: 'Not yet launched.' });
    expect(off.status).toBe(200);
    expect((await search()).body.jobs.map((j: any) => j.id)).not.toContain(jobId);
    expect((await api().post(`/api/v1/jobs/${jobId}/apply`).set('Cookie', pro.cookie).send({})).status).toBe(404);
    const next = await publishedJob('Blocked Listing');
    const blocked = await next.publish();
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.missing).toContain('state_not_enabled');
    await asAdmin('put', '/states/GA', platformAdmin).send({ enabled: true });
    expect((await search()).body.jobs.map((j: any) => j.id)).toContain(jobId);
    expect((await next.publish()).status).toBe(200);
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.state_configured' AND target_id = 'GA'`);
    expect(log).toBeTruthy();
  });
});

describe('operational endpoints', () => {
  it('serves liveness and readiness without authentication', async () => {
    expect((await api().get('/api/v1/health')).body).toEqual({ status: 'ok' });
    expect((await api().get('/api/v1/ready')).body).toEqual({ status: 'ready' });
  });

  it('exposes request metrics to super admins only', async () => {
    expect((await asAdmin('get', '/metrics', platformAdmin)).status).toBe(403);
    const m = await asAdmin('get', '/metrics', superAdmin);
    expect(m.status).toBe(200);
    expect(m.body.requests).toBeGreaterThan(50);
    expect(m.body.byStatusClass['2xx']).toBeGreaterThan(0);
    expect(m.body).toHaveProperty('errorRate');
    expect(m.body).toHaveProperty('latency');
  });
});
