/**
 * Turns `eval/live-run.json` (written by `npm run eval:live`) into real metrics
 * and a markdown section, so `npm run eval` can splice honest LIVE numbers
 * alongside the existing MODE=mock routing table rather than reporting them
 * separately where they'd be easy to conflate.
 *
 * Every number in here comes from `records[]` - real model verdicts on real
 * FraudBench images, sent through the real pipeline with only the LLM adapter
 * widened (LLM_MODE=live). Nothing here is scripted. If `eval/live-run.json`
 * is absent, `loadLiveRun` returns null and the caller must say so explicitly -
 * this module never fabricates a placeholder run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LiveRun, LiveRunRecord } from './live_batch.ts';
import { buildHoldout } from './holdout.ts';
import { loadFraudBenchSubset } from './fraudbench/loader.ts';

const LIVE_RUN_PATH = 'eval/live-run.json';

export function loadLiveRun(): LiveRun | null {
  const path = resolve(process.cwd(), LIVE_RUN_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as LiveRun;
}

type SystemKey = 'B1 Rules' | 'B2 VLM (real)' | 'Ours (live)';

interface LiveFlag {
  flagged: boolean;
  abstained: boolean;
  model_call: boolean;
}

/** B1: order/payment checks only - identical definition to the mock baseline. */
function flagB1(r: LiveRunRecord): LiveFlag {
  return { flagged: !r.l1_passed, abstained: false, model_call: false };
}

/**
 * B2: the REAL "is this image AI-generated?" classifier (eval/vlm_baseline.ts),
 * run for real against the same images. `uncertain` is treated as an abstention
 * (a flag, since an uncertain authenticity check should not release money), not
 * a release - the mock projection in baselines.ts abstains to REVIEW too.
 */
function flagB2(r: LiveRunRecord): LiveFlag {
  const v = r.b2;
  if (!v || v.assessment === 'failed') return { flagged: true, abstained: true, model_call: true };
  if (v.assessment === 'uncertain') return { flagged: true, abstained: true, model_call: true };
  return { flagged: v.assessment === 'ai_generated', abstained: false, model_call: true };
}

function flagOurs(r: LiveRunRecord): LiveFlag {
  return {
    flagged: r.outcome !== 'APPROVE',
    abstained: r.supports_claim === 'insufficient' || r.decision_basis === 'verifier_abstained',
    model_call: r.model_call,
  };
}

const FLAGGERS: Record<SystemKey, (r: LiveRunRecord) => LiveFlag> = {
  'B1 Rules': flagB1,
  'B2 VLM (real)': flagB2,
  'Ours (live)': flagOurs,
};

export interface LiveMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  fpr: number;
  held_inr: number;
  wrongly_flagged_inr: number;
  abstention_rate: number;
  no_model_call_rate: number;
}

function scoreLive(records: LiveRunRecord[], flag: (r: LiveRunRecord) => LiveFlag): LiveMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0, held = 0, wrong = 0, abst = 0, noModel = 0;
  for (const r of records) {
    const f = flag(r);
    if (f.abstained) abst += 1;
    if (!f.model_call) noModel += 1;
    if (r.ground_truth === 'should_hold') {
      if (f.flagged) { tp += 1; held += r.amount_inr; } else { fn += 1; }
    } else if (f.flagged) {
      fp += 1; wrong += r.amount_inr;
    } else {
      tn += 1;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  return {
    tp, fp, fn, tn, precision, recall, fpr,
    held_inr: held,
    wrongly_flagged_inr: wrong,
    abstention_rate: records.length === 0 ? 0 : abst / records.length,
    no_model_call_rate: records.length === 0 ? 0 : noModel / records.length,
  };
}

export interface ConfidenceBin {
  lower: number;
  upper: number;
  count: number;
  correct: number;
  mean_confidence: number;
  observed_accuracy: number;
}

export interface ConfidenceStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stddev: number;
  bins: ConfidenceBin[];
  ece: number;
}

const BIN_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

/** Real confidence distribution + reliability curve over directional live verdicts. */
export function realConfidenceStats(records: LiveRunRecord[]): ConfidenceStats {
  const directional = records.filter(
    (r) => r.confidence !== null && r.supports_claim !== null && r.supports_claim !== 'insufficient',
  );
  const values = directional.map((r) => r.confidence!).sort((a, b) => a - b);
  const n = values.length;
  if (n === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, median: 0, stddev: 0, bins: [], ece: 0 };
  }
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 1 ? values[(n - 1) / 2]! : (values[n / 2 - 1]! + values[n / 2]!) / 2;
  const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);

  const points = directional.map((r) => ({
    confidence: r.confidence!,
    correct:
      (r.supports_claim === 'yes' ? 'should_release' : 'should_hold') === r.ground_truth,
  }));
  const bins: ConfidenceBin[] = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i += 1) {
    const lower = BIN_EDGES[i]!;
    const upper = BIN_EDGES[i + 1]!;
    const inBin = points.filter((p) => p.confidence >= lower && p.confidence < upper);
    if (inBin.length === 0) continue;
    const correct = inBin.filter((p) => p.correct).length;
    bins.push({
      lower, upper: Math.min(upper, 1), count: inBin.length, correct,
      mean_confidence: inBin.reduce((s, p) => s + p.confidence, 0) / inBin.length,
      observed_accuracy: correct / inBin.length,
    });
  }
  const ece = bins.reduce((s, b) => s + (b.count / n) * Math.abs(b.mean_confidence - b.observed_accuracy), 0);

  return { n, min: values[0]!, max: values[n - 1]!, mean, median, stddev, bins, ece };
}

export interface HoldoutRecall {
  evaluable: boolean;
  seen: string[];
  unseen: string[];
  note: string;
  recall_by_system: Record<SystemKey, { seen_recall: number; unseen_recall: number; seen_n: number; unseen_n: number }>;
}

/** F10 on the LIVE `ai_edited_damage` claims: real recall, split by real generator. */
export function realHoldoutRecall(records: LiveRunRecord[]): HoldoutRecall {
  const subset = loadFraudBenchSubset();
  const holdout = buildHoldout(subset);
  const fakes = records.filter((r) => r.scenario === 'ai_edited_damage');

  const recallFor = (system: SystemKey, generators: string[]): { recall: number; n: number } => {
    const group = fakes.filter((r) => {
      const gen = r.provenance[0]?.generator ?? null;
      return gen !== null && generators.includes(gen);
    });
    if (group.length === 0) return { recall: 0, n: 0 };
    const caught = group.filter((r) => FLAGGERS[system](r).flagged).length;
    return { recall: caught / group.length, n: group.length };
  };

  const recall_by_system = {} as HoldoutRecall['recall_by_system'];
  for (const system of Object.keys(FLAGGERS) as SystemKey[]) {
    const seen = recallFor(system, holdout.seen);
    const unseen = recallFor(system, holdout.unseen);
    recall_by_system[system] = {
      seen_recall: seen.recall, seen_n: seen.n,
      unseen_recall: unseen.recall, unseen_n: unseen.n,
    };
  }

  return { evaluable: holdout.evaluable && fakes.length > 0, seen: holdout.seen, unseen: holdout.unseen, note: holdout.note, recall_by_system };
}

export interface InjectionResult {
  total: number;
  by_system: Record<SystemKey, { resisted: number; resistance: number }>;
}

export function realInjectionResistance(records: LiveRunRecord[]): InjectionResult {
  const attempts = records.filter((r) => r.scenario === 'injection_attempt');
  const by_system = {} as InjectionResult['by_system'];
  for (const system of Object.keys(FLAGGERS) as SystemKey[]) {
    const resisted = attempts.filter((r) => FLAGGERS[system](r).flagged).length;
    by_system[system] = { resisted, resistance: attempts.length === 0 ? 0 : resisted / attempts.length };
  }
  return { total: attempts.length, by_system };
}

export interface LiveMetricsBundle {
  run: LiveRun;
  metrics: Record<SystemKey, LiveMetrics>;
  confidence: ConfidenceStats;
  holdout: HoldoutRecall;
  injection: InjectionResult;
  scenarios: Array<{ scenario: string; n: number; should_hold: number; should_release: number }>;
  totalCostInr: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  bytesVerified: number;
  falsePositives: LiveRunRecord[];
  falseNegatives: LiveRunRecord[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function computeLiveMetrics(run: LiveRun): LiveMetricsBundle {
  const records = run.records;
  const metrics = {} as Record<SystemKey, LiveMetrics>;
  for (const system of Object.keys(FLAGGERS) as SystemKey[]) {
    metrics[system] = scoreLive(records, FLAGGERS[system]);
  }

  const scenarioNames = [...new Set(records.map((r) => r.scenario))].sort();
  const scenarios = scenarioNames.map((scenario) => {
    const group = records.filter((r) => r.scenario === scenario);
    return {
      scenario,
      n: group.length,
      should_hold: group.filter((r) => r.ground_truth === 'should_hold').length,
      should_release: group.filter((r) => r.ground_truth === 'should_release').length,
    };
  });

  const latencies = records.map((r) => r.latency_ms);
  const modelRecords = records.filter((r) => r.model_call);

  return {
    run,
    metrics,
    confidence: realConfidenceStats(records),
    holdout: realHoldoutRecall(records),
    injection: realInjectionResistance(records),
    scenarios,
    totalCostInr: records.reduce((s, r) => s + r.cost_inr, 0),
    totalInputTokens: records.reduce((s, r) => s + r.input_tokens, 0),
    totalOutputTokens: records.reduce((s, r) => s + r.output_tokens, 0),
    meanLatencyMs: latencies.length === 0 ? 0 : latencies.reduce((s, v) => s + v, 0) / latencies.length,
    p95LatencyMs: percentile(latencies, 95),
    bytesVerified: modelRecords.filter((r) => r.saw_image_bytes).length,
    falsePositives: records.filter((r) => r.ground_truth === 'should_release' && r.outcome !== 'APPROVE'),
    falseNegatives: records.filter((r) => r.ground_truth === 'should_hold' && r.outcome === 'APPROVE'),
  };
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Markdown for the top of the report. Every line here describes real data. */
export function renderLiveMarkdown(bundle: LiveMetricsBundle): string[] {
  const { run, metrics, confidence, holdout, injection, scenarios } = bundle;
  const L: string[] = [];

  L.push('## LIVE verifier run (LLM_MODE=live) — real model, real FraudBench images');
  L.push('');
  L.push(
    '**Every number in this section comes from a real Anthropic API call against a real ' +
      'FraudBench image.** `MODE` stayed `mock` throughout - payments, store and notifier are ' +
      'still mock adapters - only the L3 verifier (and the B2 baseline, which reuses the same ' +
      'live adapter) went through `LLM_MODE=live`. The routing table further down this document ' +
      '(headed "MODE=mock") is the OTHER run: scripted verifier verdicts over synthetic business ' +
      'fixtures, which tests the decision ladder, not detection. The two never share a row.',
  );
  L.push('');
  L.push(
    `Run: model \`${run.model}\`, effort \`${run.effort}\`, ${run.records.length} claims, ` +
      `${bundle.bytesVerified}/${run.records.filter((r) => r.model_call).length} verified claims sent real image bytes ` +
      `(the run aborts and writes nothing if any claim was verified on a reference alone). ` +
      `Dataset sha \`${run.dataset_sha?.slice(0, 12) ?? 'unknown'}\`, fetched ${run.fetched_at ?? 'unknown'}. ` +
      `Generated ${run.generated_at}.`,
  );
  L.push('');
  if (run.excluded.length > 0 || run.excluded_claims.length > 0) {
    L.push(
      `${run.excluded.length} benchmark samples and ${run.excluded_claims.length} claims were excluded ` +
        'before scoring (short/missing text, evidence too large to transport) - listed at the end of this section, never silently dropped.',
    );
    L.push('');
  }

  L.push('| Metric | B1 Rules | B2 VLM (real) | Ours (live) |');
  L.push('|---|---|---|---|');
  const row = (label: string, pick: (m: LiveMetrics) => string): void => {
    L.push(`| ${label} | ${pick(metrics['B1 Rules'])} | ${pick(metrics['B2 VLM (real)'])} | ${pick(metrics['Ours (live)'])} |`);
  };
  row('Precision', (m) => m.precision.toFixed(3));
  row('Recall', (m) => m.recall.toFixed(3));
  row('**False-positive rate**', (m) => `**${pct(m.fpr)}**`);
  row('₹ exposure correctly held', (m) => inr(m.held_inr));
  row('**₹ legitimate refunds wrongly flagged**', (m) => `**${inr(m.wrongly_flagged_inr)}**`);
  row('Abstention rate', (m) => pct(m.abstention_rate));
  if (holdout.evaluable) {
    L.push(
      `| Unseen-generator recall (F10) | ${pct(holdout.recall_by_system['B1 Rules'].unseen_recall)} ` +
        `(n=${holdout.recall_by_system['B1 Rules'].unseen_n}) | ` +
        `${pct(holdout.recall_by_system['B2 VLM (real)'].unseen_recall)} (n=${holdout.recall_by_system['B2 VLM (real)'].unseen_n}) | ` +
        `${pct(holdout.recall_by_system['Ours (live)'].unseen_recall)} (n=${holdout.recall_by_system['Ours (live)'].unseen_n}) |`,
    );
  } else {
    L.push(`| Unseen-generator recall (F10) | n/a | n/a | n/a |`);
  }
  L.push(
    `| Injection resistance (F9) | ${pct(injection.by_system['B1 Rules'].resistance)} | ` +
      `${pct(injection.by_system['B2 VLM (real)'].resistance)} | ` +
      `${pct(injection.by_system['Ours (live)'].resistance)} | (n=${injection.total}, real attack strings on real photos, sent to the real model)`,
  );
  row('% resolved without a model call (F17)', (m) => pct(m.no_model_call_rate));
  L.push(
    `| Mean cost/claim, p95 latency | — | — | ₹${(bundle.totalCostInr / run.records.length).toFixed(3)}, ${bundle.p95LatencyMs.toFixed(0)} ms |`,
  );
  L.push('');
  L.push(
    `Total live spend: ${bundle.totalInputTokens} input + ${bundle.totalOutputTokens} output tokens, ` +
      `${inr(bundle.totalCostInr)} at the configured prices (\`shared/config/thresholds.json\`) — ` +
      'B1 makes no model call; B2\'s cost is not separately metered here and is folded into the total above.',
  );
  L.push('');
  if (!holdout.evaluable) {
    L.push(`Unseen-generator recall is \`n/a\`: ${holdout.note}, or this batch has no \`ai_edited_damage\` claims.`);
    L.push('');
  } else {
    L.push(
      `F10 split: seen generators \`${holdout.seen.join(', ')}\`, held out \`${holdout.unseen.join(', ')}\` ` +
        '(deterministic, alternating by generator name — never chosen to flatter a result).',
    );
    L.push('');
  }

  // ---- real confidence distribution ----
  L.push('### Real confidence distribution');
  L.push('');
  if (confidence.n === 0) {
    L.push('No directional live verdicts to report.');
  } else {
    L.push(
      `${confidence.n} directional verdicts (abstentions excluded) — ` +
        `min ${confidence.min.toFixed(2)}, mean ${confidence.mean.toFixed(2)}, median ${confidence.median.toFixed(2)}, ` +
        `max ${confidence.max.toFixed(2)}, stddev ${confidence.stddev.toFixed(2)}. ECE ${confidence.ece.toFixed(3)}.`,
    );
    L.push('');
    L.push('| Confidence bin | n | Mean stated | Observed accuracy |');
    L.push('|---|---|---|---|');
    for (const b of confidence.bins) {
      L.push(`| ${b.lower.toFixed(2)}–${b.upper.toFixed(2)} | ${b.count} | ${b.mean_confidence.toFixed(3)} | ${b.observed_accuracy.toFixed(3)} |`);
    }
  }
  L.push('');

  // ---- scenario breakdown ----
  L.push('### Live case classes');
  L.push('');
  L.push('| Class | Claims | should_hold | should_release |');
  L.push('|---|---|---|---|');
  for (const s of scenarios) {
    L.push(`| ${s.scenario} | ${s.n} | ${s.should_hold} | ${s.should_release} |`);
  }
  L.push('');

  // ---- where the live run fails ----
  L.push('### Where the live run fails');
  L.push('');
  L.push(
    `**${bundle.falsePositives.length} legitimate live claims flagged** ` +
      `(${inr(metrics['Ours (live)'].wrongly_flagged_inr)} delayed) and ` +
      `**${bundle.falseNegatives.length} invalid live claims approved**.`,
  );
  L.push('');
  if (bundle.falsePositives.length > 0) {
    L.push('| Claim | Class | Outcome | ₹ | Why |');
    L.push('|---|---|---|---|---|');
    for (const r of bundle.falsePositives) {
      L.push(`| ${r.claim_id} | ${r.scenario} | ${r.outcome} | ${r.amount_inr} | ${r.summary.replace(/\|/g, '\\|').slice(0, 110)} |`);
    }
    L.push('');
  }
  if (bundle.falseNegatives.length > 0) {
    L.push('| Claim | Class | ₹ | Why it slipped through |');
    L.push('|---|---|---|---|');
    for (const r of bundle.falseNegatives) {
      L.push(`| ${r.claim_id} | ${r.scenario} | ${r.amount_inr} | ${r.summary.replace(/\|/g, '\\|').slice(0, 110)} |`);
    }
    L.push('');
  }

  if (run.excluded.length > 0) {
    L.push('### Excluded before scoring');
    L.push('');
    for (const e of run.excluded) L.push(`- \`${e.sample_id}\`: ${e.reason}`);
    L.push('');
  }
  if (run.excluded_claims.length > 0) {
    for (const e of run.excluded_claims) L.push(`- \`${e.claim_id}\`: ${e.reason}`);
    L.push('');
  }

  return L;
}
