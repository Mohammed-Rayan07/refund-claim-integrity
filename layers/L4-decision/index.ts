/**
 * L4 - Decision Engine (SPEC §7 "L4 Decision Engine"). Deterministic code, NOT an LLM.
 *
 * The §7 ladder, in order, with no step reordered or omitted. The reuse branch is
 * present and wired to an L2 input that stays null until Chunk 3.
 *
 * F8 - cost-sensitive thresholds: the confidence a claim must clear scales with
 * its rupee exposure, so a large claim needs stronger evidence than a small one
 * and reaches REVIEW sooner. Wrongly approving INR 80,000 and wrongly denying
 * INR 500 are not the same error.
 *
 * MONEY SAFETY (SPEC §0 / §3 F4): this module returns one of three labels. It has
 * no reference to any adapter that could move funds, and DENY_RECOMMEND is a
 * recommendation routed to a human - never an executed denial.
 */
import { randomUUID } from 'node:crypto';
import { ceilingForCategory, type LoadedConfig } from '../../shared/config/index.ts';
import type { AuditLogger } from '../../shared/lib/logger.ts';
import type { ReasonCode } from '../../shared/lib/reasoncodes.ts';
import type { SanitisedClaimText } from '../../shared/lib/sanitiser.ts';
import type { Claim, Decision, Outcome } from '../../shared/types.ts';
import type { IntegrityGateResult } from '../L1-deterministic/index.ts';
import type { VerifierResult } from '../L3-verifier/index.ts';

/** L2 output. Null until Chunk 3 builds reuse detection. */
export interface ReuseSignal {
  max_similarity: number;
  source: 'customer_history' | 'merchant_catalogue' | 'shared_index';
  matched_ref: string;
}

/** Why no verifier verdict exists, when there is none. */
export type VerifierAbsence = 'not_reached' | 'circuit_open' | 'adapter_unavailable';

export interface DecisionInput {
  claim: Claim;
  gate: IntegrityGateResult;
  sanitised: SanitisedClaimText;
  reuse: ReuseSignal | null;
  /** Null when the verifier was never called at all. */
  verifier: VerifierResult | null;
  verifier_absence: VerifierAbsence | null;
  latency_ms: number;
  cost_inr: number;
}

export interface DecisionDeps {
  config: LoadedConfig;
  audit: AuditLogger;
}

export interface DecisionResult {
  decision: Decision;
  /** Human-readable one-liner for the review queue and the demo output. */
  summary: string;
  /** The §7 rung that settled this claim. */
  decision_basis: string;
  injection_suspected: boolean;
  required_confidence: number;
  policy_rules_fired: string[];
}

/**
 * §7: threshold = base_threshold + (exposure / auto_approve_ceiling) * scaling_factor
 * Capped so a very large claim cannot demand an unreachable confidence - it will
 * have been sent to REVIEW by the exposure ceiling anyway.
 */
export function confidenceThresholdFor(
  exposure_inr: number,
  ceiling_inr: number,
  config: LoadedConfig,
): number {
  const d = config.thresholds.decision;
  const scaled = d.base_threshold + (exposure_inr / ceiling_inr) * d.scaling_factor;
  return Math.min(scaled, d.max_confidence_threshold);
}

export function decide(input: DecisionInput, deps: DecisionDeps): DecisionResult {
  const { claim, gate, sanitised, reuse, verifier } = input;
  const { config, audit } = deps;

  const exposure_inr = claim.amount_inr;
  const category = gate.line_item?.category ?? null;
  const ceiling = ceilingForCategory(config.policy, category);
  const required_confidence = confidenceThresholdFor(exposure_inr, ceiling, config);
  const reuse_cut = config.thresholds.decision.reuse_cut;

  // Injection is suspected if EITHER the deterministic sanitiser or the model
  // flagged it. The sanitiser alone is enough - it runs before any model call.
  const verdict = verifier?.ok ? verifier.verdict : null;
  const injection_suspected = sanitised.injection_suspected || verdict?.injection_suspected === true;

  let outcome: Outcome;
  let reason_codes: ReasonCode[];
  let summary: string;
  let decision_basis: string;
  const policy_rules_fired: string[] = [];

  if (!gate.passed) {
    // 1. Any L1 hard failure -> DENY_RECOMMEND + codes
    outcome = 'DENY_RECOMMEND';
    reason_codes = gate.reason_codes;
    decision_basis = 'l1_hard_failure';
    const failed = gate.checks.find((c) => c.status === 'fail');
    summary = `L1 ${gate.failed_check}: ${failed?.detail ?? 'integrity check failed'}`;
  } else if (reuse !== null && reuse.max_similarity > reuse_cut) {
    // 2. Reuse above cut -> DENY_RECOMMEND + RCI-09 / RCI-10
    outcome = 'DENY_RECOMMEND';
    reason_codes = [reuse.source === 'merchant_catalogue' ? 'RCI-10' : 'RCI-09'];
    decision_basis = 'evidence_reuse';
    summary = `evidence matches ${reuse.matched_ref} at ${reuse.max_similarity.toFixed(2)} (cut ${reuse_cut})`;
  } else if (verifier === null || !verifier.ok) {
    // 3. Verifier failed / malformed / never ran -> REVIEW + RCI-11 (fail-safe, F11)
    outcome = 'REVIEW';
    reason_codes = ['RCI-11'];
    decision_basis = 'verifier_unavailable';
    policy_rules_fired.push('PR-03');
    const why = verifier === null ? (input.verifier_absence ?? 'not_reached') : verifier.failure;
    const detail = verifier === null ? '' : `: ${verifier.message}`;
    summary = `verifier ${why}${detail} - failed safe to REVIEW`;
  } else if (injection_suspected) {
    // 4. Injection suspected -> REVIEW + audit flag (§7 specifies no reason code)
    outcome = 'REVIEW';
    reason_codes = [];
    decision_basis = 'injection_suspected';
    policy_rules_fired.push('PR-02');
    const ids = sanitised.signals.map((s) => s.id).join(', ') || 'model-flagged';
    summary = `prompt-injection attempt in claim text (${ids}) - verdict discarded, routed to human`;
  } else if (verdict?.supports_claim === 'no') {
    // 5. Evidence contradicts the claim -> DENY_RECOMMEND + RCI-07
    outcome = 'DENY_RECOMMEND';
    reason_codes = ['RCI-07'];
    if (verdict.contradictions.length > 0) reason_codes.push('RCI-08');
    decision_basis = 'claim_unsupported';
    summary =
      verdict.contradictions[0] ?? 'evidence does not support the described damage';
  } else if (verdict?.supports_claim === 'insufficient') {
    // 6. Abstention -> REVIEW + RCI-11
    outcome = 'REVIEW';
    reason_codes = ['RCI-11'];
    decision_basis = 'verifier_abstained';
    summary = `verifier abstained: ${verdict.reasoning.slice(0, 90)}`;
  } else if ((verdict?.confidence ?? 0) < required_confidence) {
    // 7. Confidence below the exposure-scaled bar -> REVIEW (§7 specifies no code)
    outcome = 'REVIEW';
    reason_codes = [];
    decision_basis = 'confidence_below_threshold';
    summary = `confidence ${verdict?.confidence.toFixed(2)} below ${required_confidence.toFixed(2)} required at INR ${exposure_inr} exposure`;
  } else if (exposure_inr > ceiling) {
    // 8. Above the merchant's ceiling -> REVIEW regardless of confidence (F14)
    outcome = 'REVIEW';
    reason_codes = [];
    decision_basis = 'exposure_above_ceiling';
    policy_rules_fired.push('PR-01');
    summary = `exposure INR ${exposure_inr} above ${category ?? 'merchant'} ceiling INR ${ceiling} - policy requires a human`;
  } else {
    // 9. Clean, supported, confident, within ceiling.
    outcome = 'APPROVE';
    reason_codes = [];
    decision_basis = 'clean_and_supported';
    summary = `evidence supports claim at confidence ${verdict?.confidence.toFixed(2)} (bar ${required_confidence.toFixed(2)}), INR ${exposure_inr} within ceiling INR ${ceiling}`;
  }

  const decision: Decision = {
    id: `DEC_${randomUUID()}`,
    claim_id: claim.id,
    outcome,
    reason_codes,
    confidence: verdict?.confidence ?? null,
    exposure_inr,
    model_version: verifier?.ok ? verifier.model_version : null,
    prompt_version: verifier?.prompt_version ?? null,
    config_snapshot_id: config.snapshot_id,
    latency_ms: input.latency_ms,
    cost_inr: input.cost_inr,
    decided_at: new Date().toISOString(),
  };

  audit.record(
    claim.id,
    'L4',
    'decision_made',
    { claim_id: claim.id, outcome, reason_codes, exposure_inr },
    {
      outcome,
      reason_codes,
      decision_basis,
      exposure_inr,
      category,
      applied_ceiling_inr: ceiling,
      above_ceiling: exposure_inr > ceiling,
      required_confidence: Number(required_confidence.toFixed(4)),
      observed_confidence: verdict?.confidence ?? null,
      supports_claim: verdict?.supports_claim ?? null,
      sku_match: verdict?.sku_match ?? null,
      internal_consistency: verdict?.internal_consistency ?? null,
      contradictions: verdict?.contradictions ?? [],
      // F9 audit flag - set whenever either defense layer saw an injection attempt.
      injection_suspected,
      injection_signals: sanitised.signals.map((s) => s.id),
      verifier_failure: verifier && !verifier.ok ? verifier.failure : null,
      verifier_absence: input.verifier_absence,
      model_version: decision.model_version,
      prompt_version: decision.prompt_version,
      policy_rules_fired,
      config_snapshot_id: config.snapshot_id,
      money_moved: false,
    },
  );

  return {
    decision,
    summary,
    decision_basis,
    injection_suspected,
    required_confidence,
    policy_rules_fired,
  };
}
