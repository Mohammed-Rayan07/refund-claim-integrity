/**
 * F17 - Per-claim latency and cost budget (SPEC §3 F17).
 *
 * The deterministic gate resolves the cheap majority before any model call, so
 * the number that matters is not just mean cost - it is what fraction of claims
 * never needed the model at all.
 *
 * Token prices live in config (`thresholds.budget`) and ship as placeholders:
 * cost figures are only as honest as the prices they are computed from.
 */
import type { LoadedConfig } from '../config/index.ts';

export interface ModelSpend {
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export const NO_SPEND: ModelSpend = { input_tokens: 0, output_tokens: 0, calls: 0 };

export function costOf(spend: ModelSpend, config: LoadedConfig): number {
  const b = config.thresholds.budget;
  return (
    (spend.input_tokens / 1000) * b.input_inr_per_1k_tokens +
    (spend.output_tokens / 1000) * b.output_inr_per_1k_tokens
  );
}

export interface BudgetVerdict {
  cost_inr: number;
  over_cost_budget: boolean;
  over_latency_budget: boolean;
}

/**
 * Reports whether a claim exceeded its budget. Exceeding it is a signal for the
 * operator, never a reason to decide differently - a decision is never cheapened
 * because the claim was expensive.
 */
export function assess(
  spend: ModelSpend,
  latency_ms: number,
  config: LoadedConfig,
): BudgetVerdict {
  const b = config.thresholds.budget;
  const cost_inr = costOf(spend, config);
  return {
    cost_inr,
    over_cost_budget: cost_inr > b.max_cost_inr_per_claim,
    over_latency_budget: latency_ms > b.max_latency_ms_per_claim,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
