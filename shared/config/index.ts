/**
 * Config loader. No business value is hardcoded anywhere in the codebase —
 * every threshold, ceiling and window is read from here.
 *
 * A config snapshot id is derived from the loaded content so that every Decision
 * can be tied back to the exact config that produced it (SPEC §6, F6).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Policy, Thresholds } from '../types.ts';

const DEFAULT_POLICY_PATH = 'shared/config/policy.example.json';
const DEFAULT_THRESHOLDS_PATH = 'shared/config/thresholds.json';

export interface LoadedConfig {
  policy: Policy;
  thresholds: Thresholds;
  snapshot_id: string;
}

function readJson<T>(path: string): { value: T; raw: string } {
  const raw = readFileSync(resolve(process.cwd(), path), 'utf8');
  return { value: JSON.parse(raw) as T, raw };
}

/**
 * F14 - "the agent never invents a policy; anything not configured escalates."
 *
 * L4 (layers/L4-decision/index.ts) fires these policy-rule ids when their
 * condition is met. This is the other half of that promise made checkable:
 * every id the code can fire must be declared in the merchant's own policy
 * file, or the config is rejected at load time rather than silently applying
 * a rule the merchant never configured.
 */
const POLICY_RULES_CODE_CAN_FIRE = ['PR-01', 'PR-02', 'PR-03'] as const;

function assertPolicyRulesDeclared(policy: Policy, policyPath: string): void {
  const declared = new Set(policy.review_rules.map((r) => r.id));
  const missing = POLICY_RULES_CODE_CAN_FIRE.filter((id) => !declared.has(id));
  if (missing.length > 0) {
    throw new Error(
      `policy config is missing review_rules for [${missing.join(', ')}] - L4 can fire these ` +
        `ids and the merchant must declare them explicitly. Add them to review_rules in ${policyPath}.`,
    );
  }
}

let cached: LoadedConfig | null = null;

export function loadConfig(): LoadedConfig {
  if (cached) return cached;

  const policyPath = process.env.RCIE_POLICY_PATH ?? DEFAULT_POLICY_PATH;
  const thresholdsPath = process.env.RCIE_THRESHOLDS_PATH ?? DEFAULT_THRESHOLDS_PATH;

  const policy = readJson<Policy>(policyPath);
  const thresholds = readJson<Thresholds>(thresholdsPath);
  assertPolicyRulesDeclared(policy.value, policyPath);

  const snapshot_id = createHash('sha256')
    .update(policy.raw)
    .update('\u0000')
    .update(thresholds.raw)
    .digest('hex')
    .slice(0, 16);

  cached = { policy: policy.value, thresholds: thresholds.value, snapshot_id };
  return cached;
}

/**
 * The auto-approve ceiling that applies to a given product category, falling
 * back to the merchant-level ceiling when there is no override.
 */
export function ceilingForCategory(policy: Policy, category: string | null): number {
  if (category) {
    const override = policy.category_overrides[category];
    if (override) return override.auto_approve_ceiling;
  }
  return policy.auto_approve_ceiling;
}
