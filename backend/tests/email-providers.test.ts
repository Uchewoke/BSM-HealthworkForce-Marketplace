import { describe, expect, it } from 'vitest';
import { DevConsoleEmailSender, emailSenderFromEnv, PostmarkEmailSender, renderEmail, ResendEmailSender } from '../src/integrations/email.js';

type Call = { url: string; headers: Record<string, string>; body: any };
function fakeFetch(responses: (() => Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    const next = responses.shift() ?? (() => new Response('{}', { status: 200 }));
    const r = next();
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe('email content', () => {
  it('puts the token only in the link and never in the subject', () => {
    const c = renderEmail('https://app.example.com/', { to: 'a@b.c', template: 'password_reset', token: 'se cret&x' });
    expect(c.subject).toBe('Reset your password');
    expect(c.subject).not.toContain('se cret');
    expect(c.text).toContain('https://app.example.com/reset-password?token=se%20cret%26x');
    expect(c.html).toContain('href="https://app.example.com/reset-password?token=se%20cret%26x"');
  });

  it('escapes organization names in HTML', () => {
    const c = renderEmail('https://app.example.com', { to: 'a@b.c', template: 'org_invitation', token: 't', orgName: '<b>Evil</b> & Co' });
    expect(c.html).not.toContain('<b>Evil</b>');
    expect(c.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
    expect(c.subject).toBe('You are invited to join <b>Evil</b> & Co'); // subjects are plain text
  });
});

describe('Resend sender', () => {
  it('posts the message and reports sent on 200', async () => {
    const f = fakeFetch([() => new Response('{"id":"x"}', { status: 200 })]);
    const s = new ResendEmailSender('https://app.example.com', 'BSM <no-reply@example.com>', 're_key', { fetchFn: f.fn, sleep: noSleep });
    expect(await s.send({ to: 'u@example.com', template: 'verify_email', token: 'tok' })).toEqual({ status: 'sent' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer re_key');
    expect(f.calls[0]!.body).toMatchObject({ from: 'BSM <no-reply@example.com>', to: ['u@example.com'], subject: 'Confirm your email address' });
    expect(f.calls[0]!.body.text).toContain('verify-email?token=tok');
  });

  it('retries on 5xx and network errors, then succeeds', async () => {
    const f = fakeFetch([() => new Response('', { status: 503 }), () => new Error('ECONNRESET'), () => new Response('{}', { status: 200 })]);
    const s = new ResendEmailSender('https://app.example.com', 'x@example.com', 'k', { fetchFn: f.fn, sleep: noSleep, attempts: 3 });
    expect(await s.send({ to: 'u@example.com', template: 'notification', title: 'Hi' })).toEqual({ status: 'sent' });
    expect(f.calls).toHaveLength(3);
  });

  it('gives up after the configured attempts and never claims sent', async () => {
    const f = fakeFetch([() => new Response('', { status: 500 }), () => new Response('', { status: 500 })]);
    const s = new ResendEmailSender('https://app.example.com', 'x@example.com', 'k', { fetchFn: f.fn, sleep: noSleep, attempts: 2 });
    await expect(s.send({ to: 'u@example.com', template: 'notification', title: 'Hi' })).rejects.toThrow(/500/);
    expect(f.calls).toHaveLength(2);
  });

  it('does not retry a permanent rejection (4xx other than 429)', async () => {
    const f = fakeFetch([() => new Response('{"message":"invalid from"}', { status: 422 })]);
    const s = new ResendEmailSender('https://app.example.com', 'bad', 'k', { fetchFn: f.fn, sleep: noSleep });
    await expect(s.send({ to: 'u@example.com', template: 'verify_email', token: 't' })).rejects.toThrow(/422/);
    expect(f.calls).toHaveLength(1);
  });
});

describe('Postmark sender', () => {
  it('uses the server token header and the message stream', async () => {
    const f = fakeFetch([() => new Response('{}', { status: 200 })]);
    const s = new PostmarkEmailSender('https://app.example.com', 'x@example.com', 'pm_tok', 'transactional', { fetchFn: f.fn, sleep: noSleep });
    expect(await s.send({ to: 'u@example.com', template: 'password_reset', token: 't' })).toEqual({ status: 'sent' });
    expect(f.calls[0]!.url).toBe('https://api.postmarkapp.com/email');
    expect(f.calls[0]!.headers['x-postmark-server-token']).toBe('pm_tok');
    expect(f.calls[0]!.body).toMatchObject({ From: 'x@example.com', To: 'u@example.com', MessageStream: 'transactional' });
  });
});

describe('emailSenderFromEnv', () => {
  it('defaults to the console sender outside production and refuses it in production', () => {
    expect(emailSenderFromEnv('http://localhost:3000', 'development', {})).toBeInstanceOf(DevConsoleEmailSender);
    expect(emailSenderFromEnv('https://x', 'production', {})).toBeUndefined();
    expect(() => emailSenderFromEnv('https://x', 'production', { EMAIL_PROVIDER: 'console' })).toThrow(/production/);
    expect(() => new DevConsoleEmailSender('https://x', 'production')).toThrow(/production/);
  });

  it('builds the chosen provider and insists on its settings', () => {
    expect(emailSenderFromEnv('https://x', 'production', { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.c', RESEND_API_KEY: 'k' })).toBeInstanceOf(ResendEmailSender);
    expect(emailSenderFromEnv('https://x', 'production', { EMAIL_PROVIDER: 'postmark', EMAIL_FROM: 'a@b.c', POSTMARK_SERVER_TOKEN: 'k' })).toBeInstanceOf(PostmarkEmailSender);
    expect(() => emailSenderFromEnv('https://x', 'production', { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' })).toThrow(/EMAIL_FROM/);
    expect(() => emailSenderFromEnv('https://x', 'production', { EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.c' })).toThrow(/RESEND_API_KEY/);
    expect(() => emailSenderFromEnv('https://x', 'production', { EMAIL_PROVIDER: 'pigeon', EMAIL_FROM: 'a@b.c' })).toThrow(/Unknown EMAIL_PROVIDER/);
  });
});
