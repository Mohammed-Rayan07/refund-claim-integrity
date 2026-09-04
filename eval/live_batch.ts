/**
 * npm run eval:live   -- runs the FraudBench batch through the real pipeline
 *                        with real images and real model calls.
 *
 *   LLM_MODE=live npm run eval:live            full batch
 *   LLM_MODE=live npm run eval:live -- --smoke one claim, to check wiring and cost
 *   npm run eval:live -- --bytes-check         no network: proves image bytes
 *                                              actually reach the adapter
 *
 * MONEY SAFETY. `MODE` stays `mock`, so `payments`, `store` and `notifier` are
 * mock adapters throughout; only the LLM adapter is widened, through the narrow
 * `LLM_MODE` seam. There is no live money path in this repository and this
 * script does not add one - it reads orders, reads images, calls a model, and
 * writes a JSON file.
 *
 * SPEC section 0. Every image is a benchmark file placed on disk verbatim by
 * `fetch.ts`. Nothing here generates, edits or augments evidence.
 *
 * The run refuses to write a result labelled "live" unless it can show the model
 * was sent image bytes. `references_only` on any verified claim aborts the run.
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { currentMode, llmMode } from '../shared/mode.ts';
import { loadConfig } from '../shared/config/index.ts';
import { createPaymentsAdapter } from '../shared/adapters/payments.ts';
import { createStoreAdapter } from '../shared/adapters/store.ts';
import { createNotifierAdapter } from '../shared/adapters/notifier.ts';
import { createLiveLlmAdapter, createMockLlmAdapter, type LlmAdapter } from '../shared/adapters/llm.ts';
import { createLocalFileEvidenceAdapter } from '../shared/adapters/evidence.ts';
import { describeAll, type ReasonCode } from '../shared/lib/reasoncodes.ts';
import { costOf } from '../shared/lib/budget.ts';
import { createPipeline, type PipelineResult } from '../layers/pipeline.ts';
import { loadFraudBenchSubset } from './fraudbench/loader.ts';
import { buildLiveBatch, INLINE_BYTE_CAP, type LiveCase } from './fraudbench/cases.ts';
import { runVlmBaseline, VLM_PROMPT_VERSION, type VlmVerdict } from './vlm_baseline.ts';
import { scriptedVerdict } from './fixtures/index.ts';

const OUT_PATH = 'eval/live-run.json';

const args = new Set(process.argv.slice(2));
const SMOKE = args.has('--smoke');
const BYTES_CHECK = args.has('--bytes-check');
const SKIP_B2 = args.has('--no-b2');

/** What gets written to eval/live-run.json for the report to consume. */
export interface LiveRunRecord {
  claim_id: string;
  scenario: LiveCase['scenario'];
  ground_truth: LiveCase['ground_truth'];
  rationale: string;
  expected_layer: LiveCase['expected_layer'];
  product_title: string;
  rcie_category: string;
  provenance: LiveCase['provenance'];
  amount_inr: number;
  outcome: string;
  reason_codes: string[];
  decision_basis: string;
  summary: string;
  confidence: number | null;
  required_confidence: number;
  injection_suspected: boolean;
  sanitiser_signals: string[];
  silent_review_repaired: boolean;
  /** L1 outcome, so the B1 baseline can be projected from the same run. */
  l1_passed: boolean;
  l1_reason_codes: string[];
  reuse_similarity: number | null;
  reuse_source: string | null;
  verifier_ok: boolean | null;
  verifier_failure: string | null;
  supports_claim: string | null;
  sku_match: string | null;
  internal_consistency: number | null;
  contradictions: string[];
  verifier_reasoning: string;
  /** TRUE means the model was sent real image bytes for this claim. */
  saw_image_bytes: boolean;
  model_call: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_inr: number;
  latency_ms: number;
  b2: VlmVerdict | null;
}

export interface LiveRun {
  generated_at: string;
  mode: string;
  llm_mode: string;
  model: string;
  effort: string;
  prompt_version: string;
  b2_prompt_version: string;
  config_snapshot_id: string;
  dataset: string | null;
  dataset_sha: string | null;
  fetched_at: string | null;
  usd_inr: number;
  excluded: Array<{ sample_id: string; reason: string }>;
  excluded_claims: Array<{ claim_id: string; reason: string }>;
  records: LiveRunRecord[];
}

async function uploadOversized(
  client: Anthropic,
  refs: string[],
): Promise<{ uploaded: Map<string, string>; failed: Map<string, string> }> {
  const uploaded = new Map<string, string>();
  const failed = new Map<string, string>();
  for (const ref of refs) {
    try {
      const file = await client.files.upload({
        file: createReadStream(resolve(process.cwd(), ref)),
      });
      uploaded.set(ref, file.id);
      console.log(`  uploaded ${ref} -> ${file.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.set(ref, message);
      console.log(`  UPLOAD FAILED ${ref}: ${message.slice(0, 120)}`);
    }
  }
  return { uploaded, failed };
}

async function main(): Promise<void> {
  const mode = currentMode();
  if (mode !== 'mock') {
    throw new Error(
      `MODE must stay "mock" for this run (got "${mode}"). Only LLM_MODE may go live - ` +
        'no other adapter has a live branch, and none may be added.',
    );
  }

  const config = loadConfig();
  const subset = loadFraudBenchSubset();
  if (!subset.present) {
    console.error(`\nNo FraudBench subset: ${subset.note}`);
    console.error('Run `npm run fetch:fraudbench` first. No substitute samples will be generated.');
    process.exitCode = 1;
    return;
  }

  const evidence_bytes = createLocalFileEvidenceAdapter();
  console.log(
    `FraudBench subset: ${subset.samples.length} samples, ${subset.generators.length} generators, ` +
      `${subset.catalogue.length} catalogue images (dataset sha ${subset.dataset_sha?.slice(0, 12) ?? '?'})`,
  );
  console.log('Hashing evidence (real dHash over decoded pixels)...');

  const batch = buildLiveBatch(subset, evidence_bytes, config.policy.merchant_id);
  console.log(`Built ${batch.claims.length} claims across ${new Set(batch.cases.map((c) => c.scenario)).size} classes.`);

  // ---- pick the LLM adapter --------------------------------------------------
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
  const effort = (process.env.ANTHROPIC_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';
  let llm: LlmAdapter;
  let uploaded = new Map<string, string>();
  const excluded_claims: Array<{ claim_id: string; reason: string }> = [];

  if (BYTES_CHECK) {
    // No network. Proves the bytes path end to end: the mock adapter records
    // whether it was handed base64, so `saw_image_bytes` below is a measurement
    // rather than an assumption.
    console.log('\n--bytes-check: MOCK adapter, no network. Verifying image bytes reach the adapter.');
    llm = createMockLlmAdapter({
      script: new Map(),
      fallback: scriptedVerdict({
        supports_claim: 'insufficient',
        confidence: 0.4,
        reasoning: 'bytes-check run: no judgement is being made here.',
      }),
      model_version: 'bytes-check-mock',
    });
  } else {
    if (llmMode() !== 'live') {
      console.error(
        '\nLLM_MODE is not "live". Refusing to produce a run labelled live from mock verdicts.\n' +
          'Set LLM_MODE=live (with ANTHROPIC_API_KEY in .env), or pass --bytes-check.',
      );
      process.exitCode = 1;
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('\nANTHROPIC_API_KEY is not set. Add it to .env before running live.');
      process.exitCode = 1;
      return;
    }
    llm = createLiveLlmAdapter({ model, effort });

    // Evidence too large to inline goes through the Files API. Anything that
    // cannot be transported at all is dropped from the batch and reported -
    // never quietly downgraded to a reference-only request.
    const oversized = [
      ...new Set(
        batch.evidence
          .filter((e) => evidence_bytes.size(e.image_ref) > INLINE_BYTE_CAP)
          .map((e) => e.image_ref),
      ),
    ];
    if (oversized.length > 0) {
      console.log(`\n${oversized.length} evidence files exceed the inline cap; uploading via the Files API:`);
      const result = await uploadOversized(new Anthropic({ maxRetries: 1 }), oversized);
      uploaded = result.uploaded;
      for (const [ref, reason] of result.failed) {
        for (const ev of batch.evidence.filter((e) => e.image_ref === ref)) {
          excluded_claims.push({
            claim_id: ev.claim_id,
            reason: `evidence ${ref} could not be transported to the model (${reason.slice(0, 100)})`,
          });
        }
      }
    }
  }

  const dropped = new Set(excluded_claims.map((e) => e.claim_id));
  let claims = batch.claims.filter((c) => !dropped.has(c.id));
  if (SMOKE) claims = claims.slice(0, 1);

  // ---- run the real pipeline; only the LLM adapter is live -------------------
  const payments = createPaymentsAdapter({ orders: batch.orders, payments: batch.payments });
  const store = createStoreAdapter({ claims: batch.claims, evidence: batch.evidence });
  const notifier = createNotifierAdapter();
  const pipeline = createPipeline({
    payments,
    store,
    notifier,
    llm,
    config,
    catalogue: batch.catalogue,
    shared_index: batch.shared_index,
    evidence_bytes,
    uploaded,
  });

  const caseById = new Map(batch.cases.map((c) => [c.claim_id, c]));
  const results: PipelineResult[] = [];
  console.log(`\nResolving ${claims.length} claims (${BYTES_CHECK ? 'mock' : `live: ${model}, effort ${effort}`})...\n`);

  for (const claim of claims) {
    const r = await pipeline.resolve(claim);
    results.push(r);
    const c = caseById.get(claim.id)!;
    console.log(
      `${claim.id}  ${c.scenario.padEnd(23)} ${r.decision.outcome.padEnd(15)} ` +
        `INR ${String(claim.amount_inr).padStart(6)}  ` +
        `${describeAll(r.decision.reason_codes as ReasonCode[])}`,
    );
    console.log(`           ${r.summary.slice(0, 140)}`);
  }

  // ---- the assertion that makes the label honest ----------------------------
  const verified = results.filter((r) => r.verifier !== null);
  const blind = verified.filter((r) => r.verifier?.ok && r.verifier.references_only);
  if (!BYTES_CHECK && blind.length > 0) {
    console.error(
      `\nABORT: ${blind.length} verified claims were sent image REFERENCES, not image bytes. ` +
        'A run like that cannot be labelled live. Nothing was written.',
    );
    process.exitCode = 1;
    return;
  }
  const sawBytes = verified.filter((r) => r.verifier?.ok && !r.verifier.references_only).length;
  console.log(
    `\n${verified.length} claims reached the verifier; ${sawBytes} of them were sent real image bytes.`,
  );
  if (BYTES_CHECK) {
    const ok = verified.length > 0 && sawBytes === verified.filter((r) => r.verifier?.ok).length;
    console.log(ok ? 'bytes-check PASSED.' : 'bytes-check FAILED.');
    if (!ok) process.exitCode = 1;
    return;
  }

  // ---- B2: the VLM-only baseline, run for real on the same images -----------
  const b2 = new Map<string, VlmVerdict>();
  if (!SKIP_B2) {
    console.log('\nRunning the B2 VLM-only baseline on the same images...');
    for (const r of results) {
      const ref = r.claim.image_refs[0];
      if (!ref) continue;
      const v = await runVlmBaseline(r.claim.id, ref, {
        llm,
        evidence_bytes,
        uploaded,
        timeout_ms: config.thresholds.verifier.timeout_ms,
      });
      b2.set(r.claim.id, v);
      console.log(`  ${r.claim.id}  ${v.assessment.padEnd(14)} conf ${v.confidence?.toFixed(2) ?? 'n/a'}`);
    }
  }

  // ---- write the run --------------------------------------------------------
  const records: LiveRunRecord[] = results.map((r) => {
    const c = caseById.get(r.claim.id)!;
    const verdict = r.verifier?.ok ? r.verifier.verdict : null;
    return {
      claim_id: r.claim.id,
      scenario: c.scenario,
      ground_truth: c.ground_truth,
      rationale: c.rationale,
      expected_layer: c.expected_layer,
      product_title: c.product_title,
      rcie_category: c.rcie_category,
      provenance: c.provenance,
      amount_inr: r.claim.amount_inr,
      outcome: r.decision.outcome,
      reason_codes: r.decision.reason_codes,
      decision_basis: r.decision_basis,
      summary: r.summary,
      confidence: r.decision.confidence,
      required_confidence: r.required_confidence,
      injection_suspected: r.injection_suspected,
      sanitiser_signals: r.sanitised.signals.map((s) => s.id),
      silent_review_repaired: r.silent_review_repaired,
      l1_passed: r.gate?.passed ?? false,
      l1_reason_codes: r.gate?.reason_codes ?? [],
      reuse_similarity: r.reuse?.max_similarity ?? null,
      reuse_source: r.reuse?.best?.source ?? null,
      verifier_ok: r.verifier === null ? null : r.verifier.ok,
      verifier_failure: r.verifier && !r.verifier.ok ? r.verifier.failure : null,
      supports_claim: verdict?.supports_claim ?? null,
      sku_match: verdict?.sku_match ?? null,
      internal_consistency: verdict?.internal_consistency ?? null,
      contradictions: verdict?.contradictions ?? [],
      verifier_reasoning: verdict?.reasoning ?? '',
      saw_image_bytes: r.verifier?.ok ? !r.verifier.references_only : false,
      model_call: !r.resolved_without_model_call,
      input_tokens: r.spend.input_tokens,
      output_tokens: r.spend.output_tokens,
      cost_inr: costOf(r.spend, config),
      latency_ms: r.decision.latency_ms,
      b2: b2.get(r.claim.id) ?? null,
    };
  });

  const run: LiveRun = {
    generated_at: new Date().toISOString(),
    mode,
    llm_mode: llmMode(),
    model,
    effort,
    prompt_version: 'l3-verifier-v1',
    b2_prompt_version: VLM_PROMPT_VERSION,
    config_snapshot_id: config.snapshot_id,
    dataset: subset.dataset,
    dataset_sha: subset.dataset_sha,
    fetched_at: subset.fetched_at,
    usd_inr: 88,
    excluded: batch.excluded,
    excluded_claims,
    records,
  };

  writeFileSync(resolve(process.cwd(), OUT_PATH), `${JSON.stringify(run, null, 2)}\n`, 'utf8');

  const totalCost = records.reduce((s, r) => s + r.cost_inr, 0);
  const inTok = records.reduce((s, r) => s + r.input_tokens, 0);
  const outTok = records.reduce((s, r) => s + r.output_tokens, 0);
  console.log(`\nWrote ${records.length} records to ${OUT_PATH}`);
  console.log(`L3 spend: ${inTok} input + ${outTok} output tokens, INR ${totalCost.toFixed(3)} at configured prices.`);
  console.log('Next: `npm run eval` to regenerate eval/RESULTS.md from this run.');
}

await main();
