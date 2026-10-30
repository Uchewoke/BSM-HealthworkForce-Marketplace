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

/** Local development only: prints the link to the terminal. Refused in production. */
export class DevConsoleEmailSender implements EmailSender {
  constructor(private readonly webUrl: string, nodeEnv: string) {
    if (nodeEnv === 'production') throw new Error('DevConsoleEmailSender cannot be used in production');
  }
  async send(msg: EmailMessage) {
    const path = { verify_email: 'verify-email', password_reset: 'reset-password', org_invitation: 'accept-invitation', notification: 'notifications' }[msg.template];
    const suffix = msg.token ? `?token=${msg.token}` : '';
    // eslint-disable-next-line no-console
    console.log(`\n[DEV EMAIL - not delivered] to=${msg.to} ${msg.title ? `"${msg.title}" ` : ''}${this.webUrl}/${path}${suffix}\n`);
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
