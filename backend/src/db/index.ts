import { mkdir, readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a multi-statement script (no parameters). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Embedded database only: a full snapshot of the data directory (used to validate backup/restore). */
  dump?(): Promise<Blob>;
}

/** Embedded Postgres, used for tests and zero-dependency local development. */
export async function createPgliteDb(dataDir?: string, loadDataDir?: Blob): Promise<Db> {
  if (dataDir) await mkdir(dataDir, { recursive: true }); // PGlite does not create missing parent folders itself
  const lite = new PGlite({ dataDir, loadDataDir });
  await lite.waitReady;
  return {
    query: async (sql, params) => (await lite.query(sql, params as any[])).rows as any[],
    exec: async (sql) => { await lite.exec(sql); },
    transaction: (fn) =>
      lite.transaction((tx) =>
        fn({
          query: async (sql, params) => (await tx.query(sql, params as any[])).rows as any[],
          exec: async (sql) => { await tx.exec(sql); },
        }),
      ),
    close: () => lite.close(),
    dump: async () => (await lite.dumpDataDir('gzip')) as Blob,
  };
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
    exec: async (sql) => { await pool.query(sql); },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({
          query: async (sql, params) => (await client.query(sql, params as any[])).rows,
          exec: async (sql) => { await client.query(sql); },
        });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Applies pending `NNNN_name.sql` files in order, each in its own transaction. Returns applied names. */
export async function migrate(db: Db, dir = new URL('../../migrations/', import.meta.url)): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(new URL(file, dir), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
