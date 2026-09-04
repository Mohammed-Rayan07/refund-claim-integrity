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

  const payload = {
    generated_at: new Date().toISOString(),
    mode: currentMode(),
    config_snapshot_id: config.snapshot_id,
    policy: { version: config.policy.version, merchant_id: config.policy.merchant_id },
    thresholds_version: config.thresholds.version,
    fraudbench_note: fraudbench.note,
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
    <h2>Claims</h2>
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
})();
</script>
</body>
</html>`;
}

await main();
