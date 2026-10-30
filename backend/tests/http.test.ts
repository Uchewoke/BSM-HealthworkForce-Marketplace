import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler, requestId, validate } from '../src/middleware/http.js';
import { AppError } from '../src/shared/errors.js';
import { makeTestApp } from './helpers.js';

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => { ctx = await makeTestApp(); });

describe('http foundations', () => {
  it('serves health with a request id and security headers', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(ctx.app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: res.headers['x-request-id'] });
  });

  it('rejects malformed JSON without leaking internals', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|SyntaxError/);
  });

  it('validates input and hides unexpected errors', async () => {
    const app = express();
    app.use(requestId, express.json());
    app.post('/x', validate({ body: z.object({ n: z.number().int().min(1).max(10) }) }), (_q, r) => { r.json({}); });
    app.get('/boom', () => { throw new Error('db password=secret'); });
    app.get('/forbid', () => { throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.'); });
    app.use(errorHandler);

    const bad = await request(app).post('/x').send({ n: 99 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const boom = await request(app).get('/boom');
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain('secret');
    expect((await request(app).get('/forbid')).status).toBe(403);
  });
});
