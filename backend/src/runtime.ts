import type { AppConfig } from './config/env.js';
import { createPgDb, createPgliteDb, type Db } from './db/index.js';
import { AnthropicAssistant } from './integrations/assistant.js';
import { StripeBillingProvider } from './integrations/billing.js';
import { DevConsoleEmailSender } from './integrations/email.js';
import { NotConfiguredScanner } from './integrations/malware.js';
import { LocalFsStorage } from './integrations/storage.js';
import type { AppDeps } from './shared/deps.js';

/** PostgreSQL from DATABASE_URL, or the embedded database for local development (never in production). */
export async function openDatabase(config: AppConfig): Promise<Db> {
  if (process.env.DATABASE_URL) return createPgDb(process.env.DATABASE_URL);
  if (config.nodeEnv === 'production') throw new Error('DATABASE_URL is required in production');
  return createPgliteDb('./.data/pglite');
}

/** Wires the real adapters. Shared by the long-running server and the serverless entry so both behave the same. */
export function createRuntimeDeps(config: AppConfig, db: Db): AppDeps {
  if (config.nodeEnv === 'production') {
    // No email provider or private-bucket storage adapter exists yet. Refuse to start rather than pretend emails are
    // delivered or keep credential documents on a local disk.
    throw new Error('Production needs an EmailSender adapter and a private object-storage adapter (PrivateFileStorage); neither is implemented yet.');
  }
  return {
    db, config, email: new DevConsoleEmailSender(config.webUrl, config.nodeEnv),
    storage: new LocalFsStorage(process.env.FILE_STORAGE_DIR ?? './.data/files'),
    billing: StripeBillingProvider.fromEnv(), // NotConfiguredBillingProvider unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set
    assistant: AnthropicAssistant.fromEnv(), // NotConfiguredAssistant unless ANTHROPIC_API_KEY is set
    scanner: new NotConfiguredScanner(), // documents are stored with scan_status = 'not_scanned' until a scanner is configured
  };
}
