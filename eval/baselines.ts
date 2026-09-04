/**
 * Baselines B1 and B2 (SPEC §8).
 *
 * Both are PROJECTIONS of the same pipeline run, not separately scripted systems.
 * Inventing a competitor's responses in order to beat them would prove nothing, so
 * each baseline is defined by what it structurally cannot see:
 *
 *   B1 rules-only : order/payment checks only. No evidence signal at all, so every
 *                   claim that clears L1 is approved.
 *   B2 VLM-only   : the evidence verdict only ("does this image hold up?"), with no
 *                   order context and no cross-claim history. It is therefore blind
 *                   to SKU mismatch, duplicates, expired windows, velocity, amount
 *                   overruns and evidence reuse - it approves all of them.
 *
 * Ours is the actual pipeline outcome.
 */
import type { Outcome } from '../shared/types.ts';
import type { PipelineResult } from '../layers/pipeline.ts';

export type SystemName = 'B1 Rules' | 'B2 VLM' | 'Ours';

export interface Projection {
  outcome: Outcome;
  /** True when the system declined to judge rather than guessing. */
  abstained: boolean;
  /** True when this claim cost a model call under that system. */
  model_call: boolean;
}

/** B1: L1 decides, nothing else exists. */
export function projectB1(r: PipelineResult): Projection {
  const failedGate = r.gate !== null && !r.gate.passed;
  return {
    outcome: failedGate ? 'DENY_RECOMMEND' : 'APPROVE',
    abstained: false,
    model_call: false,
  };
}

/**
 * B2: judges the evidence alone.
 *
 * Every L1 dimension is invisible to it, so a claim that only L1 could have caught
 * is approved. Where a verdict exists it is used directly; `injection_suspected` is
 * ignored because an authenticity detector has no such notion.
 */
export function projectB2(r: PipelineResult): Projection {
  const failedGate = r.gate !== null && !r.gate.passed;
  if (failedGate) {
    // Structurally blind: no order context, so nothing here to detect.
    return { outcome: 'APPROVE', abstained: false, model_call: true };
  }

  if (r.verifier === null) {
    // L2 settled this claim before the verifier ran; B2 has no reuse detection,
    // so it falls back to what an authenticity check would say - nothing wrong.
    return { outcome: 'APPROVE', abstained: false, model_call: true };
  }
  if (!r.verifier.ok) {
    return { outcome: 'REVIEW', abstained: true, model_call: true };
  }

  const supports = r.verifier.verdict.supports_claim;
  if (supports === 'no') return { outcome: 'DENY_RECOMMEND', abstained: false, model_call: true };
  if (supports === 'insufficient') return { outcome: 'REVIEW', abstained: true, model_call: true };
  return { outcome: 'APPROVE', abstained: false, model_call: true };
}

export function projectOurs(r: PipelineResult): Projection {
  const abstained =
    (r.verifier?.ok === true && r.verifier.verdict.supports_claim === 'insufficient') ||
    r.decision_basis === 'verifier_abstained';
  return {
    outcome: r.decision.outcome,
    abstained,
    model_call: !r.resolved_without_model_call,
  };
}

export const SYSTEMS: Array<{ name: SystemName; project: (r: PipelineResult) => Projection }> = [
  { name: 'B1 Rules', project: projectB1 },
  { name: 'B2 VLM', project: projectB2 },
  { name: 'Ours', project: projectOurs },
];
