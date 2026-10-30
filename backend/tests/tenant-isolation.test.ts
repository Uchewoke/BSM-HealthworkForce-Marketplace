import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totpCode, totpStep } from '../src/shared/crypto.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
let a: { id: string; cookie: string }, b: { id: string; cookie: string }, orgA: string, orgB: string;

beforeAll(async () => {
  ctx = await makeTestApp();
  a = await ctx.userWithSession('owner-a@example.com');
  b = await ctx.userWithSession('owner-b@example.com');
  const mk = async (cookie: string, name: string) =>
    (await api().post('/api/v1/organizations').set('Cookie', cookie).send({ name, type: 'facility' })).body.organization.id as string;
  orgA = await mk(a.cookie, 'Alpha Care Center');
  orgB = await mk(b.cookie, 'Beta Hospital');
});

describe('tenant isolation', () => {
  it('requires authentication', async () => {
    expect((await api().get(`/api/v1/organizations/${orgA}`)).status).toBe(401);
    expect((await api().get('/api/v1/organizations')).status).toBe(401);
  });

  it('creator becomes owner and sees only their own organizations', async () => {
    const list = await api().get('/api/v1/organizations').set('Cookie', a.cookie);
    expect(list.body.organizations).toHaveLength(1);
    expect(list.body.organizations[0]).toMatchObject({ id: orgA, role: 'facility_owner', status: 'draft' });
  });

  it("cannot read, change or list members of another organization by changing the URL id (IDOR)", async () => {
    expect((await api().get(`/api/v1/organizations/${orgB}`).set('Cookie', a.cookie)).status).toBe(404);
    expect((await api().patch(`/api/v1/organizations/${orgB}`).set('Cookie', a.cookie).send({ name: 'Hijacked' })).status).toBe(404);
    expect((await api().get(`/api/v1/organizations/${orgB}/members`).set('Cookie', a.cookie)).status).toBe(404);
    const [o] = await ctx.db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgB]);
    expect(o!.name).toBe('Beta Hospital');
  });

  it('ignores a client-supplied organizationId in the body', async () => {
    const res = await api().patch(`/api/v1/organizations/${orgA}`).set('Cookie', a.cookie).send({ name: 'Alpha Renamed', organizationId: orgB });
    expect(res.status).toBe(200);
    const [o] = await ctx.db.query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgB]);
    expect(o!.name).toBe('Beta Hospital');
  });

  it('enforces role permissions within an organization', async () => {
    const ro = await ctx.userWithSession('readonly@example.com');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'read_only')`, [orgA, ro.id]);
    expect((await api().get(`/api/v1/organizations/${orgA}`).set('Cookie', ro.cookie)).status).toBe(200);
    expect((await api().patch(`/api/v1/organizations/${orgA}`).set('Cookie', ro.cookie).send({ name: 'Nope Nope' })).status).toBe(403);
  });

  it('removed members lose access immediately', async () => {
    const m = await ctx.userWithSession('removed@example.com');
    await ctx.db.query(`INSERT INTO organization_members (organization_id, user_id, role, status) VALUES ($1,$2,'facility_admin','removed')`, [orgA, m.id]);
    expect((await api().get(`/api/v1/organizations/${orgA}`).set('Cookie', m.cookie)).status).toBe(404);
  });

  it('rejects malformed ids and out-of-range input', async () => {
    expect((await api().get('/api/v1/organizations/not-a-uuid').set('Cookie', a.cookie)).status).toBe(422);
    expect((await api().post('/api/v1/organizations').set('Cookie', a.cookie).send({ name: 'x', type: 'facility' })).status).toBe(422);
    expect((await api().post('/api/v1/organizations').set('Cookie', a.cookie).send({ name: 'Valid Name', type: 'agency' })).status).toBe(422);
  });
});

describe('platform access and audit', () => {
  it('facility owners cannot use admin endpoints', async () => {
    expect((await api().get('/api/v1/admin/users/lookup').query({ email: 'x@example.com' }).set('Cookie', a.cookie)).status).toBe(403);
  });

  it('records sensitive actions in an append-only audit log', async () => {
    const admin = await ctx.userWithSession('super@example.com', 'platform_super_admin');
    const setup = await api().post('/api/v1/auth/mfa/setup').set('Cookie', admin.cookie);
    const code = totpCode(base32Decode(setup.body.secret), totpStep(Date.now()));
    await api().post('/api/v1/auth/mfa/confirm').set('Cookie', admin.cookie).send({ code });

    expect((await api().get('/api/v1/admin/users/lookup').query({ email: 'owner-a@example.com' }).set('Cookie', admin.cookie)).status).toBe(200);
    const logs = await api().get('/api/v1/admin/audit-logs').set('Cookie', admin.cookie);
    expect(logs.status).toBe(200);
    const actions = logs.body.auditLogs.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.user_lookup', 'organization.created', 'auth.login']));

    await expect(ctx.db.query('UPDATE audit_logs SET action = $1', ['tampered'])).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
  });
});
