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

let cached: LoadedConfig | null = null;

export function loadConfig(): LoadedConfig {
  if (cached) return cached;

  const policyPath = process.env.RCIE_POLICY_PATH ?? DEFAULT_POLICY_PATH;
  const thresholdsPath = process.env.RCIE_THRESHOLDS_PATH ?? DEFAULT_THRESHOLDS_PATH;

  const policy = readJson<Policy>(policyPath);
  const thresholds = readJson<Thresholds>(thresholdsPath);

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
