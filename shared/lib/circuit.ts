/**
 * F11 - Circuit breaker for the verifier (SPEC §3 F11).
 *
 * Repeated verifier failures mean the model path is unhealthy. Rather than
 * hammering it claim after claim, the breaker opens and the whole queue degrades
 * to deterministic-only mode: L1 still runs, everything that would have needed a
 * verdict goes to REVIEW, and the operator is alerted.
 *
 * The breaker can only ever remove the model from the decision. It can never
 * turn a REVIEW into an APPROVE.
 */

export type BreakerState = 'closed' | 'open';

export interface BreakerSnapshot {
  state: BreakerState;
  consecutive_failures: number;
  opened_at: number | null;
  trips: number;
}

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  #consecutiveFailures = 0;
  #openedAt: number | null = null;
  #trips = 0;

  constructor(consecutiveFailureThreshold: number, cooldownMs: number) {
    this.#threshold = consecutiveFailureThreshold;
    this.#cooldownMs = cooldownMs;
  }

  /** True when the verifier should be skipped entirely for this claim. */
  isOpen(now: number = Date.now()): boolean {
    if (this.#openedAt === null) return false;
    if (now - this.#openedAt >= this.#cooldownMs) {
      // Cooldown elapsed - allow one probe through.
      this.#openedAt = null;
      this.#consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#openedAt = null;
  }

  /** @returns true if this failure is the one that tripped the breaker. */
  recordFailure(now: number = Date.now()): boolean {
    this.#consecutiveFailures += 1;
    if (this.#openedAt === null && this.#consecutiveFailures >= this.#threshold) {
      this.#openedAt = now;
      this.#trips += 1;
      return true;
    }
    return false;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.#openedAt === null ? 'closed' : 'open',
      consecutive_failures: this.#consecutiveFailures,
      opened_at: this.#openedAt,
      trips: this.#trips,
    };
  }
}
