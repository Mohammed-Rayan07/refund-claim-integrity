/**
 * F12 - Confidence calibration and abstention (SPEC §3 F12, §8).
 *
 * Is a verdict returned at 0.8 confidence actually right about 80% of the time?
 * A verdict counts as correct when its direction agrees with ground truth:
 * `yes` on a claim that should be released, `no` on one that should be held.
 * Abstentions carry no direction, so they are excluded from the curve and
 * reported separately - a system that knows what it does not know is not
 * penalised as if it had guessed.
 */
import type { GroundTruth } from './fixtures/index.ts';
import type { PipelineResult } from '../layers/pipeline.ts';

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  correct: number;
  /** Mean stated confidence in this bin. */
  mean_confidence: number;
  /** Fraction actually correct. */
  observed_accuracy: number;
}

export interface Calibration {
  bins: CalibrationBin[];
  judged: number;
  abstained: number;
  /** Expected calibration error over the judged verdicts. */
  ece: number;
}

const BIN_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

export function calibrate(
  results: PipelineResult[],
  truth: Map<string, GroundTruth>,
): Calibration {
  interface Point {
    confidence: number;
    correct: boolean;
  }
  const points: Point[] = [];
  let abstained = 0;

  for (const r of results) {
    if (!r.verifier?.ok) continue;
    const v = r.verifier.verdict;
    if (v.supports_claim === 'insufficient') {
      abstained += 1;
      continue;
    }
    const gt = truth.get(r.claim.id);
    if (!gt) continue;
    const asserted: GroundTruth = v.supports_claim === 'yes' ? 'should_release' : 'should_hold';
    points.push({ confidence: v.confidence, correct: asserted === gt });
  }

  const bins: CalibrationBin[] = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i += 1) {
    const lower = BIN_EDGES[i]!;
    const upper = BIN_EDGES[i + 1]!;
    const inBin = points.filter((p) => p.confidence >= lower && p.confidence < upper);
    if (inBin.length === 0) continue;
    const correct = inBin.filter((p) => p.correct).length;
    bins.push({
      lower,
      upper: Math.min(upper, 1),
      count: inBin.length,
      correct,
      mean_confidence: inBin.reduce((sum, p) => sum + p.confidence, 0) / inBin.length,
      observed_accuracy: correct / inBin.length,
    });
  }

  const ece =
    points.length === 0
      ? 0
      : bins.reduce(
          (sum, b) => sum + (b.count / points.length) * Math.abs(b.mean_confidence - b.observed_accuracy),
          0,
        );

  return { bins, judged: points.length, abstained, ece };
}
