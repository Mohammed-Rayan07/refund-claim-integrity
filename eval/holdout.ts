/**
 * F10 - Unseen-generator holdout (SPEC §3 F10, §8).
 *
 * FraudBench's headline finding is that detectors are inconsistent ACROSS
 * generators, so the honest measurement is: tune on some generators, evaluate on
 * generators the system has never seen.
 *
 * That split is only meaningful with the benchmark present. With no local subset
 * this module reports `not evaluable` and the report emits n/a - it never
 * substitutes a synthetic number for a missing dataset.
 */
import type { FraudBenchSubset } from './fraudbench/loader.ts';

export interface HoldoutSplit {
  evaluable: boolean;
  /** Generators used for tuning. */
  seen: string[];
  /** Generators held out entirely. */
  unseen: string[];
  seen_samples: number;
  unseen_samples: number;
  note: string;
}

/**
 * Splits generators deterministically: sorted by name, every other one held out,
 * so the split does not depend on which generators happen to be most numerous.
 */
export function buildHoldout(subset: FraudBenchSubset): HoldoutSplit {
  if (subset.generators.length < 2) {
    return {
      evaluable: false,
      seen: subset.generators,
      unseen: [],
      seen_samples: 0,
      unseen_samples: 0,
      note:
        subset.samples.length === 0
          ? 'no FraudBench subset present - unseen-generator recall is not evaluable'
          : `only ${subset.generators.length} generator(s) present - a holdout needs at least 2`,
    };
  }

  const sorted = [...subset.generators].sort();
  const seen = sorted.filter((_, i) => i % 2 === 0);
  const unseen = sorted.filter((_, i) => i % 2 === 1);
  const count = (list: string[]): number =>
    subset.samples.filter((s) => s.generator !== null && list.includes(s.generator)).length;

  return {
    evaluable: true,
    seen,
    unseen,
    seen_samples: count(seen),
    unseen_samples: count(unseen),
    note: `${unseen.length} of ${sorted.length} generators held out`,
  };
}
