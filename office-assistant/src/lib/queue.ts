import type { Pool, PoolClient } from "pg";
import { db } from "./db";
import { log } from "./log";

type Queryable = Pool | PoolClient;

/** Thrown by a handler that needs to wait (e.g. transcript not ready). Does not count as a failed attempt. */
export class RetryLater extends Error {
  constructor(public readonly delayMs: number, reason: string) {
    super(reason);
  }
}

export interface QueueItem {
  id: number;
  kind: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

/**
 * Adds work. With a dedupe key, an already pending item is kept, but pulled
 * earlier if this request wants it sooner.
 */
export async function enqueue(
  kind: string,
  payload: unknown,
  opts: { runAt?: Date; dedupeKey?: string } = {},
  q: Queryable = db(),
): Promise<void> {
  await q.query(
    `INSERT INTO work_queue (kind, payload, run_at, dedupe_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) WHERE status IN ('pending','running')
     DO UPDATE SET run_at = LEAST(work_queue.run_at, EXCLUDED.run_at)
       WHERE work_queue.status = 'pending'`,
    [kind, JSON.stringify(payload), opts.runAt ?? new Date(), opts.dedupeKey ?? null],
  );
}

export async function claimNext(q: Queryable = db()): Promise<QueueItem | null> {
  // Recover items whose worker died mid run.
  await q.query(
    `UPDATE work_queue SET status = 'pending', locked_at = NULL
     WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`,
  );
  const { rows } = await q.query<QueueItem>(
    `UPDATE work_queue SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM work_queue WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind, payload, attempts, max_attempts`,
  );
  return rows[0] ?? null;
}

export type Handler = (payload: any) => Promise<void>;

export async function runOne(handlers: Record<string, Handler>, q: Queryable = db()): Promise<boolean> {
  const item = await claimNext(q);
  if (!item) return false;
  const handler = handlers[item.kind];
  try {
    if (!handler) throw new Error(`No handler for ${item.kind}`);
    await handler(item.payload);
    await q.query("UPDATE work_queue SET status = 'done', locked_at = NULL WHERE id = $1", [item.id]);
  } catch (err) {
    if (err instanceof RetryLater) {
      await q.query(
        `UPDATE work_queue SET status = 'pending', locked_at = NULL, attempts = attempts - 1,
           run_at = now() + ($2 || ' milliseconds')::interval, last_error = $3 WHERE id = $1`,
        [item.id, String(err.delayMs), err.message],
      );
      return true;
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    const failed = item.attempts >= item.max_attempts;
    await q.query(
      `UPDATE work_queue SET status = $2, locked_at = NULL, last_error = $3,
         run_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
      [item.id, failed ? "failed" : "pending", message, String(30 * 2 ** item.attempts)],
    );
    log.error("work item failed", { id: item.id, kind: item.kind, attempts: item.attempts, failed, error: message });
  }
  return true;
}

export function startWorker(handlers: Record<string, Handler>, pollMs: number): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const didWork = await runOne(handlers);
        if (!didWork) await new Promise((r) => setTimeout(r, pollMs));
      } catch (err) {
        log.error("worker loop error", { error: String(err) });
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
