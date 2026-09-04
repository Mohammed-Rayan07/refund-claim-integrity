/**
 * npm run demo:spine
 *
 * Runs the whole synthetic batch through L1 -> L4 in MODE=mock.
 * Zero model calls, zero network calls, no money moved.
 */
import { currentMode } from '../shared/mode.ts';
import { loadConfig } from '../shared/config/index.ts';
import { createPaymentsAdapter } from '../shared/adapters/payments.ts';
import { createStoreAdapter } from '../shared/adapters/store.ts';
import { createNotifierAdapter } from '../shared/adapters/notifier.ts';
import { describe, type ReasonCode } from '../shared/lib/reasoncodes.ts';
import { createPipeline, type PipelineResult } from '../layers/pipeline.ts';
import { buildFixtures, type FixtureCase } from '../eval/fixtures/index.ts';
import type { Outcome } from '../shared/types.ts';

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

async function main(): Promise<void> {
  const mode = currentMode();
  const config = loadConfig();
  const fixtures = buildFixtures();

  console.log(RULE);
  console.log('REFUND CLAIM INTEGRITY ENGINE - SPINE DEMO (deterministic layers only)');
  console.log(RULE);
  console.log(`MODE                 : ${mode}`);
  console.log(`policy               : ${config.policy.version} (${config.policy.merchant_id})`);
  console.log(`thresholds           : ${config.thresholds.version}`);
  console.log(`config snapshot      : ${config.snapshot_id}`);
  console.log(
    `refund window        : ${config.thresholds.integrity_gate.refund_window_days}d | ` +
      `velocity ${config.thresholds.integrity_gate.velocity_max_claims} claims / ` +
      `${config.thresholds.integrity_gate.velocity_window_days}d | ` +
      `auto-approve ceiling INR ${config.policy.auto_approve_ceiling}`,
  );
  console.log(
    `fixtures             : ${fixtures.claims.length} claims, ${fixtures.orders.length} orders, ` +
      `${fixtures.payments.length} payments (synthetic business data only)`,
  );
  console.log('');

  const payments = createPaymentsAdapter({ orders: fixtures.orders, payments: fixtures.payments });
  const store = createStoreAdapter({ claims: fixtures.claims, evidence: fixtures.evidence });
  const notifier = createNotifierAdapter();
  const pipeline = createPipeline({
    payments,
    store,
    notifier,
    config,
    catalogue: fixtures.catalogue,
    shared_index: fixtures.shared_index,
  });

  const caseById = new Map<string, FixtureCase>(fixtures.cases.map((c) => [c.claim_id, c]));
  const claims = await store.listClaims();
  const results: PipelineResult[] = [];

  console.log(RULE);
  console.log('PER-CLAIM RESULTS');
  console.log(THIN);
  console.log(
    `${pad('CLAIM', 10)}${pad('SCENARIO', 26)}${pad('OUTCOME', 17)}${padLeft('EXPOSURE', 10)}  REASON CODES`,
  );
  console.log(THIN);

  for (const claim of claims) {
    const result = await pipeline.resolve(claim);
    results.push(result);
    const fixtureCase = caseById.get(claim.id);
    const codes = result.decision.reason_codes as ReasonCode[];
    console.log(
      pad(claim.id, 10) +
        pad(fixtureCase?.scenario ?? 'unknown', 26) +
        pad(result.decision.outcome, 17) +
        padLeft(`INR ${result.decision.exposure_inr}`, 10) +
        '  ' +
        (codes.length ? codes.map(describe).join(', ') : '(none)'),
    );
  }

  // --- Verification: did L1 fire the reason code each fixture was built to trigger? ---
  console.log('');
  console.log(RULE);
  console.log('L1 VERIFICATION (expected reason code vs emitted)');
  console.log(THIN);
  const mismatches: string[] = [];
  for (const result of results) {
    const expected = caseById.get(result.claim.id)?.expected_reason_code ?? null;
    const emitted = result.gate?.reason_codes ?? [];
    const ok = expected === null ? emitted.length === 0 : emitted.includes(expected as ReasonCode);
    if (!ok) {
      mismatches.push(
        `${result.claim.id}: expected ${expected ?? 'clean'}, got ${
          emitted.length ? emitted.join(',') : 'clean'
        }`,
      );
    }
  }
  if (mismatches.length === 0) {
    console.log(`all ${results.length} claims emitted the expected L1 reason codes`);
  } else {
    console.log(`${mismatches.length} mismatch(es):`);
    for (const m of mismatches) console.log(`  ${m}`);
  }

  // --- Audit trail sample: one clean claim and one hard failure, in full ---
  console.log('');
  console.log(RULE);
  console.log('AUDIT TRAIL SAMPLE');
  const sampleClean = results.find((r) => r.gate?.passed === true);
  const sampleFailed = results.find((r) => r.gate?.passed === false);
  for (const sample of [sampleClean, sampleFailed]) {
    if (!sample) continue;
    console.log(THIN);
    console.log(`claim ${sample.claim.id} - ${sample.summary}`);
    for (const event of store.listAudit(sample.claim.id)) {
      console.log(
        `  [${event.timestamp}] ${pad(event.layer, 9)}${pad(event.event, 26)}payload=${event.payload_hash.slice(0, 12)}`,
      );
    }
    console.log('  checks:');
    for (const check of sample.gate?.checks ?? []) {
      const codeSuffix = check.reason_code ? ` ${check.reason_code}` : '';
      console.log(
        `    ${pad(check.status.toUpperCase(), 8)}${pad(check.id, 28)}${check.detail}${codeSuffix}`,
      );
    }
  }

  // --- Summary ---
  const byOutcome = new Map<Outcome, number>([
    ['APPROVE', 0],
    ['REVIEW', 0],
    ['DENY_RECOMMEND', 0],
  ]);
  const byCode = new Map<string, number>();
  let heldExposure = 0;
  for (const r of results) {
    byOutcome.set(r.decision.outcome, (byOutcome.get(r.decision.outcome) ?? 0) + 1);
    for (const code of r.decision.reason_codes) {
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    if (r.decision.outcome !== 'APPROVE') heldExposure += r.decision.exposure_inr;
  }

  console.log('');
  console.log(RULE);
  console.log('SUMMARY');
  console.log(THIN);
  for (const [outcome, count] of byOutcome) {
    console.log(`${pad(outcome, 18)}${padLeft(String(count), 4)}`);
  }
  console.log(THIN);
  console.log('reason code frequency:');
  for (const [code, count] of [...byCode.entries()].sort()) {
    console.log(`  ${pad(describe(code as ReasonCode), 34)}${padLeft(String(count), 4)}`);
  }
  console.log(THIN);
  const noModel = results.filter((r) => r.resolved_without_model_call).length;
  console.log(`claims processed              : ${results.length}`);
  console.log(
    `resolved without a model call : ${noModel}/${results.length} ` +
      `(${((noModel / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(`audit events written          : ${store.allAudit().length}`);
  console.log(`review queue depth            : ${notifier.queued().length}`);
  console.log(`exposure held for a human     : INR ${heldExposure}`);
  console.log(`money moved                   : INR 0 - by construction, no such code path`);
  console.log(RULE);

  if (mismatches.length > 0) process.exitCode = 1;
}

await main();
