/**
 * F15 - Human feedback loop (SPEC §3 F15).
 *
 * A reviewer's verdict is captured against the system's own recommendation.
 * Agreement is tracked over time and broken down by decision basis and
 * confidence bucket so threshold drift becomes visible.
 *
 * This module NEVER changes a threshold, a policy value or a model. It only
 * measures. Adjusting `shared/config/thresholds.json` in response to what it
 * reports is a human decision, made outside this codebase - see SPEC §3 F15:
 * "Feedback adjusts thresholds, never silently retrains a model."
 */
import { randomUUID } from 'node:crypto';
import type { AuditLogger } from './logger.ts';
import type { StoreAdapter } from '../adapters/store.ts';
import type { Decision, HumanReview, Outcome } from '../types.ts';

export interface ReviewInput {
  claim_id: string;
  reviewer: string;
  verdict: Outcome;
  notes: string;
}

export interface FeedbackDeps {
  store: StoreAdapter;
  audit: AuditLogger;
}

/**
 * Records one reviewer verdict against the claim's existing Decision. Throws if
 * the claim was never decided - a review with nothing to agree or disagree with
 * is not a review, it is a data-entry error, and it must not enter the record.
 */
export async function recordHumanReview(
  input: ReviewInput,
  deps: FeedbackDeps,
): Promise<HumanReview> {
  const decision = await deps.store.getDecision(input.claim_id);
  if (!decision) {
    throw new Error(`feedback: claim ${input.claim_id} has no decision on record to review`);
  }

  const review: HumanReview = {
    id: `HR_${randomUUID()}`,
    claim_id: input.claim_id,
    reviewer: input.reviewer,
    verdict: input.verdict,
    agreed_with_system: input.verdict === decision.outcome,
    notes: input.notes,
    at: new Date().toISOString(),
  };

  await deps.store.saveHumanReview(review);
  deps.audit.record(
    input.claim_id,
    'HUMAN',
    'review_recorded',
    { claim_id: input.claim_id, reviewer: input.reviewer },
    {
      system_outcome: decision.outcome,
      reviewer_verdict: review.verdict,
      agreed_with_system: review.agreed_with_system,
      confidence: decision.confidence,
      exposure_inr: decision.exposure_inr,
    },
  );

  return review;
}

export interface DriftBucket {
  label: string;
  reviews: number;
  agreements: number;
  agreement_rate: number;
}

export interface AgreementReport {
  total_reviews: number;
  agreements: number;
  overall_agreement_rate: number;
  /** Agreement rate grouped by the confidence band of the reviewed decision. */
  by_confidence_band: DriftBucket[];
  /** Agreement rate grouped by outcome, to see which label a human overturns most. */
  by_outcome: DriftBucket[];
  /**
   * Reviewer overrides where the confidence was HIGH but the human disagreed -
   * the single strongest threshold-drift signal: the system was sure and wrong.
   */
  confident_overrides: Array<{ claim_id: string; system_outcome: Outcome; reviewer_verdict: Outcome; confidence: number | null }>;
}

const CONFIDENCE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: '0.00-0.60', min: 0, max: 0.6 },
  { label: '0.60-0.80', min: 0.6, max: 0.8 },
  { label: '0.80-0.90', min: 0.8, max: 0.9 },
  { label: '0.90-1.00', min: 0.9, max: 1.0001 },
];

function bucketOf(list: DriftBucket[], key: string): DriftBucket {
  let b = list.find((x) => x.label === key);
  if (!b) {
    b = { label: key, reviews: 0, agreements: 0, agreement_rate: 0 };
    list.push(b);
  }
  return b;
}

function finalize(buckets: DriftBucket[]): DriftBucket[] {
  for (const b of buckets) b.agreement_rate = b.reviews === 0 ? 0 : b.agreements / b.reviews;
  return buckets;
}

/**
 * Pure aggregation - takes reviews plus the decisions they reference, so it can
 * run over a full history without re-querying the store per row.
 */
export function agreementReport(
  reviews: HumanReview[],
  decisionsByClaimId: Map<string, Decision>,
): AgreementReport {
  const byConfidence: DriftBucket[] = [];
  const byOutcome: DriftBucket[] = [];
  const confident_overrides: AgreementReport['confident_overrides'] = [];
  let agreements = 0;

  for (const review of reviews) {
    if (review.agreed_with_system) agreements += 1;

    const decision = decisionsByClaimId.get(review.claim_id);
    const confidence = decision?.confidence ?? null;
    const band = CONFIDENCE_BANDS.find((b) => confidence !== null && confidence >= b.min && confidence < b.max);
    const confKey = band?.label ?? 'no confidence (deterministic-only)';
    const cb = bucketOf(byConfidence, confKey);
    cb.reviews += 1;
    if (review.agreed_with_system) cb.agreements += 1;

    const outcomeKey = decision?.outcome ?? review.verdict;
    const ob = bucketOf(byOutcome, outcomeKey);
    ob.reviews += 1;
    if (review.agreed_with_system) ob.agreements += 1;

    if (!review.agreed_with_system && confidence !== null && confidence >= 0.85 && decision) {
      confident_overrides.push({
        claim_id: review.claim_id,
        system_outcome: decision.outcome,
        reviewer_verdict: review.verdict,
        confidence,
      });
    }
  }

  return {
    total_reviews: reviews.length,
    agreements,
    overall_agreement_rate: reviews.length === 0 ? 0 : agreements / reviews.length,
    by_confidence_band: finalize(byConfidence),
    by_outcome: finalize(byOutcome),
    confident_overrides,
  };
}
