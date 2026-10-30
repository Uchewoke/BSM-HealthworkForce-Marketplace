import { createPgDb, createPgliteDb, migrate } from '../db/index.js';

const db = process.env.DATABASE_URL ? createPgDb(process.env.DATABASE_URL) : await createPgliteDb('./.data/pglite');
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
await db.close();
