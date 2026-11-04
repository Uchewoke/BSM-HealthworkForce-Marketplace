import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPgDb, createPgliteDb, migrate } from './db/index.js';
import { AnthropicAssistant } from './integrations/assistant.js';
import { StripeBillingProvider } from './integrations/billing.js';
import { DevConsoleEmailSender } from './integrations/email.js';
import { NotConfiguredScanner } from './integrations/malware.js';
import { LocalFsStorage } from './integrations/storage.js';
import { startMatchRetentionScheduler } from './modules/matching/retention.js';
import { startShiftRecoveryScheduler } from './modules/shift-recovery/scheduler.js';
import { logger } from './shared/logger.js';

const config = loadConfig();
const db = process.env.DATABASE_URL
  ? createPgDb(process.env.DATABASE_URL)
  : config.nodeEnv === 'production'
    ? (() => { throw new Error('DATABASE_URL is required in production'); })()
    : await createPgliteDb('./.data/pglite');

const applied = await migrate(db);
if (applied.length) logger.info({ applied }, 'migrations applied');

if (config.nodeEnv === 'production') {
  // No email provider or private-bucket storage adapter exists yet. Refuse to start rather than pretend emails are
  // delivered or keep credential documents on a local disk.
  throw new Error('Production needs an EmailSender adapter and a private object-storage adapter (PrivateFileStorage); neither is implemented yet.');
}

const port = Number(process.env.PORT ?? 4000);
const deps = {
  db, config, email: new DevConsoleEmailSender(config.webUrl, config.nodeEnv),
  storage: new LocalFsStorage(process.env.FILE_STORAGE_DIR ?? './.data/files'),
  billing: StripeBillingProvider.fromEnv(), // NotConfiguredBillingProvider unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set
  assistant: AnthropicAssistant.fromEnv(), // NotConfiguredAssistant unless ANTHROPIC_API_KEY is set
  scanner: new NotConfiguredScanner(), // documents are stored with scan_status = 'not_scanned' until a scanner is configured
};
createApp(deps)
  .listen(port, () => logger.info({ port }, 'api listening'));

// Unfilled-shift recovery runs every few minutes (SHIFT_RECOVERY_INTERVAL_MINUTES; 0 turns the timer off). Organizations
// only take part if they switched it on.
const recoveryMinutes = Number(process.env.SHIFT_RECOVERY_INTERVAL_MINUTES ?? 5);
if (recoveryMinutes > 0) startShiftRecoveryScheduler(deps, recoveryMinutes * 60_000);

// Match-run retention cleanup runs daily (MATCH_RETENTION_INTERVAL_HOURS; 0 turns the timer off). The retention period itself is a
// setting a super admin changes (default 90 days). A database lease keeps several API servers from running it at once.
const retentionHours = Number(process.env.MATCH_RETENTION_INTERVAL_HOURS ?? 24);
if (retentionHours > 0) startMatchRetentionScheduler(deps, retentionHours * 3_600_000);
