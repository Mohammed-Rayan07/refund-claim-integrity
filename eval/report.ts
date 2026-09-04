/**
 * npm run eval
 *
 * Runs the batch once through the real pipeline, projects B1 and B2 from the same
 * run, and emits the SPEC §8 results table as markdown (stdout + eval/RESULTS.md).
 *
 * Read the caveat block it prints. In MODE=mock the verifier's verdicts come from
 * scripted fixtures, so these numbers verify that the decision ladder ROUTES
 * correctly - they are not measurements of detection accuracy.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentMode } from '../shared/mode.ts';
import { loadConfig } from '../shared/config/index.ts';
import { createPaymentsAdapter } from '../shared/adapters/payments.ts';
import { createStoreAdapter } from '../shared/adapters/store.ts';
import { createNotifierAdapter } from '../shared/adapters/notifier.ts';
import { createMockLlmAdapter } from '../shared/adapters/llm.ts';
import { costOf, percentile } from '../shared/lib/budget.ts';
import { createPipeline, type PipelineResult } from '../layers/pipeline.ts';
import { buildFixtures, UNSCRIPTED_FALLBACK, type FixtureCase, type GroundTruth } from './fixtures/index.ts';
import { loadFraudBenchSubset } from './fraudbench/loader.ts';
import { SYSTEMS, type Projection, type SystemName } from './baselines.ts';
import { buildHoldout } from './holdout.ts';
import { calibrate } from './calibration.ts';
import { scoreInjection } from './injection_suite.ts';

const MODEL_VERSION = 'claude-opus-5-mock';

interface Metrics {
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

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}
/** Small rupee amounts need decimals or every model-cost figure reads as zero. */
function inrPrecise(n: number): string {
  return `₹${n.toFixed(3)}`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function score(
  results: PipelineResult[],
  truth: Map<string, GroundTruth>,
  project: (r: PipelineResult) => Projection,
): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let held = 0;
  let wrong = 0;
  let abstentions = 0;
  let noModel = 0;

  for (const r of results) {
    const gt = truth.get(r.claim.id);
    if (!gt) continue;
    const p = project(r);
    // "Flagged" = not auto-approved. A REVIEW still costs a legitimate customer
    // their instant refund, so §8's false-positive row counts it as a flag.
    const flagged = p.outcome !== 'APPROVE';
    if (p.abstained) abstentions += 1;
    if (!p.model_call) noModel += 1;

    if (gt === 'should_hold') {
      if (flagged) {
        tp += 1;
        held += r.claim.amount_inr;
      } else {
        fn += 1;
      }
    } else if (flagged) {
      fp += 1;
      wrong += r.claim.amount_inr;
    } else {
      tn += 1;
    }
  }

  return {
    tp,
    fp,
    fn,
    tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    fpr: ratio(fp, fp + tn),
    held_inr: held,
    wrongly_flagged_inr: wrong,
    abstention_rate: ratio(abstentions, results.length),
    no_model_call_rate: ratio(noModel, results.length),
  };
}

async function main(): Promise<void> {
  const mode = currentMode();
  const config = loadConfig();
  const fraudbench = loadFraudBenchSubset();
  const fixtures = buildFixtures(fraudbench);
  const caseById = new Map<string, FixtureCase>(fixtures.cases.map((c) => [c.claim_id, c]));
  const truth = new Map<string, GroundTruth>(fixtures.cases.map((c) => [c.claim_id, c.ground_truth]));

  const payments = createPaymentsAdapter({ orders: fixtures.orders, payments: fixtures.payments });
  const store = createStoreAdapter({ claims: fixtures.claims, evidence: fixtures.evidence });
  const notifier = createNotifierAdapter();
  const llm = createMockLlmAdapter({
    script: new Map(fixtures.cases.map((c) => [c.claim_id, c.verifier_script])),
    fallback: UNSCRIPTED_FALLBACK,
    model_version: MODEL_VERSION,
  });
  const pipeline = createPipeline({
    payments,
    store,
    notifier,
    llm,
    config,
    catalogue: fixtures.catalogue,
    shared_index: fixtures.shared_index,
  });

  const results: PipelineResult[] = [];
  for (const claim of await store.listClaims()) {
    results.push(await pipeline.resolve(claim));
  }

  const metrics = new Map<SystemName, Metrics>();
  for (const sys of SYSTEMS) metrics.set(sys.name, score(results, truth, sys.project));

  const holdout = buildHoldout(fraudbench);
  const calibration = calibrate(results, truth);

  const injectionByName = new Map<SystemName, ReturnType<typeof scoreInjection>>();
  for (const sys of SYSTEMS) {
    const cases = results
      .filter((r) => caseById.get(r.claim.id)?.scenario === 'injection_attempt')
      .map((r) => ({ result: r, projection: sys.project(r) }));
    injectionByName.set(sys.name, scoreInjection(cases));
  }

  const latencies = results.map((r) => r.decision.latency_ms);
  const totalCost = results.reduce((sum, r) => sum + costOf(r.spend, config), 0);
  const totalCalls = results.reduce((sum, r) => sum + r.spend.calls, 0);
  const costPerCall = totalCalls === 0 ? 0 : totalCost / totalCalls;
  const p95 = percentile(latencies, 95);

  /**
   * Cost per claim for a projected system. Ours is measured directly; B1 makes no
   * model call, and B2 calls the model on every claim, so its cost is the measured
   * per-call cost times its own call count.
   */
  const systemCost = (name: SystemName): number => {
    if (name === 'Ours') return totalCost / results.length;
    const calls = results.filter((r) => {
      const sys = SYSTEMS.find((x) => x.name === name);
      return sys ? sys.project(r).model_call : false;
    }).length;
    return (calls * costPerCall) / results.length;
  };

  // ------------------------------------------------------------------ markdown
  const L: string[] = [];
  const row = (label: string, pick: (m: Metrics) => string): void => {
    L.push(
      `| ${label} | ${pick(metrics.get('B1 Rules')!)} | ${pick(metrics.get('B2 VLM')!)} | ${pick(metrics.get('Ours')!)} |`,
    );
  };

  L.push('# RCIE evaluation');
  L.push('');
  L.push(
    `Generated ${new Date().toISOString()} · MODE=\`${mode}\` · config snapshot \`${config.snapshot_id}\` · ` +
      `${results.length} claims`,
  );
  L.push('');
  L.push('## Pipeline behaviour on scripted fixtures (MODE=mock)');
  L.push('');
  L.push(
    '**These are not detection-accuracy numbers.** In `MODE=mock` every verifier verdict comes ' +
      'from a scripted fixture response, so the table below measures whether the decision ladder ' +
      '*routes* each case correctly - not whether a model can tell real damage from fabricated ' +
      'damage. Real detection numbers require `MODE=live` against a model plus the FraudBench ' +
      'subset, and rows that depend on that subset are reported as `n/a` rather than computed.',
  );
  L.push('');
  L.push(
    '`B1 Rules` and `B2 VLM` are structural **projections of this same run**, not separately ' +
      'scripted systems: B1 sees only the L1 order/payment checks, B2 sees only the evidence ' +
      'verdict and is blind to every order-context and cross-claim dimension. Neither was tuned ' +
      'to lose.',
  );
  L.push('');
  L.push(
    '"Flagged" means **not auto-approved** - a REVIEW counts as a flag, because a legitimate ' +
      'customer still loses their instant refund. Positive class = the claim should be held.',
  );
  L.push('');
  L.push('| Metric | B1 Rules | B2 VLM | Ours |');
  L.push('|---|---|---|---|');
  row('Precision', (m) => m.precision.toFixed(3));
  row('Recall', (m) => m.recall.toFixed(3));
  row('**False-positive rate**', (m) => `**${pct(m.fpr)}**`);
  row('₹ exposure correctly held', (m) => inr(m.held_inr));
  row('**₹ legitimate refunds wrongly flagged**', (m) => `**${inr(m.wrongly_flagged_inr)}**`);
  row('Abstention rate', (m) => pct(m.abstention_rate));
  L.push(
    `| Unseen-generator recall (F10) | n/a | n/a | n/a |`,
  );
  L.push(
    `| Injection resistance (F9) | ${pct(injectionByName.get('B1 Rules')!.resistance)} | ` +
      `${pct(injectionByName.get('B2 VLM')!.resistance)} | ` +
      `${pct(injectionByName.get('Ours')!.resistance)} |`,
  );
  row('% resolved without a model call (F17)', (m) => pct(m.no_model_call_rate));
  L.push(
    `| Mean cost/claim, p95 latency | ${inrPrecise(systemCost('B1 Rules'))}, 0 ms | ` +
      `${inrPrecise(systemCost('B2 VLM'))}, ${p95} ms | ` +
      `${inrPrecise(systemCost('Ours'))}, ${p95} ms |`,
  );
  L.push('');
  L.push(
    `Unseen-generator recall is \`n/a\`: ${holdout.note}. ` +
      'Cost uses the placeholder token prices in `shared/config/thresholds.json`; latency is ' +
      'mock-run wall clock and says nothing about live model latency.',
  );
  L.push('');

  // ---- confusion detail ----
  L.push('## Confusion detail');
  L.push('');
  L.push('| System | TP | FP | FN | TN |');
  L.push('|---|---|---|---|---|');
  for (const sys of SYSTEMS) {
    const m = metrics.get(sys.name)!;
    L.push(`| ${sys.name} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} |`);
  }
  L.push('');

  // ---- case classes ----
  L.push('## Case classes in the batch');
  L.push('');
  L.push('| Class | Claims | should_hold | should_release |');
  L.push('|---|---|---|---|');
  const scenarios = [...new Set(fixtures.cases.map((c) => c.scenario))].sort();
  for (const scenario of scenarios) {
    const group = fixtures.cases.filter((c) => c.scenario === scenario);
    L.push(
      `| ${scenario} | ${group.length} | ${group.filter((c) => c.ground_truth === 'should_hold').length} | ` +
        `${group.filter((c) => c.ground_truth === 'should_release').length} |`,
    );
  }
  L.push('');
  L.push(
    `AI-edited damage (FraudBench) is absent from this batch: ${fraudbench.note}. ` +
      'No substitute samples were generated - see `eval/fraudbench/README.md`.',
  );
  L.push('');

  // ---- calibration ----
  L.push('## Calibration (F12)');
  L.push('');
  L.push(
    `${calibration.judged} directional verdicts, ${calibration.abstained} abstentions ` +
      `(excluded - an abstention makes no claim to be calibrated). ECE ${calibration.ece.toFixed(3)}.`,
  );
  L.push('');
  if (calibration.bins.length === 0) {
    L.push('No directional verdicts to plot.');
  } else {
    L.push('| Confidence bin | n | Mean stated | Observed accuracy |');
    L.push('|---|---|---|---|');
    for (const b of calibration.bins) {
      L.push(
        `| ${b.lower.toFixed(2)}–${b.upper.toFixed(2)} | ${b.count} | ${b.mean_confidence.toFixed(3)} | ` +
          `${b.observed_accuracy.toFixed(3)} |`,
      );
    }
    L.push('');
    L.push(
      'The curve is coarse because scripted fixtures take only a handful of distinct ' +
        'confidence values. It is a wiring check for the calibration path, not a real ' +
        'reliability curve.',
    );
  }
  L.push('');

  // ---- injection ----
  const ourInjection = injectionByName.get('Ours')!;
  L.push('## Injection resistance (F9)');
  L.push('');
  L.push(
    `${ourInjection.total} attempts · ${ourInjection.contained} contained · ` +
      `${ourInjection.caught_pre_model} caught by the deterministic sanitiser before any model ` +
      `call · ${ourInjection.breached.length} approved.`,
  );
  L.push('');
  L.push(
    'B1 and B2 both score 0%: B1 never reads the claim text, and B2 has no notion of an ' +
      'instruction hidden in it. Neither is a weak strawman - neither architecture has anywhere ' +
      'to put the defense.',
  );
  L.push('');

  // ---- where it fails ----
  L.push('## Where it fails');
  L.push('');
  const falsePositives = results.filter(
    (r) => truth.get(r.claim.id) === 'should_release' && r.decision.outcome !== 'APPROVE',
  );
  const falseNegatives = results.filter(
    (r) => truth.get(r.claim.id) === 'should_hold' && r.decision.outcome === 'APPROVE',
  );

  L.push(
    `**${falsePositives.length} legitimate claims flagged** (${inr(metrics.get('Ours')!.wrongly_flagged_inr)} ` +
      'of real customers\' money delayed) and ' +
      `**${falseNegatives.length} invalid claims approved**. Both lists are generated from the ` +
      'run, not hand-written.',
  );
  L.push('');
  if (falsePositives.length > 0) {
    L.push('### Legitimate claims RCIE wrongly flagged');
    L.push('');
    L.push('| Claim | Class | Outcome | ₹ | Why |');
    L.push('|---|---|---|---|---|');
    for (const r of falsePositives) {
      L.push(
        `| ${r.claim.id} | ${caseById.get(r.claim.id)?.scenario ?? '?'} | ${r.decision.outcome} | ` +
          `${r.claim.amount_inr} | ${r.summary.replace(/\|/g, '\\|').slice(0, 110)} |`,
      );
    }
    L.push('');
  }
  if (falseNegatives.length > 0) {
    L.push('### Invalid claims RCIE approved');
    L.push('');
    L.push('| Claim | Class | ₹ | Why it slipped through |');
    L.push('|---|---|---|---|');
    for (const r of falseNegatives) {
      L.push(
        `| ${r.claim.id} | ${caseById.get(r.claim.id)?.scenario ?? '?'} | ${r.claim.amount_inr} | ` +
          `${r.summary.replace(/\|/g, '\\|').slice(0, 110)} |`,
      );
    }
    L.push('');
  }
  if (falsePositives.length === 0 && falseNegatives.length === 0) {
    L.push(
      '**Nothing failed - which is itself a finding.** A batch with no errors means the ' +
        'fixtures are too easy to be evidence of anything. Treat this as a gap in the eval, ' +
        'not a result.',
    );
    L.push('');
  }
  if (falsePositives.length > 0) {
    L.push('### What is actually driving the false-positive rate');
    L.push('');
    L.push('| Cause | Claims | ₹ delayed |');
    L.push('|---|---|---|');
    const causes = [...new Set(falsePositives.map((r) => r.decision_basis))].sort();
    for (const cause of causes) {
      const group = falsePositives.filter((r) => r.decision_basis === cause);
      L.push(
        `| ${cause} | ${group.length} | ${inr(group.reduce((sum, r) => sum + r.claim.amount_inr, 0))} |`,
      );
    }
    L.push('');
    L.push(
      'Two of these are policy, not error: `confidence_below_threshold` and ' +
        '`exposure_above_ceiling` fire because the merchant configured a ceiling above which a ' +
        'human must look. Counting them as false positives is the harsh reading, and it is the ' +
        'one reported above - but the fix for those rows is a policy conversation, whereas ' +
        '`verifier_unavailable` rows are an availability bug and `verifier_abstained` rows are ' +
        'the system correctly refusing to guess on unusable photographs.',
    );
    L.push('');
  }

  L.push(
    'The structural blind spot: RCIE verifies that evidence is *consistent with the claim and ' +
      'the order*. Damage that was really inflicted and truthfully photographed is consistent, ' +
      'so a claim like that is approved. No evidence-integrity layer can catch it - it needs ' +
      'behavioural signal, which is where L1 velocity and L2 reuse do the work instead.',
  );
  L.push('');

  const markdown = L.join('\n');
  const outPath = resolve(process.cwd(), 'eval/RESULTS.md');
  writeFileSync(outPath, `${markdown}\n`, 'utf8');
  console.log(markdown);
  console.log(`\n(written to ${outPath})`);

  const ours = metrics.get('Ours')!;
  if (falsePositives.length === 0 && falseNegatives.length === 0) process.exitCode = 1;
  if (ours.tp + ours.fp + ours.fn + ours.tn !== results.length) process.exitCode = 1;
}

await main();
