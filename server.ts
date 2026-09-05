/**
 * npm run demo:server
 *
 * A thin local demo server around the existing pipeline. Two things only:
 *
 *  - serves dashboard/index.html (built by `npm run dashboard`, generated on
 *    first request if missing) and any static asset under dashboard/
 *  - POST /api/run: runs a real batch through the unmodified pipeline
 *    (layers/pipeline.ts, imported as-is) with a LIVE L3 verifier
 *    (LLM_MODE=live) while payments/store/notifier stay MODE=mock - exactly
 *    the narrow seam shared/mode.ts defines and eval/live_batch.ts already
 *    uses. Progress streams to the browser over SSE, driven by the
 *    pipeline's own audit events as they actually fire - nothing here is
 *    pre-rendered.
 *
 * Claims come from eval/fraudbench/cases.ts's buildLiveBatch (the same
 * builder eval/live_batch.ts uses), not eval/fixtures/index.ts. That fixture
 * set mixes placeholder://-refs with real FraudBench images on the same
 * claim; a live evidence load throws on the placeholder before the model
 * ever sees the real photo, so every L3-reaching claim would fail closed as
 * "evidence_unreadable" and the panel would show nothing but fail-safe
 * REVIEWs instead of "the returned verdict + confidence". buildLiveBatch's
 * claims carry only real, on-disk FraudBench images, so the live verifier
 * actually runs. It covers 4 of SPEC §9's five cases directly (sku_mismatch,
 * ai_edited_damage, genuine_damaged, injection_attempt); "a case the system
 * got wrong" is flagged dynamically from whatever the run actually
 * misclassifies, rather than scripted.
 *
 * MONEY SAFETY: no adapter is constructed here that this repo does not
 * already ship, MODE is never set to "live", and createPipeline is imported
 * unmodified. There is no money-moving code path added by this file.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { currentMode, llmMode } from './shared/mode.ts';
import { loadConfig } from './shared/config/index.ts';
import { createPaymentsAdapter } from './shared/adapters/payments.ts';
import { createStoreAdapter, type StoreAdapter } from './shared/adapters/store.ts';
import { createNotifierAdapter } from './shared/adapters/notifier.ts';
import { createLiveLlmAdapter, llmProvider, type LiveLlmOptions } from './shared/adapters/llm.ts';
import { createLocalFileEvidenceAdapter } from './shared/adapters/evidence.ts';
import { createPipeline, type PipelineResult } from './layers/pipeline.ts';
import { loadFraudBenchSubset } from './eval/fraudbench/loader.ts';
import { buildLiveBatch, type LiveCase } from './eval/fraudbench/cases.ts';
import type { AuditEvent } from './shared/types.ts';

const PORT = Number(process.env.PORT ?? 8787);
const DASHBOARD_DIR = resolve(process.cwd(), 'dashboard');
const DASHBOARD_HTML = resolve(DASHBOARD_DIR, 'index.html');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// A decorator around the existing StoreAdapter, not a new adapter: forwards
// every call unchanged and additionally streams each audit event the moment
// it is appended, so the browser sees L0/L1/L3/L4 events in the exact order
// the pipeline itself produces them - the proof this is a real run.
// ---------------------------------------------------------------------------
function withAuditStream(inner: StoreAdapter, onAudit: (e: AuditEvent) => void): StoreAdapter {
  return {
    kind: inner.kind,
    getClaim: (id) => inner.getClaim(id),
    listClaims: () => inner.listClaims(),
    listPriorClaimsByCustomer: (c, b) => inner.listPriorClaimsByCustomer(c, b),
    listPriorClaimsByOrder: (o, b) => inner.listPriorClaimsByOrder(o, b),
    listEvidenceForClaim: (id) => inner.listEvidenceForClaim(id),
    saveDecision: (d) => inner.saveDecision(d),
    getDecision: (id) => inner.getDecision(id),
    listDecisions: () => inner.listDecisions(),
    saveReuseHit: (h) => inner.saveReuseHit(h),
    listReuseHits: (id) => inner.listReuseHits(id),
    appendAudit: (e) => {
      onAudit(e);
      inner.appendAudit(e);
    },
    listAudit: (id) => inner.listAudit(id),
    allAudit: () => inner.allAudit(),
    saveHumanReview: (r) => inner.saveHumanReview(r),
    listHumanReviews: (id) => inner.listHumanReviews(id),
  };
}

function ensureDashboardBuilt(): void {
  if (existsSync(DASHBOARD_HTML)) return;
  console.log('dashboard/index.html not found - building it once via `npm run dashboard`...');
  const result = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', 'dashboard/generate.ts'],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  if (result.status !== 0) {
    console.error(
      'Could not generate dashboard/index.html. Run `npm run dashboard` manually, then restart this server.',
    );
    process.exit(1);
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const filePath = resolve(DASHBOARD_DIR, rel);
  if (!filePath.startsWith(DASHBOARD_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  const type = MIME[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }).end(readFileSync(filePath));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data.trim()) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        resolvePromise({});
      }
    });
    req.on('error', reject);
  });
}

let runInProgress = false;

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (runInProgress) {
    res
      .writeHead(409, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ message: 'a run is already in progress - wait for it to finish' }));
    return;
  }

  const body = await readJsonBody(req);
  const scope: 'sample' | 'full' = body['scope'] === 'full' ? 'full' : 'sample';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  runInProgress = true;
  try {
    // -- preflight: fail fast and honestly over the stream, never downgrade.
    // The API-key check itself lives in createLiveLlmAdapter (provider-aware,
    // shared/adapters/llm.ts) - it throws a clear Error caught below.
    process.env.LLM_MODE = 'live'; // the narrow, one-directional seam shared/mode.ts defines
    if (currentMode() !== 'mock') {
      send('error', {
        message: `MODE must stay "mock" for this server (got "${currentMode()}"). Only the L3 verifier goes live - see shared/mode.ts.`,
      });
      return;
    }

    const config = loadConfig();
    const subset = loadFraudBenchSubset();
    if (!subset.present) {
      send('error', {
        message: `No local FraudBench subset: ${subset.note}. Run \`npm run fetch:fraudbench\` first.`,
      });
      return;
    }

    send('log', {
      message: `preparing live batch from ${subset.samples.length} FraudBench samples (hashing real pixels)...`,
    });
    const evidence_bytes = createLocalFileEvidenceAdapter();
    const batch = buildLiveBatch(subset, evidence_bytes, config.policy.merchant_id);

    let claims = batch.claims;
    let cases = batch.cases;
    if (scope === 'sample') {
      const seen = new Set<string>();
      const picked: LiveCase[] = [];
      for (const c of cases) {
        if (seen.has(c.scenario)) continue;
        seen.add(c.scenario);
        picked.push(c);
      }
      const pickedIds = new Set(picked.map((c) => c.claim_id));
      claims = claims.filter((c) => pickedIds.has(c.id));
      cases = picked;
    }
    const caseById = new Map(cases.map((c) => [c.claim_id, c]));

    const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
    const effort = (process.env.ANTHROPIC_EFFORT as LiveLlmOptions['effort']) ?? 'medium';

    // Build the adapter BEFORE announcing the run, so `start` reports the model
    // that will actually answer rather than the Anthropic-shaped inputs above.
    // On the Gemini path createLiveLlmAdapter ignores model/effort and reads
    // GEMINI_MODEL itself (see llm.ts), so `llm.model_version` is the only
    // honest label - reporting `model` here would print "claude-opus-5" over a
    // run Gemini performed. `effort` is Anthropic-only and is reported as null
    // elsewhere for the same reason. Constructing it early also means a missing
    // API key fails before the panel claims a run has begun.
    const provider = llmProvider();
    const llm = createLiveLlmAdapter({ model, effort });

    send('start', {
      scope,
      claims: claims.length,
      provider,
      model: llm.model_version,
      effort: provider === 'anthropic' ? effort : null,
      dataset_sha: subset.dataset_sha,
      mode: currentMode(),
      llm_mode: llmMode(),
    });

    const payments = createPaymentsAdapter({ orders: batch.orders, payments: batch.payments });
    const rawStore = createStoreAdapter({ claims: batch.claims, evidence: batch.evidence });
    const store = withAuditStream(rawStore, (e) =>
      send('audit', {
        claim_id: e.claim_id,
        layer: e.layer,
        event: e.event,
        detail: e.detail ?? null,
        timestamp: e.timestamp,
      }),
    );
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
    });

    const results: PipelineResult[] = [];
    for (const claim of claims) {
      if (aborted) break;
      const c = caseById.get(claim.id)!;
      send('claim_start', {
        claim_id: claim.id,
        scenario: c.scenario,
        ground_truth: c.ground_truth,
        rationale: c.rationale,
        product_title: c.product_title,
        order_id: claim.order_id,
        amount_inr: claim.amount_inr,
        provenance: c.provenance,
      });

      const r = await pipeline.resolve(claim);
      results.push(r);

      const mismatch =
        (c.ground_truth === 'should_hold' && r.decision.outcome === 'APPROVE') ||
        (c.ground_truth === 'should_release' && r.decision.outcome !== 'APPROVE');

      send('claim_done', {
        claim_id: claim.id,
        scenario: c.scenario,
        ground_truth: c.ground_truth,
        outcome: r.decision.outcome,
        reason_codes: r.decision.reason_codes,
        confidence: r.decision.confidence,
        exposure_inr: r.decision.exposure_inr,
        decision_basis: r.decision_basis,
        summary: r.summary,
        resolved_without_model_call: r.resolved_without_model_call,
        l1_checks: r.gate?.checks ?? [],
        verifier: r.verifier?.ok
          ? { ...r.verifier.verdict, model_version: r.verifier.model_version }
          : r.verifier
            ? { failure: r.verifier.failure, message: r.verifier.message }
            : null,
        cost_inr: r.decision.cost_inr,
        latency_ms: r.decision.latency_ms,
        mismatch,
      });
    }

    if (aborted) {
      send('log', { message: 'client disconnected - run stopped early, no further model calls made' });
      return;
    }

    const held = results
      .filter((r) => r.decision.outcome !== 'APPROVE')
      .reduce((s, r) => s + r.decision.exposure_inr, 0);
    const released = results
      .filter((r) => r.decision.outcome === 'APPROVE')
      .reduce((s, r) => s + r.decision.exposure_inr, 0);
    const noModel = results.filter((r) => r.resolved_without_model_call).length;
    const outcomeCounts = { APPROVE: 0, REVIEW: 0, DENY_RECOMMEND: 0 };
    for (const r of results) outcomeCounts[r.decision.outcome] += 1;

    send('summary', {
      claims: results.length,
      inr_held: held,
      inr_released: released,
      review_queue_depth: notifier.queued().length,
      resolved_without_model_call: noModel,
      resolved_without_model_call_pct: results.length === 0 ? 0 : (noModel / results.length) * 100,
      outcome_counts: outcomeCounts,
      total_cost_inr: results.reduce((s, r) => s + r.decision.cost_inr, 0),
      excluded: batch.excluded,
    });
    send('done', {});
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    runInProgress = false;
    res.end();
  }
}

ensureDashboardBuilt();

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'POST' && url.startsWith('/api/run')) {
    void handleRun(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain' }).end('method not allowed');
});

server.listen(PORT, () => {
  console.log(`RCIE demo server: http://localhost:${PORT}`);
  console.log(
    'MODE stays mock; POST /api/run runs the L3 verifier live (LLM_MODE=live) against the fetched FraudBench subset.',
  );
});
