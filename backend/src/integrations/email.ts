export interface EmailMessage {
  to: string;
  template: 'verify_email' | 'password_reset' | 'org_invitation' | 'notification';
  /** Single-use token for link-based templates; the sender builds the link. Never log this value. */
  token?: string;
  /** Set for org_invitation. */
  orgName?: string;
  /** Set for notification: a short, non-sensitive headline. Emails never carry applicant or credential details. */
  title?: string;
}

export interface EmailSender {
  /** 'not_delivered' means no provider is configured; callers must not present it as sent. */
  send(msg: EmailMessage): Promise<{ status: 'sent' | 'not_delivered' }>;
}

const PATHS = { verify_email: 'verify-email', password_reset: 'reset-password', org_invitation: 'accept-invitation', notification: 'notifications' } as const;

/** The link a template points at. Tokens travel only in the link, never in the subject or in logs. */
export function emailLink(webUrl: string, msg: EmailMessage): string {
  const base = webUrl.replace(/\/+$/, '');
  return `${base}/${PATHS[msg.template]}${msg.token ? `?token=${encodeURIComponent(msg.token)}` : ''}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain, provider-independent content. Deliberately minimal: no personal data beyond what the recipient already knows. */
export function renderEmail(webUrl: string, msg: EmailMessage): { subject: string; text: string; html: string } {
  const link = emailLink(webUrl, msg);
  const body: Record<EmailMessage['template'], { subject: string; lines: string[]; action: string }> = {
    verify_email: { subject: 'Confirm your email address', lines: ['Confirm your email address to finish creating your account.', 'If you did not create an account, ignore this message.'], action: 'Confirm email' },
    password_reset: { subject: 'Reset your password', lines: ['Use the link below to choose a new password. It works once and expires soon.', 'If you did not ask for this, ignore this message; your password has not changed.'], action: 'Reset password' },
    org_invitation: { subject: `You are invited to join ${msg.orgName ?? 'an organization'}`, lines: [`${msg.orgName ?? 'An organization'} has invited you to join them on the platform.`], action: 'Accept invitation' },
    notification: { subject: msg.title ?? 'You have a new notification', lines: [msg.title ?? 'You have a new notification.', 'Sign in to see the details.'], action: 'Open notifications' },
  };
  const t = body[msg.template];
  const text = [...t.lines, '', `${t.action}: ${link}`].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">${t.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p><a href="${escapeHtml(link)}">${escapeHtml(t.action)}</a></p><p style="color:#555;font-size:12px">If the button does not work, copy this address into your browser:<br>${escapeHtml(link)}</p></body></html>`;
  return { subject: t.subject, text, html };
}

/** Local development only: prints the link to the terminal. Refused in production. */
export class DevConsoleEmailSender implements EmailSender {
  constructor(private readonly webUrl: string, nodeEnv: string) {
    if (nodeEnv === 'production') throw new Error('DevConsoleEmailSender cannot be used in production');
  }
  async send(msg: EmailMessage) {
    // eslint-disable-next-line no-console
    console.log(`\n[DEV EMAIL - not delivered] to=${msg.to} ${msg.title ? `"${msg.title}" ` : ''}${emailLink(this.webUrl, msg)}\n`);
    return { status: 'not_delivered' as const };
  }
}

/** Records messages in memory for tests. */
export class OutboxEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.messages.push(msg);
    return { status: 'not_delivered' as const };
  }
  last(to: string, template: EmailMessage['template']) {
    return [...this.messages].reverse().find((m) => m.to === to && m.template === template);
  }
}

export interface HttpEmailOptions {
  fetchFn?: typeof fetch;
  /** Attempts per message (first try included). Retries on network errors, 429 and 5xx with exponential backoff. */
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A transactional provider reached over HTTPS. Subclasses describe one request; this class does retries and the sent/failed
 * decision. A provider that rejects the message for good (4xx other than 429) is an error the caller sees: a verification or
 * reset email that was not accepted must not be reported as sent.
 */
abstract class HttpEmailSender implements EmailSender {
  private readonly fetchFn: typeof fetch;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  protected constructor(protected readonly webUrl: string, protected readonly from: string, opts: HttpEmailOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.attempts = opts.attempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  protected abstract request(msg: EmailMessage, content: ReturnType<typeof renderEmail>): { url: string; headers: Record<string, string>; body: unknown };

  async send(msg: EmailMessage): Promise<{ status: 'sent' | 'not_delivered' }> {
    const content = renderEmail(this.webUrl, msg);
    const { url, headers, body } = this.request(msg, content);
    let lastError = new Error('email provider unavailable');
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetchFn(url, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e)); // network error or timeout: retry
      }
      if (res) {
        if (res.ok) return { status: 'sent' };
        lastError = new Error(`email provider answered ${res.status}`);
        if (res.status !== 429 && res.status < 500) throw lastError; // rejected for good: do not retry, do not claim sent
      }
      if (attempt < this.attempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
    }
    throw lastError;
  }
}

/** Resend (https://resend.com). RESEND_API_KEY and EMAIL_FROM. */
export class ResendEmailSender extends HttpEmailSender {
  constructor(webUrl: string, from: string, private readonly apiKey: string, opts: HttpEmailOptions = {}) { super(webUrl, from, opts); }
  protected request(msg: EmailMessage, c: ReturnType<typeof renderEmail>) {
    return { url: 'https://api.resend.com/emails', headers: { authorization: `Bearer ${this.apiKey}` }, body: { from: this.from, to: [msg.to], subject: c.subject, text: c.text, html: c.html } };
  }
}

/** Postmark (https://postmarkapp.com). POSTMARK_SERVER_TOKEN and EMAIL_FROM; EMAIL_STREAM defaults to "outbound". */
export class PostmarkEmailSender extends HttpEmailSender {
  constructor(webUrl: string, from: string, private readonly token: string, private readonly stream = 'outbound', opts: HttpEmailOptions = {}) { super(webUrl, from, opts); }
  protected request(msg: EmailMessage, c: ReturnType<typeof renderEmail>) {
    return { url: 'https://api.postmarkapp.com/email', headers: { 'x-postmark-server-token': this.token }, body: { From: this.from, To: msg.to, Subject: c.subject, TextBody: c.text, HtmlBody: c.html, MessageStream: this.stream } };
  }
}

/**
 * Picks the provider from EMAIL_PROVIDER (resend | postmark | console). "console" is the development sender and is refused in
 * production. Returns undefined when nothing is configured so the caller decides what that means for its environment.
 */
export function emailSenderFromEnv(webUrl: string, nodeEnv: string, env: NodeJS.ProcessEnv = process.env): EmailSender | undefined {
  const provider = (env.EMAIL_PROVIDER ?? (nodeEnv === 'production' ? '' : 'console')).toLowerCase();
  if (!provider) return undefined;
  if (provider === 'console') return new DevConsoleEmailSender(webUrl, nodeEnv);
  const from = env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is required when EMAIL_PROVIDER is set (e.g. "BSM HealthForce <no-reply@example.com>")');
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    return new ResendEmailSender(webUrl, from, env.RESEND_API_KEY);
  }
  if (provider === 'postmark') {
    if (!env.POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is required when EMAIL_PROVIDER=postmark');
    return new PostmarkEmailSender(webUrl, from, env.POSTMARK_SERVER_TOKEN, env.EMAIL_STREAM || 'outbound');
  }
  throw new Error(`Unknown EMAIL_PROVIDER "${provider}" (use resend, postmark or console)`);
}
