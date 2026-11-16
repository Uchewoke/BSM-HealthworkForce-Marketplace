import type { AppConfig } from './config/env.js';
import { createPgDb, createPgliteDb, type Db } from './db/index.js';
import { AnthropicAssistant } from './integrations/assistant.js';
import { StripeBillingProvider } from './integrations/billing.js';
import { emailSenderFromEnv } from './integrations/email.js';
import { ClamAvScanner, NotConfiguredScanner } from './integrations/malware.js';
import { LocalFsStorage, S3PrivateStorage } from './integrations/storage.js';
import type { AppDeps } from './shared/deps.js';
import { logger } from './shared/logger.js';
import { UpstashRateLimitStore } from './shared/rate-limit.js';

/** PostgreSQL from DATABASE_URL, or the embedded database for local development (never in production). */
export async function openDatabase(config: AppConfig): Promise<Db> {
  if (process.env.DATABASE_URL) return createPgDb(process.env.DATABASE_URL);
  if (config.nodeEnv === 'production') throw new Error('DATABASE_URL is required in production');
  return createPgliteDb('./.data/pglite');
}

/**
 * Wires the real adapters from the environment. Shared by the long-running server and the serverless entry so both behave the same.
 * Production refuses to start without a real email provider and a private bucket, so nothing ever pretends to send email or keeps
 * credential documents on a local disk. A shared rate-limit store is required too, because serverless instances do not share memory.
 */
export function createRuntimeDeps(config: AppConfig, db: Db, env: NodeJS.ProcessEnv = process.env): AppDeps {
  const production = config.nodeEnv === 'production';
  const missing: string[] = [];

  const email = emailSenderFromEnv(config.webUrl, config.nodeEnv, env);
  if (!email) missing.push('EMAIL_PROVIDER=resend|postmark with EMAIL_FROM and the provider key');

  let storage = S3PrivateStorage.fromEnv(env);
  if (!storage && production) missing.push('STORAGE_BUCKET (plus STORAGE_ENDPOINT/STORAGE_REGION and credentials) for a private bucket');

  const limits = UpstashRateLimitStore.fromEnv(env);
  if (!limits && production && env.RATE_LIMIT_STORE !== 'memory') {
    missing.push('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for shared rate limits (or RATE_LIMIT_STORE=memory on a single long-running server)');
  }

  if (missing.length) throw new Error(`Production configuration is incomplete:\n - ${missing.join('\n - ')}`);

  const scanner = ClamAvScanner.fromEnv(env) ?? new NotConfiguredScanner();
  if (production && scanner instanceof NotConfiguredScanner) logger.warn('CLAMAV_HOST is not set: uploaded documents are stored as not_scanned');
  if (production && !limits) logger.warn('RATE_LIMIT_STORE=memory: rate limits are per process and only correct for a single long-running server');

  return {
    db, config, email: email!,
    storage: storage ?? new LocalFsStorage(env.FILE_STORAGE_DIR ?? './.data/files', config.nodeEnv),
    limits,
    billing: StripeBillingProvider.fromEnv(env), // NotConfiguredBillingProvider unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set
    assistant: AnthropicAssistant.fromEnv(env), // NotConfiguredAssistant unless ANTHROPIC_API_KEY is set
    scanner,
  };
}
