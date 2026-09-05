# Refund Claim Integrity Engine (RCIE)

Razorpay AI Buildathon 2026 — Track 02: AI Risk Manager.

> This project is strictly defense-only. It contains no capability to generate, edit,
> or synthesise fraudulent refund evidence. All adversarial samples used in evaluation
> come from the publicly released FraudBench benchmark (arXiv 2605.08820), used solely
> to measure detection performance. No fraud-enabling code is included.

**RCIE never moves money.** It emits one of three labels — `APPROVE`, `REVIEW`,
`DENY_RECOMMEND` — and `DENY_RECOMMEND` is a recommendation to a human reviewer,
never an executed denial. The payments adapter is read-only by construction.

## Status

All four SPEC build chunks are complete.

- **Chunk 1 — spine:** config, mock adapters, reason codes, audit trail, the L1
  deterministic integrity gate.
- **Chunk 2 — intelligence:** the L0 injection defense, the L3 claim verifier
  with strict schema validation and an abstention path, the full L4 decision
  ladder with cost-sensitive thresholds, fail-safe degradation with a circuit
  breaker.
- **Chunk 3 — proof:** L2 perceptual-hash evidence-reuse detection and the
  evaluation harness (baselines, holdout split, calibration, honest results
  table with a "where it fails" section).
- **Live infrastructure (beyond the four chunks):** the L3 verifier's
  `TODO(LIVE)` is implemented against a real multimodal LLM
  (`shared/adapters/llm.ts`), gated by `LLM_MODE=live` so a live verifier can
  run against real evidence while payments/store/notifier stay on mock data.
  Provider is chosen by `LLM_PROVIDER`: **Google Gemini is the default**
  (`generateContent`, no SDK dependency, `gemini-3.5-flash`), and Anthropic
  Claude is kept in the repo behind `LLM_PROVIDER=anthropic`. Both speak the same adapter interface,
  so nothing downstream of `llm.ts` - L3, L4, the pipeline, eval, the
  dashboard - knows or cares which one answered. An evidence adapter + JPEG
  decoder compute real perceptual hashes from real image bytes; `npm run
  fetch:fraudbench` populates a local FraudBench subset (consumed only, §0);
  `npm run eval:live` runs the pipeline against it.
- **Chunk 4 — surface:** the dashboard (claim cards, evidence-reuse graph,
  reason-code legend, per-claim audit trail, portfolio view), F13 deterministic
  replay, F15 the human feedback loop, F16 idempotency and claim-level locking,
  F14 policy-rule wiring enforced at config load time, and the five-case
  `demo:full` script from §9.

## Run

Requires Node 20+ (TypeScript runs directly; no install needed for the demos).

`MODE=mock` is already the default (and is set in `.env`), so the plain form
below works in **every** shell - PowerShell included:

```
npm run demo:spine    # L1 -> L4, deterministic-only, zero model calls
npm run demo:decide   # L0 -> L1 -> L2 -> L3 -> L4, all outcomes + fail-safe
npm run demo:full     # the SPEC section 9 five-case walkthrough + F13/F15/F16 proofs + portfolio
npm run dashboard     # writes dashboard/index.html - open it in a browser
npm run eval          # SPEC section 8 results table -> eval/RESULTS.md
```

To force the mode explicitly, the syntax is shell-specific. **Do not paste the
bash form into PowerShell** - `MODE=mock npm run ...` fails there with
`'MODE=mock' is not recognized`, because PowerShell has no inline env-var prefix.

```bash
MODE=mock npm run demo:spine          # bash / zsh (macOS, Linux, Git Bash)
```
```powershell
$env:MODE = 'mock'; npm run demo:spine   # PowerShell (Windows)
```

### Live demo server

```bash
npm run fetch:fraudbench   # once - populates the local FraudBench subset
npm run demo:server        # http://localhost:8787
```

Serves the dashboard and adds a **Run sample** button that pushes 7 real claims
(one per scenario) through the unmodified pipeline with a **live** L3 verifier,
streaming the pipeline's own audit events over SSE as they fire. `MODE` stays
`mock` throughout - only `LLM_MODE` goes live, so payments/store/notifier never
leave mock data and no money-moving path exists. Needs `GEMINI_API_KEY` in
`.env`. Leave the server running while the browser is open; connection refused
in the browser means the process is not up.

**Run full batch** is 50 claims / ~42 live model calls (~7 min) and prompts for
confirmation first: Gemini free-tier quota is per-model and per-day, and
exhausting it mid-run trips the circuit breaker so the remaining claims
fail-safe to REVIEW - a run that measures the rate limiter, not the verifier.
Prefer the sample for demos. See the `GEMINI_MODEL` note in
`shared/config/env.example` for measured per-model latency and the quota trap.

`demo:decide` runs two phases: a healthy verifier, then the verifier killed
mid-run to show the queue degrading to REVIEW rather than approving anything.

`demo:full` walks the five demo cases in §9 order (SKU mismatch, AI-generated
fake damage, a correctly-approved genuine claim, a case the system gets wrong,
a neutralised injection attempt), then proves deterministic replay reproduces
each historical decision from the audit log alone, that resolving a claim twice
produces one decision (not two, no double notification), and a sample of human
review feedback measured against the system - closing with the portfolio view.
Exits non-zero if any invariant fails, so it can run unattended.

`dashboard` runs the full batch once and writes a single self-contained,
dependency-free `dashboard/index.html`: filterable claim cards, an
evidence-reuse graph (F3, hashes only), a full audit trail per claim, the
reason-code legend (with the three operator-added codes marked), the human
feedback agreement rate, a full replay-integrity sweep, and the portfolio view
(₹ held, ₹ released, review queue depth, % resolved without a model call). No
CDN and no server - open the file directly.

`npm run eval` writes [eval/RESULTS.md](eval/RESULTS.md). Read its caveat block
first: in `MODE=mock` the verifier's verdicts are scripted, so the table measures
whether the decision ladder routes correctly, not detection accuracy. Real
detection numbers need `MODE=live` (or `LLM_MODE=live`) plus a local FraudBench
subset - see [eval/fraudbench/README.md](eval/fraudbench/README.md) and
`npm run fetch:fraudbench` / `npm run eval:live`.

## Beyond the SPEC's twelve reason codes

L4's ladder (SPEC §7) routes three cases to `REVIEW` without naming a reason
code: injection suspected, confidence below the exposure-scaled bar, and
exposure above the merchant's ceiling. `RCI-13`/`RCI-14`/`RCI-15` close that gap
so no reviewer ever opens a queued claim to an empty `reason_codes` array — see
the note in `shared/lib/reasoncodes.ts`. A defensive invariant in L4 repairs any
`REVIEW` that would otherwise still land empty and audits the repair, so the
gap cannot reopen silently.

## Live mode

Copy `shared/config/env.example` to `.env` before using `MODE=live` or
`LLM_MODE=live`. Every live connection point is marked `TODO(LIVE)` with the
exact `.env` key it needs. The LLM adapter is implemented; the payments, store
and notifier adapters remain `TODO(LIVE)` stubs, by design read-only or
side-effect-free where they exist at all - see §0/§3 F4, this system never
moves money.

## Full specification

See [SPEC.md](SPEC.md).
