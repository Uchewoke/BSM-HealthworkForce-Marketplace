import { z } from 'zod';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  webUrl: string;
  adminUrl: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  /** 32-byte key encrypting MFA secrets at rest. */
  mfaKey: Buffer;
  /** 32-byte key encrypting sensitive fields (credential numbers) and signing file-access URLs. */
  fieldKey: Buffer;
  /** Master switch for subscription gating and checkout. Off: nothing is gated and checkout is unavailable. Individual organizations are then switched on one by one. */
  billingEnabled: boolean;
  /** Days a past-due subscription keeps its paid features before they are restricted. */
  billingGraceDays: number;
  /** Shared secret an external scheduler (Vercel Schedules) sends as `Authorization: Bearer …` to the /scheduled routes. Unset: those routes refuse to run. */
  cronSecret?: string;
  /** Minutes between unfilled-shift recovery passes of the in-process timer. 0 turns recovery off everywhere, the scheduled route included. */
  shiftRecoveryIntervalMinutes: number;
  /** Hours between match-run retention passes of the in-process timer. 0 turns cleanup off everywhere, the scheduled route included. */
  matchRetentionIntervalHours: number;
}

const optionalString = (min = 1) => z.preprocess((v) => (v === '' ? undefined : v), z.string().min(min).optional());

/** Hostnames Vercel sets on every deployment. Their origins are allowed so a preview deployment (one hostname each) can sign in. */
const vercelOrigins = (e: { VERCEL_URL?: string; VERCEL_BRANCH_URL?: string; VERCEL_PROJECT_PRODUCTION_URL?: string }) =>
  [e.VERCEL_URL, e.VERCEL_BRANCH_URL, e.VERCEL_PROJECT_PRODUCTION_URL].filter((h): h is string => !!h).map((h) => `https://${h}`);

const key = (name: string) =>
  z.string().min(1, `${name} is required (generate: openssl rand -base64 32)`).transform((v, ctx) => {
    const buf = Buffer.from(v, 'base64');
    if (buf.length !== 32) ctx.addIssue({ code: 'custom', message: `${name} must be 32 bytes, base64-encoded` });
    return buf;
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  WEB_URL: z.url().default('http://localhost:3000'),
  ADMIN_URL: z.url().default('http://localhost:3001'),
  MFA_ENCRYPTION_KEY: key('MFA_ENCRYPTION_KEY'),
  FIELD_ENCRYPTION_KEY: key('FIELD_ENCRYPTION_KEY'),
  BILLING_SUBSCRIPTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  CRON_SECRET: optionalString(16),
  SHIFT_RECOVERY_INTERVAL_MINUTES: z.coerce.number().min(0).default(5),
  MATCH_RETENTION_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  VERCEL_URL: optionalString(),
  VERCEL_BRANCH_URL: optionalString(),
  VERCEL_PROJECT_PRODUCTION_URL: optionalString(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = schema.parse(env);
  return {
    nodeEnv: e.NODE_ENV,
    webUrl: e.WEB_URL,
    adminUrl: e.ADMIN_URL,
    allowedOrigins: [...new Set([new URL(e.WEB_URL).origin, new URL(e.ADMIN_URL).origin, ...vercelOrigins(e)])],
    cookieSecure: e.NODE_ENV === 'production',
    mfaKey: e.MFA_ENCRYPTION_KEY,
    fieldKey: e.FIELD_ENCRYPTION_KEY,
    billingEnabled: e.BILLING_SUBSCRIPTIONS_ENABLED === 'true',
    billingGraceDays: e.BILLING_GRACE_DAYS,
    cronSecret: e.CRON_SECRET,
    shiftRecoveryIntervalMinutes: e.SHIFT_RECOVERY_INTERVAL_MINUTES,
    matchRetentionIntervalHours: e.MATCH_RETENTION_INTERVAL_HOURS,
  };
}
