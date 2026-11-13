import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { migrate } from './db/index.js';
import { startMatchRetentionScheduler } from './modules/matching/retention.js';
import { startShiftRecoveryScheduler } from './modules/shift-recovery/scheduler.js';
import { createRuntimeDeps, openDatabase } from './runtime.js';
import { logger } from './shared/logger.js';

// The long-running server: one process that listens on a port and runs the schedulers on timers. On Vercel the same app is
// served from src/serverless.ts instead, where Vercel Schedules replace the timers (see vercel.json at the repository root).
const config = loadConfig();
const db = await openDatabase(config);

const applied = await migrate(db);
if (applied.length) logger.info({ applied }, 'migrations applied');

const deps = createRuntimeDeps(config, db);
const port = Number(process.env.PORT ?? 4000);
createApp(deps)
  .listen(port, () => logger.info({ port }, 'api listening'));

// Unfilled-shift recovery runs every few minutes (SHIFT_RECOVERY_INTERVAL_MINUTES; 0 turns the timer off). Organizations
// only take part if they switched it on.
if (config.shiftRecoveryIntervalMinutes > 0) startShiftRecoveryScheduler(deps, config.shiftRecoveryIntervalMinutes * 60_000);

// Match-run retention cleanup runs daily (MATCH_RETENTION_INTERVAL_HOURS; 0 turns the timer off). The retention period itself is a
// setting a super admin changes (default 90 days). A database lease keeps several API servers from running it at once.
if (config.matchRetentionIntervalHours > 0) startMatchRetentionScheduler(deps, config.matchRetentionIntervalHours * 3_600_000);
