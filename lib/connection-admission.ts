import { VehicleError } from "./skoda-core.mjs";

// Durable across isolates/restarts; independent of the submitted VIN or API key.
export const CONNECTION_LIMITS = { windowMs: 15 * 60_000, accountAttempts: 5, globalAttempts: 100, concurrent: 8, leaseMs: 45_000, failureDelayMs: 30_000, retentionMs: 24 * 60 * 60_000 } as const;
type Budget = { window_start: number; attempts: number; blocked_until: number; expires_at: number };

export async function admitConnection(db: D1Database, userId: string) {
  const now = Date.now(), token = crypto.randomUUID(), limits = CONNECTION_LIMITS;
  await db.prepare("DELETE FROM connection_attempts WHERE updated_at < ? AND expires_at <= ? AND blocked_until <= ?")
    .bind(now - limits.retentionMs, now, now).run();
  // D1 batch is a transaction. The singleton gate serializes admission, checks the
  // account BEFORE spending global capacity, and authorizes exactly this token's row.
  const results = await db.batch([
    db.prepare(`UPDATE connection_gate SET
      attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END,
      last_token = ?
      WHERE id = 1 AND (window_start <= ? OR attempts < ?)
      AND NOT EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = ? AND
        (expires_at > ? OR blocked_until > ? OR (window_start > ? AND attempts >= ?)))
      AND (SELECT count(*) FROM connection_attempts WHERE expires_at > ?) < ?`)
      .bind(now - limits.windowMs, now - limits.windowMs, now, token, now - limits.windowMs, limits.globalAttempts,
        userId, now, now, now - limits.windowMs, limits.accountAttempts, now, limits.concurrent),
    db.prepare(`INSERT INTO connection_attempts (user_id, window_start, attempts, blocked_until, token, expires_at, updated_at)
      SELECT ?, ?, 1, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connection_gate WHERE id = 1 AND last_token = ?)
      ON CONFLICT(user_id) DO UPDATE SET
        attempts = CASE WHEN connection_attempts.window_start <= ? THEN 1 ELSE connection_attempts.attempts + 1 END,
        window_start = CASE WHEN connection_attempts.window_start <= ? THEN excluded.window_start ELSE connection_attempts.window_start END,
        token = excluded.token, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
      .bind(userId, now, token, now + limits.leaseMs, now, token, now - limits.windowMs, now - limits.windowMs),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) {
    const account = await db.prepare("SELECT * FROM connection_attempts WHERE user_id = ?").bind(userId).first<Budget>();
    const global = await db.prepare("SELECT * FROM connection_gate WHERE id = 1").first<Budget>();
    const until = Math.max(now + 1000, account?.blocked_until ?? 0, account?.expires_at ?? 0,
      account && account.attempts >= limits.accountAttempts ? account.window_start + limits.windowMs : 0,
      global && global.attempts >= limits.globalAttempts ? global.window_start + limits.windowMs : 0);
    throw new VehicleError("CONNECTION_ATTEMPT_LIMITED", "Příliš mnoho pokusů o připojení nebo právě probíhá ověření. Počkej před dalším pokusem.", 429, Math.ceil((until - now) / 1000));
  }
  return {
    token,
    async assertCurrent() {
      const current = await db.prepare("SELECT 1 AS active FROM connection_attempts WHERE user_id = ? AND token = ? AND expires_at > ?")
        .bind(userId, token, Date.now()).first();
      if (!current) throw new VehicleError("CONNECTION_ATTEMPT_EXPIRED", "Ověření připojení vypršelo. Zkuste to znovu.", 409);
    },
    async finish(failed: boolean) {
      await db.prepare("UPDATE connection_attempts SET token = NULL, expires_at = 0, blocked_until = ?, updated_at = ? WHERE user_id = ? AND token = ?")
        .bind(failed ? Date.now() + limits.failureDelayMs : 0, Date.now(), userId, token).run();
    },
  };
}
