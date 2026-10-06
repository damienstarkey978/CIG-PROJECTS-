import fs from "node:fs";
import path from "node:path";
import { Pool, PoolClient } from "pg";
import { config } from "../config";

let pool: Pool | undefined;

export function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl() });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

// src/lib under tsx, dist/src/lib when compiled.
const MIGRATIONS_DIR = [path.resolve(__dirname, "../../migrations"), path.resolve(__dirname, "../../../migrations")].find((d) =>
  fs.existsSync(d),
)!;

/** Applies migrations/*.sql in name order, each once. */
export async function migrate(dir = MIGRATIONS_DIR): Promise<string[]> {
  await db().query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Set(
    (await db().query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const applied: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await withTx(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}
