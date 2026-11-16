/**
 * Entry point for hosting the API on Vercel (not the current deployment: the API runs on a Droplet from server.ts, see
 * infrastructure/deployment/README.md; to use this, restore the "backend" service in vercel.json from the git history). Vercel wraps the exported
 * app in a function, so nothing here listens on a port or starts timers: the schedulers run as Vercel Schedules that call the
 * /api/v1/scheduled/* routes, and migrations are a deploy step (`npm run migrate -w backend`), never a cold start, so several
 * functions starting at once cannot race on the schema. Everything else is wired exactly as in server.ts.
 */
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPgDb } from './db/index.js';
import { createRuntimeDeps } from './runtime.js';

const config = loadConfig();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required on Vercel: functions have no disk for the embedded database.');
const app = createApp(createRuntimeDeps(config, createPgDb(process.env.DATABASE_URL)));
export default app;
