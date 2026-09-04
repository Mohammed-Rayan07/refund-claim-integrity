/**
 * L4 - Decision Engine (SPEC §7 "L4 Decision Engine"). Deterministic code, NOT an LLM.
 *
 * CHUNK 1 SCOPE: the branches whose inputs exist in the spine - L1 hard failure,
 * verifier availability (fail-safe), and the policy exposure ceiling. The reuse
 * (L2) and verifier-verdict (L3) branches of the §7 ladder arrive with Chunk 2/3.
 *
 * MONEY SAFETY (SPEC §0 / §3 F4): this module returns one of three labels. It
 * has no reference to any adapter that could move funds, and DENY_RECOMMEND is a
 * recommendation routed to a human - never an executed denial.
 */
import { randomUUID } from 'node:crypto';
import { ceilingForCategory, type LoadedConfig } from '../../shared/config/index.ts';
import type { AuditLogger } from '../../shared/lib/logger.ts';
import type { ReasonCode } from '../../shared/lib/reasoncodes.ts';
import type { Claim, Decision, Outcome } from '../../shared/types.ts';
import type { IntegrityGateResult } from '../L1-deterministic/index.ts';

/** Why the verifier did not produce a verdict. Chunk 1 is always `unavailable`. */
export type VerifierAbsence = 'unavailable';

export interface DecisionInput {
  claim: Claim;
  gate: IntegrityGateResult;
  /** Null whenever L3 produced no usable verdict - forces the fail-safe path. */
  verifier: null;
  verifier_absence: VerifierAbsence;
  latency_ms: number;
}

export interface DecisionDeps {
  config: LoadedConfig;
  audit: AuditLogger;
}

export interface DecisionResult {
  decision: Decision;
  /** Human-readable one-liner for the review queue and the demo output. */
  summary: string;
  policy_rules_fired: string[];
}

/**
 * §7: threshold = base_threshold + (exposure / auto_approve_ceiling) * scaling_factor
 * The larger the rupee exposure, the more confident the verifier must be. Capped so
 * a very large claim cannot demand an unreachable confidence.
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
  const { claim, gate } = input;
  const { config, audit } = deps;

  const exposure_inr = claim.amount_inr;
  const category = gate.line_item?.category ?? null;
  const ceiling = ceilingForCategory(config.policy, category);
  const required_confidence = confidenceThresholdFor(exposure_inr, ceiling, config);
  const above_ceiling = exposure_inr > ceiling;

  let outcome: Outcome;
  let reason_codes: ReasonCode[];
  let summary: string;
  const policy_rules_fired: string[] = [];

  if (!gate.passed) {
    // Deterministic hard failure - explainable without any model.
    outcome = 'DENY_RECOMMEND';
    reason_codes = gate.reason_codes;
    const failed = gate.checks.find((c) => c.status === 'fail');
    summary = `L1 ${gate.failed_check}: ${failed?.detail ?? 'integrity check failed'}`;
  } else {
    // Fail-safe (F11): no verifier verdict means we never assert the claim is
    // supported. Route to a human rather than silently approving.
    outcome = 'REVIEW';
    reason_codes = ['RCI-11'];
    policy_rules_fired.push('PR-03');
    summary = `L1 clean; verifier ${input.verifier_absence} - routed to human review`;
    if (above_ceiling) {
      policy_rules_fired.push('PR-01');
      summary += ` (exposure INR ${exposure_inr} above ceiling INR ${ceiling})`;
    }
  }

  const decision: Decision = {
    id: `DEC_${randomUUID()}`,
    claim_id: claim.id,
    outcome,
    reason_codes,
    confidence: null,
    exposure_inr,
    model_version: null,
    prompt_version: null,
    config_snapshot_id: config.snapshot_id,
    latency_ms: input.latency_ms,
    cost_inr: 0,
    decided_at: new Date().toISOString(),
  };

  audit.record(
    claim.id,
    'L4',
    'decision_made',
    {
      claim_id: claim.id,
      outcome,
      reason_codes,
      exposure_inr,
    },
    {
      outcome,
      reason_codes,
      exposure_inr,
      category,
      applied_ceiling_inr: ceiling,
      above_ceiling,
      required_confidence: Number(required_confidence.toFixed(4)),
      verifier_absence: input.verifier_absence,
      policy_rules_fired,
      config_snapshot_id: config.snapshot_id,
      money_moved: false,
    },
  );

  return { decision, summary, policy_rules_fired };
}
