import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPgDb, createPgliteDb, migrate } from './db/index.js';
import { DevConsoleEmailSender } from './integrations/email.js';
import { NotConfiguredScanner } from './integrations/malware.js';
import { LocalFsStorage } from './integrations/storage.js';
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
createApp({
  db, config, email: new DevConsoleEmailSender(config.webUrl, config.nodeEnv),
  storage: new LocalFsStorage(process.env.FILE_STORAGE_DIR ?? './.data/files'),
  scanner: new NotConfiguredScanner(), // documents are stored with scan_status = 'not_scanned' until a scanner is configured
})
  .listen(port, () => logger.info({ port }, 'api listening'));
