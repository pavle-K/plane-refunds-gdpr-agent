import { createHash } from "node:crypto";
import { pool } from "../db/client.js";

/**
 * Serializes access to one conversation thread across processes. Without this,
 * two turns on the same thread — e.g. a user's next message racing the
 * background turn started by resumeConversationAfterEmailConnected once an
 * OAuth connection completes — can both read the same checkpoint, run
 * concurrently, and leave the thread with an AIMessage tool call that never
 * got its matching ToolMessage. Anthropic (and every other tool-calling
 * provider) rejects that shape outright on the next call, permanently, since
 * nothing here repairs it — this is what actually happened in production use
 * and is not hypothetical.
 *
 * A Postgres advisory lock, not an in-process mutex, because a thread can be
 * touched by more than one process (the API server's OAuth callback route and
 * a CLI/channel process both call into src/operator/session.ts). The lock is
 * held on a single checked-out connection for the duration of the turn and
 * releases automatically if that connection drops (crash, restart) — so a
 * dead process can never leave a thread permanently locked.
 */
async function threadLockKey(threadId: string): Promise<bigint> {
  const digest = createHash("sha256").update(threadId).digest();
  return digest.readBigInt64BE(0);
}

export async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const key = await threadLockKey(threadId);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [key]);
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [key]).catch(() => {
      // Best-effort — if the connection is already broken, releasing the
      // session-scoped lock this way is moot; Postgres drops it when the
      // connection closes regardless (see client.release() below).
    });
    client.release();
  }
}
