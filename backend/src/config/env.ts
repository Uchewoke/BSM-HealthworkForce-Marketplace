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
}

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
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = schema.parse(env);
  return {
    nodeEnv: e.NODE_ENV,
    webUrl: e.WEB_URL,
    adminUrl: e.ADMIN_URL,
    allowedOrigins: [new URL(e.WEB_URL).origin, new URL(e.ADMIN_URL).origin],
    cookieSecure: e.NODE_ENV === 'production',
    mfaKey: e.MFA_ENCRYPTION_KEY,
    fieldKey: e.FIELD_ENCRYPTION_KEY,
  };
}
