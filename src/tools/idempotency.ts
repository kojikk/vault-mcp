/**
 * Idempotency ledger (§9 decision: client op_id + ledger).
 *
 * The bot's durable queue may replay a capture after a Desktop-offline window. To stop a
 * replay from creating duplicates, write tools accept an optional `idempotency_key`. The
 * ledger remembers recently applied keys and short-circuits repeats, returning the prior
 * outcome instead of mutating again.
 *
 * It is intentionally in-memory and bounded: for a single-user vault a restart window is an
 * acceptable gap, and dedup of meaning (not just exact replays) still lives in agent.md.
 */
export class IdempotencyLedger {
  private readonly seen = new Map<string, { at: number; summary: string }>();

  constructor(
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
    private readonly maxEntries: number = 5000,
  ) {}

  get(key: string): string | undefined {
    const rec = this.seen.get(key);
    if (!rec) return undefined;
    if (Date.now() - rec.at > this.ttlMs) {
      this.seen.delete(key);
      return undefined;
    }
    return rec.summary;
  }

  record(key: string, summary: string): void {
    if (this.seen.size >= this.maxEntries) {
      // Evict the oldest entry (insertion order).
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, { at: Date.now(), summary });
  }
}
