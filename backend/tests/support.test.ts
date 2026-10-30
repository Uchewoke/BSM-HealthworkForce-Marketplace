import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
const api = () => request(ctx.app);
type S = { id: string; cookie: string };
let user: S, other: S, agent: S, reviewer: S, owner: S, orgId: string;

const create = (s: S, extra: object = {}) =>
  api().post('/api/v1/support/tickets').set('Cookie', s.cookie).send({ category: 'credential', subject: 'My license upload fails', body: 'The upload says unsupported type.', ...extra });
const staff = (method: 'get' | 'post', path: string, s: S = agent) => api()[method](`/api/v1/admin/support${path}`).set('Cookie', s.cookie);
const mine = async (s: S) => (await api().get('/api/v1/notifications').set('Cookie', s.cookie)).body.notifications as any[];

beforeAll(async () => {
  ctx = await makeTestApp();
  user = await ctx.userWithSession('user@example.com');
  other = await ctx.userWithSession('other@example.com');
  owner = await ctx.userWithSession('owner@example.com');
  agent = await ctx.adminSession('agent@bsm.example', 'support_agent');
  reviewer = await ctx.adminSession('reviewer@bsm.example', 'verification_reviewer');
  orgId = (await api().post('/api/v1/organizations').set('Cookie', owner.cookie).send({ name: 'Support Org', type: 'facility' })).body.organization.id;
});

describe('creating and viewing tickets', () => {
  it('requires sign-in and validates input', async () => {
    expect((await api().post('/api/v1/support/tickets').send({})).status).toBe(401);
    expect((await create(user, { subject: 'x' })).status).toBe(422);
    expect((await create(user, { category: 'billing' })).status).toBe(422);
    expect((await create(user, { body: '' })).status).toBe(422);
    expect((await create(user, { relatedId: '00000000-0000-4000-8000-000000000000' })).status).toBe(422); // needs relatedType
  });

  it('only allows organization context for members', async () => {
    expect((await create(user, { organizationId: orgId })).status).toBe(404);
    expect((await create(owner, { organizationId: orgId, category: 'dispute', subject: 'Dispute about a decision' })).status).toBe(201);
  });

  it('is private to the creator', async () => {
    const t = await create(user, { relatedType: 'credential', relatedId: '00000000-0000-4000-8000-000000000000' });
    expect(t.status).toBe(201);
    const id = t.body.ticket.id;
    expect((await api().get(`/api/v1/support/tickets/${id}`).set('Cookie', user.cookie)).body.messages).toHaveLength(1);
    expect((await api().get(`/api/v1/support/tickets/${id}`).set('Cookie', other.cookie)).status).toBe(404);
    expect((await api().post(`/api/v1/support/tickets/${id}/messages`).set('Cookie', other.cookie).send({ body: 'hi' })).status).toBe(404);
    expect((await api().post(`/api/v1/support/tickets/${id}/close`).set('Cookie', other.cookie)).status).toBe(404);
    expect((await api().get('/api/v1/support/tickets').set('Cookie', other.cookie)).body.total).toBe(0);
    expect((await api().get('/api/v1/support/tickets').set('Cookie', user.cookie)).body.total).toBe(1);
  });

  it('limits how fast tickets can be created', async () => {
    const spammer = await ctx.userWithSession('spammer@example.com');
    for (let i = 0; i < 10; i++) expect((await create(spammer)).status).toBe(201);
    expect((await create(spammer)).status).toBe(429);
  });
});

describe('staff handling', () => {
  let id: string;

  it('is limited to support staff with MFA', async () => {
    id = (await api().get('/api/v1/support/tickets').set('Cookie', user.cookie)).body.tickets[0].id;
    expect((await staff('get', '/tickets', user)).status).toBe(403);
    expect((await staff('get', '/tickets', reviewer)).status).toBe(403);
    const noMfa = await ctx.userWithSession('nomfa@bsm.example', 'support_agent');
    expect((await staff('get', '/tickets', noMfa)).body.error.details).toMatchObject({ mfaRequired: true });
    expect((await staff('get', `/tickets/${id}`, reviewer)).status).toBe(403);
  });

  it('shows the queue, supports filters, and records views in the audit log', async () => {
    const q = await staff('get', '/tickets');
    expect(q.body.total).toBeGreaterThanOrEqual(2);
    expect(q.body.tickets[0]).toHaveProperty('requester_name');
    expect((await staff('get', '/tickets?assigned=unassigned')).body.total).toBe(q.body.total);
    expect((await staff('get', '/tickets?category=dispute')).body.tickets.every((t: any) => t.category === 'dispute')).toBe(true);
    expect((await staff('get', '/tickets?status=bogus')).status).toBe(422);
    const detail = await staff('get', `/tickets/${id}`);
    expect(detail.body.ticket.requester_email).toBe('user@example.com');
    const [log] = await ctx.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.support_ticket_viewed' AND target_id = $1`, [id]);
    expect(log).toBeTruthy();
  });

  it('assigns, keeps internal notes private, and notifies the user of replies', async () => {
    expect((await staff('post', `/tickets/${id}/assign`).send({ assignToMe: true })).status).toBe(200);
    expect((await staff('get', '/tickets?assigned=me')).body.tickets.map((t: any) => t.id)).toContain(id);
    await staff('post', `/tickets/${id}/messages`).send({ body: 'Checking the logs. User may be on a PDF/A file.', internal: true });
    expect((await mine(user)).some((n) => n.category === 'support_updates')).toBe(false); // internal notes never notify
    const reply = await staff('post', `/tickets/${id}/messages`).send({ body: 'Please try exporting the file as a standard PDF.' });
    expect(reply.body.ticket.status).toBe('pending_user');
    const view = (await api().get(`/api/v1/support/tickets/${id}`).set('Cookie', user.cookie)).body;
    expect(view.messages.map((m: any) => m.author_kind)).toEqual(['user', 'staff']);
    expect(JSON.stringify(view)).not.toMatch(/PDF\/A|Checking the logs/);
    const note = (await mine(user)).find((n) => n.type === 'support.reply');
    expect(note).toMatchObject({ category: 'support_updates', title: 'Support replied to your request' });
    expect(note.body).toBeNull(); // message text is never copied into notifications or email
    const staffView = (await staff('get', `/tickets/${id}`)).body.messages;
    expect(staffView.map((m: any) => m.internal)).toEqual([false, true, false]);
  });

  it('reopens on a user reply, resolves with a notification, and closes', async () => {
    await api().post(`/api/v1/support/tickets/${id}/messages`).set('Cookie', user.cookie).send({ body: 'That worked, thanks!' });
    expect((await api().get(`/api/v1/support/tickets/${id}`).set('Cookie', user.cookie)).body.ticket.status).toBe('open');
    expect((await staff('post', `/tickets/${id}/status`).send({ status: 'resolved', priority: 'high' })).status).toBe(200);
    expect((await mine(user)).some((n) => n.type === 'support.resolved')).toBe(true);
    expect((await api().post(`/api/v1/support/tickets/${id}/close`).set('Cookie', user.cookie)).body.ticket.status).toBe('closed');
    expect((await api().post(`/api/v1/support/tickets/${id}/messages`).set('Cookie', user.cookie).send({ body: 'one more thing' })).status).toBe(409);
    expect((await staff('post', `/tickets/${id}/messages`).send({ body: 'Following up.' })).status).toBe(409);
    expect((await staff('post', `/tickets/${id}/status`).send({ status: 'weird' })).status).toBe(422);
  });

  it('orders the queue by priority', async () => {
    const a = (await create(other, { subject: 'Low priority question' })).body.ticket.id;
    const b = (await create(other, { subject: 'Urgent account problem' })).body.ticket.id;
    await staff('post', `/tickets/${a}/status`).send({ status: 'open', priority: 'low' });
    await staff('post', `/tickets/${b}/status`).send({ status: 'open', priority: 'urgent' });
    const ids = (await staff('get', '/tickets?status=open&pageSize=50')).body.tickets.map((t: any) => t.id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
  });
});
