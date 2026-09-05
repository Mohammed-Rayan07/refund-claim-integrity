/**
 * npm run dashboard  (SPEC §3 F7)
 *
 * Runs the synthetic batch through the full pipeline in MODE=mock, adds a
 * sample of human reviews (F15) and a full replay integrity sweep (F13), then
 * writes a single self-contained, dependency-free `dashboard/index.html`:
 * claim cards, an evidence/reuse graph, the reason-code legend, a full audit
 * trail per claim, the human-feedback agreement rate, and the portfolio view
 * (INR held, INR released, review queue depth, % resolved without a model call).
 *
 * No CDN, no framework, no server: open the file in a browser. Static
 * generation matches the project's existing pattern (`eval/report.ts` does the
 * same for the markdown results table) and needs no new dependency for a
 * 24-hour build.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentMode } from '../shared/mode.ts';
import { loadConfig } from '../shared/config/index.ts';
import { createPaymentsAdapter } from '../shared/adapters/payments.ts';
import { createStoreAdapter } from '../shared/adapters/store.ts';
import { createNotifierAdapter } from '../shared/adapters/notifier.ts';
import { createMockLlmAdapter, type MockScriptEntry } from '../shared/adapters/llm.ts';
import { REASON_CODES, OPERATOR_ADDED_CODES, type ReasonCode } from '../shared/lib/reasoncodes.ts';
import { replayDecision } from '../shared/lib/replay.ts';
import { recordHumanReview, agreementReport } from '../shared/lib/feedback.ts';
import { AuditLogger } from '../shared/lib/logger.ts';
import { createPipeline, type PipelineResult } from '../layers/pipeline.ts';
import { buildFixtures, UNSCRIPTED_FALLBACK, type FixtureCase } from '../eval/fixtures/index.ts';
import { loadFraudBenchSubset } from '../eval/fraudbench/loader.ts';
import { loadLiveRun, computeLiveMetrics } from '../eval/live_report.ts';
import type { Decision, Outcome } from '../shared/types.ts';

const MODEL_VERSION = 'claude-opus-5-mock';

async function main(): Promise<void> {
  const config = loadConfig();
  const fraudbench = loadFraudBenchSubset();
  const fixtures = buildFixtures(fraudbench);
  const caseById = new Map<string, FixtureCase>(fixtures.cases.map((c) => [c.claim_id, c]));

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

  const results: PipelineResult[] = [];
  for (const claim of fixtures.claims) results.push(await pipeline.resolve(claim));

  // ---- F15: a representative sample of reviewer verdicts ---------------------
  const feedbackAudit = new AuditLogger({ append: (e) => store.appendAudit(e) });
  const reviewPlan: Array<{ pick: (r: PipelineResult) => boolean; verdict: Outcome; note: string; limit: number }> = [
    { pick: (r) => r.decision.outcome === 'DENY_RECOMMEND', verdict: 'DENY_RECOMMEND', note: 'reviewer confirms the deny recommendation', limit: 6 },
    { pick: (r) => r.decision.outcome === 'REVIEW' && r.decision_basis === 'confidence_below_threshold', verdict: 'APPROVE', note: 'reviewer inspected the photos directly and released the refund - the confidence bar was conservative here', limit: 4 },
    { pick: (r) => r.decision.outcome === 'REVIEW' && r.decision_basis === 'verifier_abstained', verdict: 'REVIEW', note: 'reviewer agrees the photos are unusable, requested better ones', limit: 3 },
    { pick: (r) => caseById.get(r.claim.id)?.scenario === 'missed_fabrication', verdict: 'DENY_RECOMMEND', note: 'later investigation confirmed self-inflicted damage - overriding the approval', limit: 2 },
    { pick: (r) => caseById.get(r.claim.id)?.scenario === 'injection_attempt', verdict: 'REVIEW', note: 'reviewer confirms this was an injection attempt', limit: 2 },
  ];
  const reviewedIds = new Set<string>();
  for (const plan of reviewPlan) {
    let n = 0;
    for (const r of results) {
      if (n >= plan.limit) break;
      if (reviewedIds.has(r.claim.id) || !plan.pick(r)) continue;
      await recordHumanReview(
        { claim_id: r.claim.id, reviewer: 'reviewer_demo', verdict: plan.verdict, notes: plan.note },
        { store, audit: feedbackAudit },
      );
      reviewedIds.add(r.claim.id);
      n += 1;
    }
  }
  const allReviews = await store.listHumanReviews();
  const decisionsByClaimId = new Map<string, Decision>((await store.listDecisions()).map((d) => [d.claim_id, d]));
  const agreement = agreementReport(allReviews, decisionsByClaimId);

  // ---- F13: replay every decided claim, report integrity ---------------------
  let replayOk = 0;
  let replayChecked = 0;
  const replayDiverged: string[] = [];
  for (const r of results) {
    replayChecked += 1;
    const report = await replayDecision(r.claim.id, { payments, store, config });
    if (report.matches) replayOk += 1;
    else replayDiverged.push(r.claim.id);
  }

  // ---- portfolio -------------------------------------------------------------
  const held = results.filter((r) => r.decision.outcome !== 'APPROVE').reduce((s, r) => s + r.decision.exposure_inr, 0);
  const released = results.filter((r) => r.decision.outcome === 'APPROVE').reduce((s, r) => s + r.decision.exposure_inr, 0);
  const noModel = results.filter((r) => r.resolved_without_model_call).length;
  const outcomeCounts: Record<Outcome, number> = { APPROVE: 0, REVIEW: 0, DENY_RECOMMEND: 0 };
  for (const r of results) outcomeCounts[r.decision.outcome] += 1;

  // ---- reuse graph edges (F3), read back from the audit trail -----------------
  type ReuseEdge = { claim_id: string; source: string; matched_ref: string; similarity: number };
  const reuseEdges: ReuseEdge[] = [];
  for (const claim of fixtures.claims) {
    const hits = await store.listReuseHits(claim.id);
    for (const h of hits) {
      reuseEdges.push({
        claim_id: claim.id,
        source: h.source,
        matched_ref: h.catalogue_ref ?? h.matched_claim_id ?? 'shared-index',
        similarity: h.similarity,
      });
    }
  }

  // ---- per-claim payload for the client-side table + audit viewer ------------
  const claims = results.map((r) => {
    const c = caseById.get(r.claim.id);
    return {
      id: r.claim.id,
      order_id: r.claim.order_id,
      customer_id: r.claim.customer_id,
      scenario: c?.scenario ?? 'fraudbench',
      note: c?.note ?? '',
      ground_truth: c?.ground_truth ?? null,
      outcome: r.decision.outcome,
      reason_codes: r.decision.reason_codes,
      confidence: r.decision.confidence,
      exposure_inr: r.decision.exposure_inr,
      decision_basis: r.decision_basis,
      summary: r.summary,
      resolved_without_model_call: r.resolved_without_model_call,
      image_refs: r.claim.image_refs,
      audit: store.listAudit(r.claim.id).map((e) => ({
        layer: e.layer,
        event: e.event,
        timestamp: e.timestamp,
        detail: e.detail ?? null,
      })),
      review: allReviews.find((rv) => rv.claim_id === r.claim.id) ?? null,
    };
  });

  const reasonCodeLegend = Object.entries(REASON_CODES).map(([code, name]) => ({
    code,
    name,
    operator_added: OPERATOR_ADDED_CODES.includes(code as ReasonCode),
  }));

  // ---- live run (LLM_MODE=live), only if eval/live-run.json exists ------------
  const liveRun = loadLiveRun();
  const live = liveRun
    ? (() => {
        const b = computeLiveMetrics(liveRun);
        return {
          present: true,
          model: liveRun.model,
          effort: liveRun.effort,
          dataset_sha: liveRun.dataset_sha,
          fetched_at: liveRun.fetched_at,
          generated_at: liveRun.generated_at,
          claims: liveRun.records.length,
          metrics: b.metrics,
          confidence: b.confidence,
          holdout: b.holdout,
          injection: b.injection,
          total_cost_inr: b.totalCostInr,
          total_input_tokens: b.totalInputTokens,
          total_output_tokens: b.totalOutputTokens,
          mean_latency_ms: b.meanLatencyMs,
          p95_latency_ms: b.p95LatencyMs,
          bytes_verified: b.bytesVerified,
          excluded: liveRun.excluded,
          excluded_claims: liveRun.excluded_claims,
          records: liveRun.records.map((r) => ({
            id: r.claim_id,
            scenario: r.scenario,
            ground_truth: r.ground_truth,
            product_title: r.product_title,
            amount_inr: r.amount_inr,
            outcome: r.outcome,
            reason_codes: r.reason_codes,
            confidence: r.confidence,
            decision_basis: r.decision_basis,
            summary: r.summary,
            supports_claim: r.supports_claim,
            sku_match: r.sku_match,
            contradictions: r.contradictions,
            verifier_reasoning: r.verifier_reasoning,
            b2: r.b2,
            provenance: r.provenance,
            saw_image_bytes: r.saw_image_bytes,
            model_call: r.model_call,
          })),
        };
      })()
    : { present: false as const };

  const payload = {
    generated_at: new Date().toISOString(),
    mode: currentMode(),
    config_snapshot_id: config.snapshot_id,
    policy: { version: config.policy.version, merchant_id: config.policy.merchant_id },
    thresholds_version: config.thresholds.version,
    fraudbench_note: fraudbench.note,
    live,
    portfolio: {
      claims: results.length,
      inr_held: held,
      inr_released: released,
      review_queue_depth: notifier.queued().length,
      resolved_without_model_call: noModel,
      resolved_without_model_call_pct: results.length === 0 ? 0 : (noModel / results.length) * 100,
      outcome_counts: outcomeCounts,
    },
    replay: {
      checked: replayChecked,
      matched: replayOk,
      diverged: replayDiverged,
    },
    agreement,
    reason_codes: reasonCodeLegend,
    reuse_edges: reuseEdges,
    claims,
  };

  const html = renderHtml(payload);
  const outPath = resolve(process.cwd(), 'dashboard/index.html');
  writeFileSync(outPath, html, 'utf8');
  console.log(`dashboard written to ${outPath}`);
  console.log(
    `${results.length} claims, INR ${held} held, INR ${released} released, ` +
      `replay ${replayOk}/${replayChecked} matched, agreement ${(agreement.overall_agreement_rate * 100).toFixed(1)}% ` +
      `over ${agreement.total_reviews} reviews`,
  );
}

function renderHtml(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RCIE Dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0f14; --panel: #121821; --panel-2: #171f2b; --border: #26313f;
    --text: #e7edf3; --muted: #93a3b3; --accent: #5aa9ff;
    --approve: #34c98a; --review: #e8b93d; --deny: #ef5a5a; --op: #a074e8;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) { --bg:#f5f7fa; --panel:#ffffff; --panel-2:#f0f3f7; --border:#dbe2ea; --text:#182230; --muted:#5c6b7a; }
  }
  :root[data-theme="light"] { --bg:#f5f7fa; --panel:#ffffff; --panel-2:#f0f3f7; --border:#dbe2ea; --text:#182230; --muted:#5c6b7a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--border); }
  header h1 { margin:0 0 4px; font-size:20px; }
  header .meta { color:var(--muted); font-size:12.5px; }
  .safety { margin-top:10px; padding:10px 12px; background:var(--panel-2); border:1px solid var(--border); border-left:3px solid var(--approve); border-radius:6px; font-size:12.5px; color:var(--muted); }
  main { padding:20px 24px; display:flex; flex-direction:column; gap:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .stat { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .stat .label { color:var(--muted); font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; }
  .stat .value { font-size:22px; font-weight:600; margin-top:4px; }
  .stat .sub { color:var(--muted); font-size:11.5px; margin-top:2px; }
  section { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
  section h2 { margin:0 0 12px; font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .outcome { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11.5px; font-weight:600; }
  .outcome.APPROVE { background:color-mix(in srgb, var(--approve) 20%, transparent); color:var(--approve); }
  .outcome.REVIEW { background:color-mix(in srgb, var(--review) 20%, transparent); color:var(--review); }
  .outcome.DENY_RECOMMEND { background:color-mix(in srgb, var(--deny) 20%, transparent); color:var(--deny); }
  .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
  .toolbar button { background:var(--panel-2); border:1px solid var(--border); color:var(--text); padding:6px 12px; border-radius:6px; cursor:pointer; font-size:12.5px; }
  .toolbar button.active { border-color:var(--accent); color:var(--accent); }
  .toolbar input { background:var(--panel-2); border:1px solid var(--border); color:var(--text); padding:6px 10px; border-radius:6px; font-size:12.5px; flex:1; min-width:160px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; }
  tbody tr { cursor:pointer; }
  tbody tr:hover { background:var(--panel-2); }
  .claim-row.op-added td:first-child { border-left:2px solid var(--op); }
  .detail { display:none; background:var(--panel-2); border-top:1px solid var(--border); }
  .detail.open { display:table-row; }
  .detail pre { margin:0; padding:12px; white-space:pre-wrap; word-break:break-word; font-size:11.5px; color:var(--muted); max-height:360px; overflow:auto; }
  .codes span { display:inline-block; background:var(--panel-2); border:1px solid var(--border); border-radius:4px; padding:1px 6px; margin:1px; font-size:11px; }
  .legend { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:4px 16px; font-size:12px; }
  .legend .op { color:var(--op); }
  .graph { display:flex; flex-wrap:wrap; gap:10px; }
  .edge { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-size:12px; min-width:220px; }
  .edge .sim { color:var(--accent); font-weight:600; }
  .muted { color:var(--muted); }
  .small { font-size:11.5px; }
  .bars { display:flex; flex-direction:column; gap:6px; }
  .bar-row { display:grid; grid-template-columns:160px 1fr 60px; gap:8px; align-items:center; font-size:12px; }
  .bar-track { background:var(--panel-2); border-radius:4px; height:10px; overflow:hidden; }
  .bar-fill { background:var(--accent); height:100%; }
  footer { padding:20px 24px 40px; color:var(--muted); font-size:11.5px; }
  .live-section { border-left:3px solid var(--accent); }
  .live-badge { display:inline-block; background:var(--accent); color:#fff; font-size:10.5px; font-weight:700; letter-spacing:.04em; padding:1px 7px; border-radius:999px; margin-right:8px; vertical-align:middle; }
  .live-empty { color:var(--muted); font-size:12.5px; }
  .live-empty code { background:var(--panel-2); padding:1px 5px; border-radius:4px; }
  .run-controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
  .run-controls button { background:var(--accent); color:#08131f; border:none; padding:8px 14px; border-radius:6px; cursor:pointer; font-size:12.5px; font-weight:600; }
  .run-controls button.secondary { background:var(--panel-2); color:var(--text); border:1px solid var(--border); }
  .run-controls button:disabled { opacity:.5; cursor:default; }
  .run-status { color:var(--muted); font-size:12.5px; }
  .log-panel { background:#05080c; color:#8fd48f; font-family:ui-monospace,Consolas,monospace; font-size:11.5px; line-height:1.5; padding:12px; border-radius:8px; height:220px; overflow-y:auto; white-space:pre-wrap; word-break:break-word; border:1px solid var(--border); }
  .live-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:10px; margin-top:14px; }
  .live-card { background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; font-size:12px; }
  .live-card.mismatch { border-color:var(--deny); box-shadow:0 0 0 1px var(--deny); }
  .live-card .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; gap:8px; }
  .live-card .scn { color:var(--muted); font-size:11px; margin-bottom:6px; }
  .live-card .summ { color:var(--muted); font-size:11px; margin-top:6px; }
  .live-card .wrong-badge { display:inline-block; background:var(--deny); color:#fff; font-size:10px; font-weight:700; padding:1px 6px; border-radius:999px; margin-left:6px; }
</style>
</head>
<body>
<header>
  <h1>Refund Claim Integrity Engine — Dashboard</h1>
  <div class="meta" id="meta"></div>
  <div class="safety">This project is strictly defense-only. It contains no capability to generate, edit, or synthesise fraudulent refund evidence. RCIE never moves money — DENY_RECOMMEND is a recommendation to a human, never an executed denial.</div>
</header>
<main>
  <div class="grid" id="portfolio"></div>

  <section>
    <h2>Run pipeline (live, right now)</h2>
    <p class="muted small">Runs the real, unmodified pipeline against real FraudBench images with a live L3 verifier (LLM_MODE=live) - payments/store/notifier stay mock. Requires <code>npm run demo:server</code> to be running and the configured provider's API key set in <code>.env</code> (<code>GEMINI_API_KEY</code> by default; <code>ANTHROPIC_API_KEY</code> if <code>LLM_PROVIDER=anthropic</code>). This calls a real LLM API and spends real tokens.</p>
    <div class="run-controls">
      <button id="run-sample">Run sample (1 claim per case)</button>
      <button id="run-full" class="secondary">Run full batch</button>
      <span class="run-status" id="run-status"></span>
    </div>
    <div class="log-panel" id="run-log"></div>
    <div class="live-cards" id="run-cards"></div>
    <div class="grid" id="run-portfolio" style="margin-top:14px;"></div>
  </section>

  <section class="live-section">
    <h2><span class="live-badge">LIVE</span>Live verifier run (LLM_MODE=live, real FraudBench images)</h2>
    <div id="live-body"></div>
  </section>

  <section>
    <h2>Claims (MODE=mock, scripted routing batch)</h2>
    <div class="toolbar" id="toolbar">
      <input type="text" id="search" placeholder="search claim id, order id, sku, scenario..." />
    </div>
    <table>
      <thead><tr><th>Claim</th><th>Scenario</th><th>Outcome</th><th>Reason codes</th><th>Conf</th><th>Exposure (INR)</th><th>Basis</th></tr></thead>
      <tbody id="claim-rows"></tbody>
    </table>
  </section>

  <section>
    <h2>Evidence reuse graph (F3)</h2>
    <p class="muted small">Claim → matched source. Hashes only — no image is ever compared or shared, only fingerprints.</p>
    <div class="graph" id="reuse-graph"></div>
  </section>

  <section>
    <h2>Human feedback / agreement rate (F15)</h2>
    <div id="agreement"></div>
  </section>

  <section>
    <h2>Deterministic replay integrity (F13)</h2>
    <div id="replay"></div>
  </section>

  <section>
    <h2>Reason code legend (F5)</h2>
    <div class="legend" id="legend"></div>
    <p class="muted small" style="margin-top:10px;">RCI-13/14/15 (<span class="op">purple</span>) are operator-added beyond SPEC §3 F5's twelve, so no REVIEW is ever silent.</p>
  </section>
</main>
<footer>Generated <span id="gen-at"></span> · MODE=<span id="mode"></span> · config snapshot <span id="snap"></span> · fixtures are synthetic business data + consumed FraudBench samples only — no evidence is generated anywhere in this repo.</footer>

<script type="application/json" id="data">${json}</script>
<script>
(function () {
  const DATA = JSON.parse(document.getElementById('data').textContent);

  document.getElementById('meta').textContent =
    'MODE=' + DATA.mode + ' · policy ' + DATA.policy.version + ' (' + DATA.policy.merchant_id + ') · ' +
    'thresholds ' + DATA.thresholds_version + ' · config snapshot ' + DATA.config_snapshot_id + ' · ' + DATA.fraudbench_note;
  document.getElementById('gen-at').textContent = DATA.generated_at;
  document.getElementById('mode').textContent = DATA.mode;
  document.getElementById('snap').textContent = DATA.config_snapshot_id;

  const p = DATA.portfolio;
  const stats = [
    { label: 'Claims processed', value: p.claims },
    { label: 'INR held (REVIEW + DENY)', value: 'INR ' + p.inr_held.toLocaleString('en-IN') },
    { label: 'INR released (APPROVE)', value: 'INR ' + p.inr_released.toLocaleString('en-IN') },
    { label: 'Review queue depth', value: p.review_queue_depth },
    { label: 'Resolved w/o model call', value: p.resolved_without_model_call + '/' + p.claims, sub: p.resolved_without_model_call_pct.toFixed(1) + '% [F17]' },
    { label: 'APPROVE / REVIEW / DENY', value: p.outcome_counts.APPROVE + ' / ' + p.outcome_counts.REVIEW + ' / ' + p.outcome_counts.DENY_RECOMMEND },
  ];
  document.getElementById('portfolio').innerHTML = stats.map(function (s) {
    return '<div class="stat"><div class="label">' + s.label + '</div><div class="value">' + s.value + '</div>' +
      (s.sub ? '<div class="sub">' + s.sub + '</div>' : '') + '</div>';
  }).join('');

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const tbody = document.getElementById('claim-rows');
  let activeOutcome = null;
  let query = '';

  function codesHtml(codes) {
    if (!codes.length) return '<span class="muted">(none)</span>';
    return '<span class="codes">' + codes.map(function (c) { return '<span>' + c + '</span>'; }).join('') + '</span>';
  }

  function render() {
    const rows = [];
    DATA.claims.forEach(function (c, i) {
      if (activeOutcome && c.outcome !== activeOutcome) return;
      if (query) {
        const hay = (c.id + ' ' + c.order_id + ' ' + c.scenario + ' ' + c.note).toLowerCase();
        if (hay.indexOf(query) === -1) return;
      }
      const opAdded = c.reason_codes.some(function (code) { return ['RCI-13', 'RCI-14', 'RCI-15'].indexOf(code) !== -1; });
      rows.push(
        '<tr class="claim-row' + (opAdded ? ' op-added' : '') + '" data-i="' + i + '">' +
        '<td>' + c.id + '<div class="muted small">' + escHtml(c.order_id) + '</div></td>' +
        '<td>' + escHtml(c.scenario) + '<div class="muted small">' + escHtml(c.note).slice(0, 60) + '</div></td>' +
        '<td><span class="outcome ' + c.outcome + '">' + c.outcome + '</span></td>' +
        '<td>' + codesHtml(c.reason_codes) + '</td>' +
        '<td>' + (c.confidence === null ? '-' : c.confidence.toFixed(2)) + '</td>' +
        '<td>' + c.exposure_inr.toLocaleString('en-IN') + '</td>' +
        '<td class="muted small">' + escHtml(c.decision_basis) + '</td>' +
        '</tr>' +
        '<tr class="detail" id="detail-' + i + '"><td colspan="7"></td></tr>'
      );
    });
    tbody.innerHTML = rows.join('') || '<tr><td colspan="7" class="muted">no claims match</td></tr>';

    tbody.querySelectorAll('.claim-row').forEach(function (row) {
      row.addEventListener('click', function () {
        const i = row.getAttribute('data-i');
        const d = document.getElementById('detail-' + i);
        const open = d.classList.contains('open');
        tbody.querySelectorAll('.detail.open').forEach(function (o) { o.classList.remove('open'); });
        if (!open) {
          const c = DATA.claims[i];
          const reviewHtml = c.review
            ? '<div><b>Human review:</b> reviewer=' + escHtml(c.review.verdict) + ' agreed=' + c.review.agreed_with_system + ' — "' + escHtml(c.review.notes) + '"</div>'
            : '<div class="muted">No human review recorded for this claim.</div>';
          const auditHtml = c.audit.map(function (e) {
            return e.timestamp + '  [' + e.layer + '] ' + e.event + (e.detail ? '\\n  ' + JSON.stringify(e.detail) : '');
          }).join('\\n\\n');
          d.querySelector('td').innerHTML =
            '<div style="padding:12px;"><b>Summary:</b> ' + escHtml(c.summary) + '</div>' +
            '<div style="padding:0 12px 12px;"><b>Evidence:</b> ' + (c.image_refs.map(escHtml).join(', ') || '(none)') + '</div>' +
            '<div style="padding:0 12px 12px;">' + reviewHtml + '</div>' +
            '<div style="padding:0 12px;"><b>Full audit trail</b></div>' +
            '<pre>' + escHtml(auditHtml) + '</pre>';
          d.classList.add('open');
        }
      });
    });
  }

  document.getElementById('search').addEventListener('input', function (e) {
    query = e.target.value.toLowerCase();
    render();
  });

  const toolbar = document.getElementById('toolbar');
  ['APPROVE', 'REVIEW', 'DENY_RECOMMEND'].forEach(function (o) {
    const btn = document.createElement('button');
    btn.textContent = o;
    btn.addEventListener('click', function () {
      activeOutcome = activeOutcome === o ? null : o;
      toolbar.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      if (activeOutcome) btn.classList.add('active');
      render();
    });
    toolbar.appendChild(btn);
  });

  render();

  // reuse graph
  const graph = document.getElementById('reuse-graph');
  if (DATA.reuse_edges.length === 0) {
    graph.innerHTML = '<span class="muted">No reuse hits above the cut in this batch.</span>';
  } else {
    graph.innerHTML = DATA.reuse_edges.map(function (e) {
      return '<div class="edge">' + e.claim_id + ' &rarr; <b>' + escHtml(e.source) + '</b><br/>' +
        '<span class="muted small">' + escHtml(e.matched_ref) + '</span><br/>' +
        'similarity <span class="sim">' + e.similarity.toFixed(2) + '</span></div>';
    }).join('');
  }

  // agreement
  const a = DATA.agreement;
  const agreementEl = document.getElementById('agreement');
  if (a.total_reviews === 0) {
    agreementEl.innerHTML = '<span class="muted">No human reviews recorded.</span>';
  } else {
    const bandsHtml = a.by_confidence_band.map(function (b) {
      return '<div class="bar-row"><span>' + b.label + ' (' + b.reviews + ')</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (b.agreement_rate * 100).toFixed(0) + '%"></div></div>' +
        '<span>' + (b.agreement_rate * 100).toFixed(0) + '%</span></div>';
    }).join('');
    const overridesHtml = a.confident_overrides.length
      ? '<p class="small"><b>Confident overrides</b> (system &ge;0.85 confidence, human disagreed): ' +
        a.confident_overrides.map(function (o) { return o.claim_id + ' (' + o.system_outcome + ' &rarr; ' + o.reviewer_verdict + ')'; }).join(', ') + '</p>'
      : '';
    agreementEl.innerHTML =
      '<p><b>' + (a.overall_agreement_rate * 100).toFixed(1) + '%</b> overall agreement over ' + a.total_reviews + ' reviews. ' +
      '<span class="muted small">Feedback measures drift — it never adjusts a threshold automatically.</span></p>' +
      '<div class="bars">' + bandsHtml + '</div>' + overridesHtml;
  }

  // replay
  const rp = DATA.replay;
  document.getElementById('replay').innerHTML =
    '<p><b>' + rp.matched + '/' + rp.checked + '</b> historical decisions reproduce byte-for-byte from the audit log alone (L1 re-run, L3 verdict replayed from its own logged output, model never re-called).' +
    (rp.diverged.length ? ' <span style="color:var(--deny)">Diverged: ' + rp.diverged.join(', ') + '</span>' : '') + '</p>';

  // legend
  document.getElementById('legend').innerHTML = DATA.reason_codes.map(function (rc) {
    return '<div' + (rc.operator_added ? ' class="op"' : '') + '>' + rc.code + ' — ' + rc.name + '</div>';
  }).join('');

  // live run
  const liveBody = document.getElementById('live-body');
  if (!DATA.live.present) {
    liveBody.innerHTML =
      '<p class="live-empty">No live run present. Run <code>npm run fetch:fraudbench</code> then ' +
      '<code>LLM_MODE=live npm run eval:live</code>, then regenerate this dashboard.</p>';
  } else {
    const lv = DATA.live;
    const m = lv.metrics;
    const liveStats = [
      { label: 'Live claims', value: lv.claims },
      { label: 'Model', value: lv.model + ' (' + lv.effort + ')' },
      { label: 'Real bytes sent', value: lv.bytes_verified + '/' + lv.records.filter(function (r) { return r.model_call; }).length },
      { label: 'Ours precision / recall', value: m['Ours (live)'].precision.toFixed(2) + ' / ' + m['Ours (live)'].recall.toFixed(2) },
      { label: 'Ours false-positive rate', value: (m['Ours (live)'].fpr * 100).toFixed(1) + '%' },
      { label: 'Live spend', value: 'INR ' + lv.total_cost_inr.toFixed(3), sub: lv.total_input_tokens + '/' + lv.total_output_tokens + ' tok in/out' },
    ];
    let html = '<div class="grid" style="margin-bottom:14px;">' + liveStats.map(function (s) {
      return '<div class="stat"><div class="label">' + s.label + '</div><div class="value" style="font-size:17px;">' + s.value + '</div>' +
        (s.sub ? '<div class="sub">' + s.sub + '</div>' : '') + '</div>';
    }).join('') + '</div>';

    html += '<p class="small muted">Dataset sha ' + (lv.dataset_sha ? lv.dataset_sha.slice(0, 12) : 'unknown') +
      ' · fetched ' + lv.fetched_at + ' · run generated ' + lv.generated_at + '. B1/B2/Ours are all computed from real model output on real images — see eval/RESULTS.md for the full breakdown, F10 holdout and confidence histogram.</p>';

    html += '<div style="overflow-x:auto;"><table><thead><tr><th>Claim</th><th>Scenario</th><th>Ground truth</th>' +
      '<th>Outcome</th><th>Conf</th><th>B2 (real)</th><th>Summary</th></tr></thead><tbody>';
    lv.records.forEach(function (r) {
      html += '<tr><td>' + r.id + '<div class="muted small">' + escHtml(r.product_title) + '</div></td>' +
        '<td>' + escHtml(r.scenario) + '</td>' +
        '<td>' + escHtml(r.ground_truth) + '</td>' +
        '<td><span class="outcome ' + r.outcome + '">' + r.outcome + '</span></td>' +
        '<td>' + (r.confidence === null ? '-' : r.confidence.toFixed(2)) + '</td>' +
        '<td>' + (r.b2 ? escHtml(r.b2.assessment) + ' (' + (r.b2.confidence === null ? '-' : r.b2.confidence.toFixed(2)) + ')' : '-') + '</td>' +
        '<td class="muted small">' + escHtml(r.summary).slice(0, 90) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    liveBody.innerHTML = html;
  }
})();

// ---------------------------------------------------------------------------
// "Run pipeline" - POST /api/run (server.ts) and stream the response as SSE.
// Independent of the DATA blob above: this talks to a running demo server,
// not the static payload baked into this file at generate time.
// ---------------------------------------------------------------------------
(function () {
  const logEl = document.getElementById('run-log');
  const cardsEl = document.getElementById('run-cards');
  const portfolioEl = document.getElementById('run-portfolio');
  const statusEl = document.getElementById('run-status');
  const sampleBtn = document.getElementById('run-sample');
  const fullBtn = document.getElementById('run-full');
  if (!logEl || !cardsEl || !portfolioEl || !statusEl || !sampleBtn || !fullBtn) return;

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function log(line) {
    const stamp = new Date().toLocaleTimeString();
    logEl.textContent += '[' + stamp + '] ' + line + '\\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fmtAudit(e) {
    const d = e.detail || {};
    const id = e.claim_id;
    if (e.event === 'verifier_prompt_built') {
      return id + '  [L3] calling the verifier LLM... (' + (d.image_count || 0) + ' image(s), ' + (d.evidence_mode || '?') + ')';
    }
    if (e.event === 'verifier_verdict') {
      return id + '  [L3] verdict: supports_claim=' + d.supports_claim + ' sku_match=' + d.sku_match +
        ' confidence=' + (typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '-') +
        (d.injection_suspected ? '  [INJECTION SUSPECTED]' : '');
    }
    if (e.event === 'verifier_failed') {
      return id + '  [L3] verifier FAILED: ' + d.failure + ' - ' + String(d.message || '').slice(0, 100);
    }
    if (e.event === 'integrity_gate_passed' || e.event === 'integrity_gate_failed') {
      return id + '  [L1] ' + e.event + (d.failed_check ? ' at ' + d.failed_check : '') +
        (d.reason_codes && d.reason_codes.length ? '  ' + d.reason_codes.join(',') : '');
    }
    if (e.event === 'decision_made') {
      return id + '  [L4] decision: ' + d.outcome + (d.reason_codes && d.reason_codes.length ? '  ' + d.reason_codes.join(',') : '');
    }
    return id + '  [' + e.layer + '] ' + e.event;
  }

  function renderPortfolio(p) {
    const stats = [
      { label: 'Claims', value: p.claims },
      { label: 'INR held', value: 'INR ' + p.inr_held.toLocaleString('en-IN') },
      { label: 'INR released', value: 'INR ' + p.inr_released.toLocaleString('en-IN') },
      { label: 'Review queue', value: p.review_queue_depth },
      { label: 'No model call', value: p.resolved_without_model_call + '/' + p.claims },
      { label: 'APPROVE / REVIEW / DENY', value: p.outcome_counts.APPROVE + ' / ' + p.outcome_counts.REVIEW + ' / ' + p.outcome_counts.DENY_RECOMMEND },
    ];
    portfolioEl.innerHTML = stats.map(function (s) {
      return '<div class="stat"><div class="label">' + s.label + '</div><div class="value" style="font-size:17px;">' + s.value + '</div></div>';
    }).join('');
  }

  function addCard(c) {
    const div = document.createElement('div');
    div.className = 'live-card' + (c.mismatch ? ' mismatch' : '');
    div.innerHTML =
      '<div class="top"><b>' + escHtml(c.claim_id) + '</b><span class="outcome ' + c.outcome + '">' + c.outcome + '</span></div>' +
      '<div class="scn">' + escHtml(c.scenario) + ' &middot; ground truth: ' + escHtml(c.ground_truth) +
      (c.mismatch ? '<span class="wrong-badge">GOT IT WRONG</span>' : '') + '</div>' +
      '<div>codes: ' + (c.reason_codes.length ? escHtml(c.reason_codes.join(', ')) : '(none)') +
      ' &middot; conf ' + (c.confidence == null ? '-' : c.confidence.toFixed(2)) + '</div>' +
      '<div class="summ">' + escHtml(c.summary) + '</div>';
    cardsEl.prepend(div);
  }

  let claimsSeen = 0;

  async function run(scope) {
    logEl.textContent = '';
    cardsEl.innerHTML = '';
    portfolioEl.innerHTML = '';
    claimsSeen = 0;
    sampleBtn.disabled = true;
    fullBtn.disabled = true;
    statusEl.textContent = 'starting...';
    try {
      const resp = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: scope }),
      });
      if (resp.status === 409) {
        const j = await resp.json();
        log('ERROR: ' + j.message);
        statusEl.textContent = 'busy';
        return;
      }
      if (!resp.body) throw new Error('no response body (SSE unsupported by this browser)');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\\n\\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(raw);
        }
      }
      statusEl.textContent = 'done';
    } catch (err) {
      log('ERROR: ' + (err && err.message ? err.message : err) + ' - is \`npm run demo:server\` running?');
      statusEl.textContent = 'failed';
    } finally {
      sampleBtn.disabled = false;
      fullBtn.disabled = false;
    }
  }

  function handleFrame(raw) {
    let eventName = 'message';
    let dataStr = '';
    raw.split('\\n').forEach(function (line) {
      if (line.indexOf('event:') === 0) eventName = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) dataStr += line.slice(5).trim();
    });
    if (!dataStr) return;
    let payload;
    try { payload = JSON.parse(dataStr); } catch (e) { return; }
    onEvent(eventName, payload);
  }

  function onEvent(name, payload) {
    if (name === 'error') {
      log('ERROR: ' + payload.message);
      statusEl.textContent = 'error';
      return;
    }
    if (name === 'log') {
      log(payload.message);
      return;
    }
    if (name === 'start') {
      // effort is Anthropic-only; the server sends null on the Gemini path
      // rather than printing an effort that had no bearing on the run.
      var modelLabel = (payload.provider ? payload.provider + '/' : '') + payload.model + (payload.effort ? ' (' + payload.effort + ')' : '');
      log('run started: ' + payload.claims + ' claim(s), model=' + modelLabel + ', MODE=' + payload.mode + ' LLM_MODE=' + payload.llm_mode);
      statusEl.textContent = 'running 0/' + payload.claims;
      return;
    }
    if (name === 'claim_start') {
      log('--- ' + payload.claim_id + ' (' + payload.scenario + ') "' + (payload.product_title || '') + '" INR ' + payload.amount_inr);
      return;
    }
    if (name === 'audit') {
      log(fmtAudit(payload));
      return;
    }
    if (name === 'claim_done') {
      claimsSeen += 1;
      log(payload.claim_id + '  => ' + payload.outcome + (payload.mismatch ? '  (GOT IT WRONG vs ground truth)' : ''));
      addCard(payload);
      statusEl.textContent = 'running, ' + claimsSeen + ' done';
      return;
    }
    if (name === 'summary') {
      renderPortfolio(payload);
      log('portfolio: ' + payload.claims + ' claims, INR ' + payload.inr_held + ' held, INR ' + payload.inr_released + ' released, spend INR ' + payload.total_cost_inr.toFixed(3));
      return;
    }
    if (name === 'done') {
      log('run complete.');
    }
  }

  sampleBtn.addEventListener('click', function () { run('sample'); });
  // The full batch is 50 claims / ~42 live model calls. Gemini free-tier quota
  // is per-model and per-day; exhausting it mid-run trips the circuit breaker
  // and every remaining claim fail-safes to REVIEW - a run that measures the
  // rate limiter rather than the verifier. Confirm before spending it.
  fullBtn.addEventListener('click', function () {
    if (window.confirm('Run the full batch?\n\n50 claims, ~42 live model calls, roughly 7 minutes of real API spend.\n\nIf the provider free-tier quota runs out mid-run the circuit breaker trips and the remaining claims fail-safe to REVIEW. Use "Run sample" (7 claims, one per scenario) for a demo.')) {
      run('full');
    }
  });
})();
</script>
</body>
</html>`;
}

await main();
