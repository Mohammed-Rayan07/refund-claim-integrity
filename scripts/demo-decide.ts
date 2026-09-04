/**
 * npm run demo:decide
 *
 * Full pipeline (L0 -> L1 -> L3 -> L4) over the synthetic batch, in MODE=mock.
 *
 * Phase 1 - healthy verifier: all three outcomes are reachable, injection
 *           attempts route to REVIEW with the audit flag set.
 * Phase 2 - the verifier is killed mid-run: every claim after the kill degrades
 *           to REVIEW, the circuit breaker opens, and nothing is auto-approved.
 */
import { currentMode } from '../shared/mode.ts';
import { loadConfig } from '../shared/config/index.ts';
import { createPaymentsAdapter } from '../shared/adapters/payments.ts';
import { createStoreAdapter, type StoreAdapter } from '../shared/adapters/store.ts';
import { createNotifierAdapter, type NotifierAdapter } from '../shared/adapters/notifier.ts';
import { createMockLlmAdapter, type MockLlmAdapter, type MockScriptEntry } from '../shared/adapters/llm.ts';
import { describe, type ReasonCode } from '../shared/lib/reasoncodes.ts';
import { createPipeline, type PipelineResult } from '../layers/pipeline.ts';
import { buildFixtures, UNSCRIPTED_FALLBACK, type FixtureCase } from '../eval/fixtures/index.ts';
import { loadFraudBenchSubset } from '../eval/fraudbench/loader.ts';
import type { Claim, Outcome } from '../shared/types.ts';

const RULE = '='.repeat(96);
const THIN = '-'.repeat(96);
const MODEL_VERSION = 'claude-opus-5-mock';

function pad(v: string, w: number): string {
  return v.length >= w ? v.slice(0, w) : v + ' '.repeat(w - v.length);
}
function padLeft(v: string, w: number): string {
  return v.length >= w ? v : ' '.repeat(w - v.length) + v;
}
function codes(list: readonly string[]): string {
  return list.length ? list.map((c) => describe(c as ReasonCode)).join(', ') : '-';
}

const config = loadConfig();
const fraudbench = loadFraudBenchSubset();
const fixtures = buildFixtures(fraudbench);
const caseById = new Map<string, FixtureCase>(fixtures.cases.map((c) => [c.claim_id, c]));

function buildScript(): Map<string, MockScriptEntry> {
  return new Map(fixtures.cases.map((c) => [c.claim_id, c.verifier_script]));
}

interface Harness {
  store: StoreAdapter;
  notifier: NotifierAdapter;
  llm: MockLlmAdapter;
  pipeline: ReturnType<typeof createPipeline>;
}

function newHarness(): Harness {
  const payments = createPaymentsAdapter({ orders: fixtures.orders, payments: fixtures.payments });
  const store = createStoreAdapter({ claims: fixtures.claims, evidence: fixtures.evidence });
  const notifier = createNotifierAdapter();
  const llm = createMockLlmAdapter({
    script: buildScript(),
    fallback: UNSCRIPTED_FALLBACK,
    model_version: MODEL_VERSION,
  });
  return {
    store,
    notifier,
    llm,
    pipeline: createPipeline({
      payments,
      store,
      notifier,
      llm,
      config,
      catalogue: fixtures.catalogue,
      shared_index: fixtures.shared_index,
    }),
  };
}

function header(): void {
  console.log(RULE);
  console.log('REFUND CLAIM INTEGRITY ENGINE - DECISION DEMO (L0 -> L1 -> L3 -> L4)');
  console.log(RULE);
  console.log(`MODE                 : ${currentMode()}`);
  console.log(`policy / thresholds  : ${config.policy.version} / ${config.thresholds.version}`);
  console.log(`config snapshot      : ${config.snapshot_id}`);
  console.log(
    `confidence bar       : ${config.thresholds.decision.base_threshold} + ` +
      `(exposure / ceiling) * ${config.thresholds.decision.scaling_factor}, capped at ` +
      `${config.thresholds.decision.max_confidence_threshold}   [F8: bigger claim, higher bar]`,
  );
  console.log(
    `ceilings (INR)       : merchant ${config.policy.auto_approve_ceiling}; ` +
      Object.entries(config.policy.category_overrides)
        .map(([k, v]) => `${k} ${v.auto_approve_ceiling}`)
        .join('; '),
  );
  console.log(
    `circuit breaker      : opens after ${config.thresholds.verifier.circuit_breaker_consecutive_failures} ` +
      `consecutive verifier failures, cooldown ${config.thresholds.verifier.circuit_breaker_cooldown_ms}ms`,
  );
  console.log(`FraudBench subset    : ${fraudbench.samples.length} samples - ${fraudbench.note}`);
  console.log(`fixtures             : ${fixtures.claims.length} synthetic claims (business data only)`);
  console.log('');
}

function rowHeader(): void {
  console.log(
    `${pad('CLAIM', 9)}${pad('SCENARIO', 25)}${pad('OUTCOME', 16)}${padLeft('EXPOSURE', 9)}` +
      `${padLeft('CONF', 6)}${padLeft('BAR', 6)}  ${pad('INJ', 4)}${pad('BASIS', 27)}REASON CODES`,
  );
  console.log(THIN);
}

function row(r: PipelineResult): void {
  const c = caseById.get(r.claim.id);
  const conf = r.decision.confidence === null ? '-' : r.decision.confidence.toFixed(2);
  const bar = Number.isNaN(r.required_confidence) ? '-' : r.required_confidence.toFixed(2);
  console.log(
    pad(r.claim.id, 9) +
      pad(c?.scenario ?? '?', 25) +
      pad(r.decision.outcome, 16) +
      padLeft(String(r.decision.exposure_inr), 9) +
      padLeft(conf, 6) +
      padLeft(bar, 6) +
      '  ' +
      pad(r.injection_suspected ? 'YES' : '-', 4) +
      pad(r.decision_basis, 27) +
      codes(r.decision.reason_codes),
  );
}

function tally(results: PipelineResult[]): Map<Outcome, number> {
  const m = new Map<Outcome, number>([
    ['APPROVE', 0],
    ['REVIEW', 0],
    ['DENY_RECOMMEND', 0],
  ]);
  for (const r of results) m.set(r.decision.outcome, (m.get(r.decision.outcome) ?? 0) + 1);
  return m;
}

async function phaseOne(claims: Claim[]): Promise<{ results: PipelineResult[]; h: Harness }> {
  const h = newHarness();
  console.log(RULE);
  console.log('PHASE 1 - HEALTHY VERIFIER');
  console.log(THIN);
  rowHeader();

  const results: PipelineResult[] = [];
  for (const claim of claims) {
    const r = await h.pipeline.resolve(claim);
    results.push(r);
    // Print only the L3-settled claims plus a sample of L1 denials: the full L1
    // sweep is what demo:spine is for.
    const scenario = caseById.get(claim.id)?.scenario;
    if (scenario !== undefined && (r.gate?.passed || scenario === 'clean')) row(r);
  }
  return { results, h };
}

async function phaseTwo(claims: Claim[]): Promise<{ results: PipelineResult[]; h: Harness }> {
  const h = newHarness();
  // Kill the verifier once this many L1-clean claims have been assessed.
  const killAfterModelCalls = 6;
  let killed = false;

  console.log('');
  console.log(RULE);
  console.log('PHASE 2 - VERIFIER KILLED MID-RUN (F11 fail-safe + circuit breaker)');
  console.log(THIN);
  rowHeader();

  const results: PipelineResult[] = [];
  for (const claim of claims) {
    if (!killed && h.llm.call_count >= killAfterModelCalls) {
      h.llm.kill('simulated outage: verifier endpoint unreachable');
      killed = true;
      console.log(`${pad('--', 9)}*** VERIFIER ADAPTER KILLED after ${h.llm.call_count} model calls ***`);
    }
    const r = await h.pipeline.resolve(claim);
    results.push(r);
    if (r.gate?.passed) row(r);
  }
  return { results, h };
}

async function main(): Promise<void> {
  header();

  const probe = createStoreAdapter({ claims: fixtures.claims, evidence: fixtures.evidence });
  const claims = await probe.listClaims();

  const { results: p1, h: h1 } = await phaseOne(claims);
  const { results: p2, h: h2 } = await phaseTwo(claims);

  // ---------------- Injection proof ----------------
  console.log('');
  console.log(RULE);
  console.log('F9 - PROMPT INJECTION: detected pre-model, verdict discarded, routed to a human');
  console.log(THIN);
  const injections = p1.filter((r) => caseById.get(r.claim.id)?.scenario === 'injection_attempt');
  for (const r of injections) {
    const flag = h1.store
      .listAudit(r.claim.id)
      .find((e) => e.layer === 'L0' && e.event === 'injection_suspected');
    const signals = (flag?.detail?.['signals'] as Array<{ id: string }> | undefined) ?? [];
    console.log(`${pad(r.claim.id, 9)}${pad(r.decision.outcome, 16)}audit_flag=${flag ? 'SET' : 'MISSING'}  signals=${signals.map((s) => s.id).join(',')}`);
    console.log(`          text : ${r.claim.claim_text.replace(/\n/g, ' \\n ').slice(0, 84)}`);
    console.log(`          fence: escaped=${r.sanitised.escaped}  ${r.summary.slice(0, 76)}`);
  }
  const injectionsSafe = injections.every((r) => r.decision.outcome === 'REVIEW' && r.injection_suspected);
  console.log(THIN);
  console.log(
    `${injections.length} injection attempts - all REVIEW with the audit flag set: ${injectionsSafe ? 'YES' : 'NO'}`,
  );

  // ---------------- Outcome proof ----------------
  const t1 = tally(p1);
  const t2 = tally(p2);
  console.log('');
  console.log(RULE);
  console.log('OUTCOME COMPARISON');
  console.log(THIN);
  console.log(`${pad('', 18)}${padLeft('PHASE 1', 10)}${padLeft('PHASE 2', 10)}`);
  for (const outcome of ['APPROVE', 'REVIEW', 'DENY_RECOMMEND'] as Outcome[]) {
    console.log(
      pad(outcome, 18) + padLeft(String(t1.get(outcome) ?? 0), 10) + padLeft(String(t2.get(outcome) ?? 0), 10),
    );
  }

  const allThreeReachable = (['APPROVE', 'REVIEW', 'DENY_RECOMMEND'] as Outcome[]).every(
    (o) => (t1.get(o) ?? 0) > 0,
  );

  // Claims decided after the kill, in phase 2.
  const killedTail = p2.filter(
    (r) => r.verifier_absence === 'circuit_open' || (r.verifier && !r.verifier.ok && r.verifier.failure === 'transport_error'),
  );
  const tailApprovals = killedTail.filter((r) => r.decision.outcome === 'APPROVE').length;

  console.log('');
  console.log(RULE);
  console.log('SUMMARY');
  console.log(THIN);
  console.log(`all three outcomes reachable (phase 1)      : ${allThreeReachable ? 'YES' : 'NO'}`);
  console.log(`injection attempts -> REVIEW + audit flag   : ${injectionsSafe ? 'YES' : 'NO'}`);
  console.log(`phase 2 claims hit by the outage            : ${killedTail.length}`);
  console.log(`  of those, APPROVE                         : ${tailApprovals}  (must be 0)`);
  console.log(`  circuit breaker trips                     : ${h2.pipeline.breaker().trips}`);
  console.log(`  claims skipped by an open circuit         : ${p2.filter((r) => r.verifier_absence === 'circuit_open').length}`);
  console.log(THIN);
  const noModel1 = p1.filter((r) => r.resolved_without_model_call).length;
  console.log(`phase 1 model calls made                    : ${h1.llm.call_count}`);
  console.log(
    `phase 1 resolved without a model call       : ${noModel1}/${p1.length} ` +
      `(${((noModel1 / p1.length) * 100).toFixed(1)}%)   [F17]`,
  );
  console.log(`phase 1 audit events                        : ${h1.store.allAudit().length}`);
  console.log(`phase 1 review queue depth                  : ${h1.notifier.queued().length}`);
  console.log(`money moved                                 : INR 0 - by construction, no such code path`);
  console.log(RULE);

  if (!allThreeReachable || !injectionsSafe || tailApprovals > 0) process.exitCode = 1;
}

await main();
