/**
 * npm run demo:full
 *
 * Walks the SPEC §9 five-case demo script, in order, unattended, in MODE=mock:
 *   1. SKU mismatch          - a genuine photo of the wrong product
 *   2. AI-generated fake damage (FraudBench sample) - the multimodal layer
 *   3. Genuine damaged goods - correctly APPROVED
 *   4. A case the system got wrong - deliberate, the credibility move
 *   5. Prompt injection      - neutralised, logged, routed to REVIEW
 *
 * Then proves the rest of Chunk 4 against those same five claims:
 *   F13 deterministic replay, F15 human feedback + agreement rate,
 *   F16 idempotency (the same claim resolved twice produces one decision),
 * and closes with the portfolio view (F7).
 */
import { currentMode } from '../shared/mode.ts';
import { loadConfig } from '../shared/config/index.ts';
import { createPaymentsAdapter } from '../shared/adapters/payments.ts';
import { createStoreAdapter } from '../shared/adapters/store.ts';
import { createNotifierAdapter } from '../shared/adapters/notifier.ts';
import { createMockLlmAdapter, type MockScriptEntry } from '../shared/adapters/llm.ts';
import { describe, type ReasonCode } from '../shared/lib/reasoncodes.ts';
import { replayDecision } from '../shared/lib/replay.ts';
import { recordHumanReview, agreementReport } from '../shared/lib/feedback.ts';
import { AuditLogger } from '../shared/lib/logger.ts';
import { createPipeline, type PipelineResult } from '../layers/pipeline.ts';
import { buildFixtures, UNSCRIPTED_FALLBACK, type FixtureCase } from '../eval/fixtures/index.ts';
import { loadFraudBenchSubset } from '../eval/fraudbench/loader.ts';
import type { Claim, Decision } from '../shared/types.ts';

const RULE = '='.repeat(96);
const THIN = '-'.repeat(96);
const MODEL_VERSION = 'claude-opus-5-mock';

function codes(list: readonly string[]): string {
  return list.length ? list.map((c) => describe(c as ReasonCode)).join(', ') : '(none)';
}

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`  [${ok ? 'OK' : 'FAIL'}] ${label}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const fraudbench = loadFraudBenchSubset();
  const fixtures = buildFixtures(fraudbench);
  const caseById = new Map<string, FixtureCase>(fixtures.cases.map((c) => [c.claim_id, c]));

  console.log(RULE);
  console.log('REFUND CLAIM INTEGRITY ENGINE - FULL DEMO (SPEC section 9, five cases in order)');
  console.log(RULE);
  console.log(`MODE                 : ${currentMode()}`);
  console.log(`policy / thresholds  : ${config.policy.version} / ${config.thresholds.version}`);
  console.log(`config snapshot      : ${config.snapshot_id}`);
  console.log(`FraudBench subset    : ${fraudbench.samples.length} samples - ${fraudbench.note}`);
  console.log('');

  const payments = createPaymentsAdapter({ orders: fixtures.orders, payments: fixtures.payments });
  const store = createStoreAdapter({ claims: fixtures.claims, evidence: fixtures.evidence });
  const notifier = createNotifierAdapter();
  const script = new Map<string, MockScriptEntry>(fixtures.cases.map((c) => [c.claim_id, c.verifier_script]));
  const llm = createMockLlmAdapter({ script, fallback: UNSCRIPTED_FALLBACK, model_version: MODEL_VERSION });
  const pipeline = createPipeline({
    payments,
    store,
    notifier,
    llm,
    config,
    catalogue: fixtures.catalogue,
    shared_index: fixtures.shared_index,
  });

  // ---- run the whole batch once: this IS the portfolio (F7), and it is where
  //      the five demo cases are picked from, so a claim shown below is a claim
  //      that actually went through the pipeline, not a hand-picked transcript.
  const results: PipelineResult[] = [];
  for (const claim of fixtures.claims) {
    results.push(await pipeline.resolve(claim));
  }
  const byClaimId = new Map(results.map((r) => [r.claim.id, r]));

  // ---- select the five §9 cases from the actual run --------------------------
  const syntheticRefs = new Set(
    (fraudbench.samples ?? []).filter((s) => s.label === 'synthetic').map((s) => s.image_ref),
  );

  const case1 = results.find((r) => caseById.get(r.claim.id)?.scenario === 'sku_mismatch');
  const case2 =
    results.find((r) => r.claim.image_refs.some((ref) => syntheticRefs.has(ref))) ??
    results.find((r) => caseById.get(r.claim.id)?.scenario === 'evidence_contradicts');
  const case3 = results.find(
    (r) => caseById.get(r.claim.id)?.scenario === 'clean' && r.decision.outcome === 'APPROVE',
  );
  const case4 = results.find((r) => caseById.get(r.claim.id)?.scenario === 'missed_fabrication');
  const case5 = results.find((r) => caseById.get(r.claim.id)?.scenario === 'injection_attempt');

  function showCase(n: number, title: string, r: PipelineResult | undefined, note: string): void {
    console.log(RULE);
    console.log(`CASE ${n} - ${title}`);
    console.log(THIN);
    if (!r) {
      console.log('  (no fixture matched this case in the current batch)');
      failures += 1;
      return;
    }
    const c = caseById.get(r.claim.id);
    console.log(`  claim        : ${r.claim.id}  (${c?.note ?? c?.scenario ?? ''})`);
    console.log(`  order/sku    : ${r.claim.order_id} / ${r.claim.claimed_sku}  exposure INR ${r.claim.amount_inr}`);
    console.log(`  evidence     : ${r.claim.image_refs.join(', ') || '(none)'}`);
    console.log(`  outcome      : ${r.decision.outcome}   reason codes: ${codes(r.decision.reason_codes)}`);
    console.log(`  basis        : ${r.decision_basis}`);
    console.log(`  summary      : ${r.summary}`);
    console.log(`  ${note}`);
  }

  showCase(
    1,
    'SKU MISMATCH - a genuine, unedited photo of the WRONG product',
    case1,
    'no image detector on earth catches this - there is nothing to detect. RCIE catches it because it checks the claim against the order, not the pixels.',
  );
  check('case 1 is not auto-approved', case1?.decision.outcome !== 'APPROVE');

  const case2FbSample = case2
    ? fraudbench.samples.find((s) => s.label === 'synthetic' && case2.claim.image_refs.includes(s.image_ref))
    : undefined;
  showCase(
    2,
    'AI-GENERATED FAKE DAMAGE - the multimodal layer',
    case2,
    case2FbSample
      ? `evidence includes a real FraudBench sample (${case2FbSample.sample_id}, generator=${case2FbSample.generator ?? 'n/a'}) - consumed only, never generated by this repo.`
      : 'no local FraudBench subset - showing the closest scripted analog (an internally contradictory evidence/claim pair). Run `npm run fetch:fraudbench` for a real sample.',
  );

  showCase(
    3,
    'GENUINE DAMAGED GOODS - correctly APPROVED',
    case3,
    'proves the system does not just deny everything.',
  );
  check('case 3 is APPROVE', case3?.decision.outcome === 'APPROVE');

  showCase(
    4,
    'A CASE THE SYSTEM GOT WRONG - deliberate, the credibility move',
    case4,
    'self-inflicted damage, truthfully photographed: the evidence genuinely supports the claim, so RCIE approves it. It is still fraud. No evidence-integrity layer can see this - it needs behavioural signal (L1 velocity, L2 reuse), which is a structural limit stated plainly, not hidden.',
  );
  check('case 4 is the known false negative (approved)', case4?.decision.outcome === 'APPROVE');

  showCase(
    5,
    'PROMPT INJECTION - neutralised, logged, routed to REVIEW',
    case5,
    'the claim text tried to instruct the model directly; the sanitiser fenced it as data before it ever reached L3, and the ladder routed to REVIEW regardless of what the model said.',
  );
  check('case 5 is REVIEW with the injection flag set', case5?.decision.outcome === 'REVIEW' && case5?.injection_suspected === true);

  // ---- F16 idempotency: resolve one of the five claims again -----------------
  console.log('');
  console.log(RULE);
  console.log('F16 - IDEMPOTENCY: the same claim resolved twice produces ONE decision');
  console.log(THIN);
  if (case5) {
    const beforeAudit = store.allAudit().length;
    const beforeQueue = notifier.queued().length;
    const beforeDecisions = (await store.listDecisions()).length;
    const second = await pipeline.resolve(case5.claim);
    const afterAudit = store.allAudit().length;
    const afterQueue = notifier.queued().length;
    const afterDecisions = (await store.listDecisions()).length;
    console.log(`  claim ${case5.claim.id} resolved a second time (duplicate submission / retried webhook)`);
    console.log(`  idempotent_replay=${second.idempotent_replay}  decision id unchanged=${second.decision.id === case5.decision.id}`);
    console.log(`  audit events   : ${beforeAudit} -> ${afterAudit}  (must not grow from a real re-run)`);
    console.log(`  review queue   : ${beforeQueue} -> ${afterQueue}  (must not double-notify)`);
    console.log(`  decisions saved: ${beforeDecisions} -> ${afterDecisions}  (must stay one per claim)`);
    check('idempotent replay flagged', second.idempotent_replay === true);
    check('same decision id returned', second.decision.id === case5.decision.id);
    check('no duplicate notification', afterQueue === beforeQueue);
    check('exactly one decision on record', afterDecisions === beforeDecisions);
  } else {
    check('F16 demo claim available', false);
  }

  // ---- F13 replay: reconstruct case 1 and case 4 from the audit log alone ----
  console.log('');
  console.log(RULE);
  console.log('F13 - DETERMINISTIC REPLAY: reconstructed from the audit log, model never re-called');
  console.log(THIN);
  for (const r of [case1, case4].filter((x): x is PipelineResult => x !== undefined)) {
    const report = await replayDecision(r.claim.id, { payments, store, config });
    console.log(
      `  ${r.claim.id}  original=${report.original.outcome} replayed=${report.replayed.outcome}  ` +
        `match=${report.matches}${report.diffs.length ? '  diffs: ' + report.diffs.join('; ') : ''}`,
    );
    check(`${r.claim.id} replays to the same decision`, report.matches);
  }

  // ---- F15 human feedback loop -------------------------------------------------
  console.log('');
  console.log(RULE);
  console.log('F15 - HUMAN FEEDBACK LOOP: reviewer verdicts measured against the system');
  console.log(THIN);
  const feedbackAudit = new AuditLogger({ append: (e) => store.appendAudit(e) });
  const reviewed: Array<{ r: PipelineResult; note: string }> = [];
  if (case3) reviewed.push({ r: case3, note: 'reviewer confirms: genuinely damaged, correctly approved' });
  if (case5) reviewed.push({ r: case5, note: 'reviewer confirms: was in fact an injection attempt' });
  if (case4) {
    reviewed.push({ r: case4, note: 'reviewer OVERRIDES on later investigation: self-inflicted damage confirmed fraudulent' });
  }
  for (const { r, note } of reviewed) {
    const verdict = r === case4 ? 'DENY_RECOMMEND' : r.decision.outcome;
    const review = await recordHumanReview(
      { claim_id: r.claim.id, reviewer: 'reviewer_demo', verdict, notes: note },
      { store, audit: feedbackAudit },
    );
    console.log(
      `  ${r.claim.id}  system=${r.decision.outcome}  reviewer=${review.verdict}  ` +
        `agreed=${review.agreed_with_system}  "${note}"`,
    );
  }
  const allReviews = await store.listHumanReviews();
  const decisions = await store.listDecisions();
  const decisionsByClaimId = new Map<string, Decision>(decisions.map((d) => [d.claim_id, d]));
  const agreement = agreementReport(allReviews, decisionsByClaimId);
  console.log(THIN);
  console.log(
    `  agreement rate: ${(agreement.overall_agreement_rate * 100).toFixed(1)}% over ${agreement.total_reviews} reviews  ` +
      `(feedback measures drift; it never adjusts a threshold automatically)`,
  );
  if (agreement.confident_overrides.length > 0) {
    console.log(`  confident overrides (system >=0.85 confidence, human disagreed):`);
    for (const o of agreement.confident_overrides) {
      console.log(`    ${o.claim_id}  system=${o.system_outcome} reviewer=${o.reviewer_verdict} confidence=${o.confidence?.toFixed(2)}`);
    }
  }
  check('at least one reviewer verdict recorded', agreement.total_reviews > 0);

  // ---- Portfolio view (F7), over the whole batch ------------------------------
  console.log('');
  console.log(RULE);
  console.log('PORTFOLIO VIEW');
  console.log(THIN);
  const held = results
    .filter((r) => r.decision.outcome !== 'APPROVE')
    .reduce((sum, r) => sum + r.decision.exposure_inr, 0);
  const released = results
    .filter((r) => r.decision.outcome === 'APPROVE')
    .reduce((sum, r) => sum + r.decision.exposure_inr, 0);
  const noModel = results.filter((r) => r.resolved_without_model_call).length;
  console.log(`  claims processed              : ${results.length}`);
  console.log(`  INR held (REVIEW + DENY)      : INR ${held}`);
  console.log(`  INR released (APPROVE)        : INR ${released}`);
  console.log(`  review queue depth            : ${notifier.queued().length}`);
  console.log(
    `  resolved without a model call : ${noModel}/${results.length} (${((noModel / results.length) * 100).toFixed(1)}%)   [F17]`,
  );
  console.log(`  full results table            : run \`npm run eval\` -> eval/RESULTS.md`);
  console.log(`  dashboard                     : run \`npm run dashboard\` -> dashboard/index.html`);
  console.log(`  money moved                   : INR 0 - by construction, no such code path`);
  console.log(RULE);

  console.log('');
  console.log(`${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exitCode = 1;
}

await main();
