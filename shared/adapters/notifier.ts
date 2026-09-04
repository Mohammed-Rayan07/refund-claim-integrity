/**
 * Notifier adapter — alerts the human review queue.
 *
 * This is the only outbound side effect RCIE has, and it moves information,
 * not money: it tells a human that a claim needs their judgement.
 */
import { isMock } from '../mode.ts';
import type { Outcome } from '../types.ts';

export interface ReviewAlert {
  claim_id: string;
  outcome: Outcome;
  reason_codes: string[];
  exposure_inr: number;
  summary: string;
}

export interface NotifierAdapter {
  readonly kind: 'mock' | 'live';
  notifyReviewQueue(alert: ReviewAlert): Promise<void>;
  /** Everything queued this run — the mock adapter's review queue depth. */
  queued(): ReviewAlert[];
}

class MockNotifierAdapter implements NotifierAdapter {
  readonly kind = 'mock' as const;
  #queue: ReviewAlert[] = [];

  async notifyReviewQueue(alert: ReviewAlert): Promise<void> {
    this.#queue.push(alert);
  }

  queued(): ReviewAlert[] {
    return [...this.#queue];
  }
}

export function createNotifierAdapter(): NotifierAdapter {
  if (isMock()) return new MockNotifierAdapter();

  // TODO(LIVE): POST the alert to the merchant's review-queue webhook.
  // Requires .env: REVIEW_QUEUE_WEBHOOK_URL
  throw new Error('TODO(LIVE): live notifier adapter not implemented. Set MODE=mock.');
}
