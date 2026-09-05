# Refund Claim Integrity Engine (RCIE)

Verifies whether a refund claim is actually supported by its evidence — before the
merchant's money leaves. Razorpay AI Buildathon 2026, Track 02: AI Risk Manager.

---

> This project is strictly defense-only. It contains no capability to generate, edit,
> or synthesise fraudulent refund evidence. All adversarial samples used in evaluation
> come from the publicly released FraudBench benchmark (arXiv 2605.08820), used solely
> to measure detection performance. No fraud-enabling code is included.

---

## The thesis

Refund workflows assume the evidence a customer submits is trustworthy enough to
evaluate. Generative AI broke that assumption: a convincing photo of damage that never
happened now costs nothing to produce.

The obvious fix is to detect AI-generated images. FraudBench (arXiv 2605.08820, NTU +
Alibaba — 822 real reviews, 7,928 images, 29 categories, fakes from 6 generators)
shows that fix is unreliable. Multimodal LLMs perform poorly on the fake-damage
subsets, and specialised detectors are inconsistent across generators while
false-positiving on genuinely damaged goods — penalising honest customers.

So RCIE does not ask whether an image is fake. It asks a different question:

> **"Is this image AI-generated?"** → the obvious question, and it does not work reliably.
>
> **"Does the totality of this evidence support *this* claim on *this* order?"** → the question RCIE answers.

## The proof case

**A genuine, unedited photograph of the wrong product.**

There is nothing for an image detector to detect. The pixels are real, the camera
metadata is real, no generator ever touched it. Every AI-image detector passes it.

Claim-conditioned verification catches it immediately, because the photo does not
show the item on the order.

This is not hypothetical. It is a scenario in the live batch (`sku_mismatch`,
`eval/fraudbench/cases.ts`): a real FraudBench photo paired with an order for a
different product. In the live run below it was denied at **confidence 1.0** with
`RCI-07 CLAIM_UNSUPPORTED` + `RCI-08 INTERNAL_CONTRADICTION`.

That single case is why this is structurally different from a detector, not a tuning
difference.

## What is real and what is synthetic

Stated plainly, because it determines how much the numbers below are worth.

| Component | Status | Detail |
|---|---|---|
| Evidence images | **Real** | FraudBench subset, 102 samples on disk, dataset sha `27d94c1a4c4b`. Consumed only — never generated. |
| Model calls | **Real** | Live Google Gemini (`gemini-3.5-flash`) multimodal calls against real image bytes. |
| Pipeline logic | **Real** | L0–L4, audit trail, replay, circuit breaker — the shipped code, unmodified. |
| Perceptual hashes | **Real** | dHash computed from decoded pixels, not from filenames. |
| Transaction context | **Synthetic** | Orders, payments, customers, SKUs, velocity history. No access to Razorpay production data. |
| Payments / store / notifier | **Mock** | Read-only or side-effect-free by construction. |

The synthetic half is the transaction context an acquirer would already hold. The
part this project claims as novel — evidence integrity — runs on real images through
a real model.

## Architecture

```
                    ┌─────────────────────────┐
                    │  Refund claim ingested   │
                    │  (claim text + images +  │
                    │   order + payment state) │
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │ L0 INPUT SANITISER       │  F9
                    │ fence claim text as data │
                    │ detect injection attempt │
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │ L1 DETERMINISTIC GATE    │  F1  ← no LLM, no cost
                    │ order/amount/SKU/window/ │
                    │ duplicate/state/velocity │
                    └───────────┬─────────────┘
                       fail ────┴──── pass
                        │              │
                        ▼              ▼
                 DENY_RECOMMEND  ┌──────────────────────┐
                 (reason code)   │ L2 REUSE CHECK       │  F3
                                 │ pHash vs history +   │
                                 │ catalogue + shared   │
                                 └──────────┬───────────┘
                                            ▼
                                 ┌──────────────────────┐
                                 │ L3 CLAIM VERIFIER    │  F2
                                 │ Gemini (live LLM)    │
                                 │ claim-conditioned    │
                                 │ abstention allowed   │
                                 └──────────┬───────────┘
                                            ▼
                                 ┌──────────────────────┐
                                 │ L4 DECISION ENGINE   │  F4 F8
                                 │ cost-sensitive       │
                                 │ ₹-weighted thresholds│
                                 │ fail-safe → REVIEW   │
                                 └──────────┬───────────┘
                                            ▼
                    APPROVE  │  REVIEW  │  DENY_RECOMMEND
                             └─────┬────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ AUDIT LOG (F6) → REPLAY (F13)│
                    │ HUMAN QUEUE (F15) → DASHBOARD│
                    └──────────────────────────────┘

              ⚠️ NO PATH FROM THIS SYSTEM EXECUTES A REFUND OR A DENIAL.
```

**L0 — Input sanitiser.** Fences claim text as data and scans it for instruction-like
content before it reaches a model. Exists because claim text is attacker-controlled
free text that is about to be placed in a prompt.

**L1 — Deterministic gate.** Pure code, sub-millisecond: order ownership, amount
bounds, SKU presence, refund window, payment capture state, duplicates, refund state
machine, claim velocity. Exists because most invalid claims are invalid for boring
arithmetic reasons, and **42.5% of claims in the mock batch never reach a model at
all** — the cheapest and most explainable decisions happen here.

**L2 — Evidence reuse check.** Perceptual hashes of submitted images against this
customer's history, the merchant catalogue, and a hash-only cross-merchant index.
Exists to catch recycled and stock imagery, which no single-claim verifier can see.

**L3 — Claim verifier.** The only place a model is reachable from. Multimodal, asks
whether the evidence supports this specific claim on this specific order, and may
abstain. **It is never asked whether an image is AI-generated** — that is the
question FraudBench shows is unreliable.

**L4 — Decision engine.** Fully deterministic. Takes the verdict plus exposure and
applies ₹-weighted, cost-sensitive thresholds: the more money at stake, the higher
the confidence required. **No model output routes a decision directly** — the model
supplies evidence, this layer decides.

## Safety properties

- **No code path moves money.** There is no refund-execution function in this
  repository. The payments adapter is read-only by construction.
- **`DENY_RECOMMEND` is a recommendation to a human**, never an executed denial.
- **Every failure mode routes to REVIEW, never APPROVE.** Timeout, malformed output,
  schema violation, transport error, low confidence, abstention, suspected injection —
  all fail safe. Verified: in the outage phase of `npm run demo:decide`, 59 claims were
  hit by the verifier going down and **0 were approved**; the circuit breaker tripped.
- **Prompt-injection defense at L0.** Claim text is fenced as data and screened before
  any model call. Injected instructions cause the verdict to be discarded and the claim
  routed to a human (`RCI-13`). Measured 100% containment on the injection suite
  (4 attempts, 4 contained, 0 approved).
- **The cross-merchant reuse index stores hashes only.** No image is ever shared or
  compared across merchants — only fingerprints.
- **The human feedback loop measures drift; it never auto-adjusts a threshold.**
  Reviewer disagreement is recorded and reported, and changing a threshold stays a
  deliberate human act.
- **Every decision is replayable** from the audit log alone, with the model never
  re-called: 113/113 reproduced exactly.

## Results

Two modes, reported separately. Mixing them would be dishonest.

### Mock batch — routing correctness, not detection accuracy

`npm run demo:full` / `npm run dashboard`, 113 claims, scripted verifier verdicts:

| | |
|---|---|
| Claims processed | 113 |
| ₹ held (REVIEW + DENY_RECOMMEND) | ₹2,83,209 |
| ₹ released (APPROVE) | ₹44,878 |
| Resolved without any model call | 48/113 (**42.5%**) |
| Deterministic replay match | **113/113** |
| Review queue depth | 91 |

**In `MODE=mock` the verifier's verdicts are scripted.** These numbers measure whether
the decision ladder routes correctly. They are not detection accuracy and must not be
quoted as such.

Against structural baselines projected from the same run — B1 sees only L1 order
checks, B2 sees only the evidence verdict ([eval/RESULTS.md](eval/RESULTS.md)):

| Metric | B1 Rules | B2 VLM | RCIE |
|---|---|---|---|
| Precision | 1.000 | 0.348 | 0.659 |
| Recall | 0.645 | 0.129 | **0.968** |
| False-positive rate | 0.0% | 29.4% | **60.8%** |
| ₹ exposure correctly held | ₹1,30,060 | ₹23,492 | **₹1,82,340** |
| ₹ legitimate refunds wrongly flagged | ₹0 | ₹31,185 | **₹1,00,869** |
| Injection resistance | 0.0% | 0.0% | **100.0%** |
| Resolved without model call | 100.0% | 0.0% | 42.5% |

Confusion (RCIE): TP 60, FP 31, FN 2, TN 20. Calibration ECE 0.095 over 49 directional
verdicts — coarse, because scripted fixtures take few distinct confidence values.

#### The false-positive rate, both readings

**The harsh reading — 60.8%, and it is the one reported above.** "Flagged" means *not
auto-approved*, so a REVIEW counts against us: a legitimate customer still loses their
instant refund. 31 legitimate claims flagged, ₹1,00,869 of real customers' money
delayed.

**The breakout** ([eval/RESULTS.md](eval/RESULTS.md) generates both from the run):

| Cause | Claims | ₹ delayed | Reading |
|---|---|---|---|
| `confidence_below_threshold` | 16 | ₹69,684 | Policy — merchant set a ceiling above which a human must look |
| `verifier_abstained` | 7 | ₹15,493 | Correct — refusing to guess on unusable photographs |
| `verifier_unavailable` | 8 | ₹15,692 | Availability bug — the one genuinely fixable row |

Roughly half the flagged rupees are a merchant policy choice, not a model error. The
fix for those is a policy conversation; only `verifier_unavailable` is a defect.

**Known blind spot:** RCIE verifies that evidence is *consistent with the claim and the
order*. Damage that was really inflicted and truthfully photographed is consistent, so
it is approved — 2 such claims slipped through. No evidence-integrity layer can catch
that; it needs behavioural signal, which is what L1 velocity and L2 reuse contribute.

### Live run — real Gemini, real FraudBench images

`npm run demo:server` → **Run sample**. 7 claims, `gemini-3.5-flash`, `LLM_MODE=live`
with payments/store/notifier still mock:

| Claim | Scenario | Outcome | Confidence | Reason codes | Latency |
|---|---|---|---|---|---|
| LIVE_001 | genuine_damaged | DENY_RECOMMEND | 1.0 | RCI-07, RCI-08 | 8.5s |
| LIVE_013 | ai_edited_damage | DENY_RECOMMEND | 0.95 | RCI-07, RCI-08 | 13.5s |
| LIVE_025 | undamaged_contradicted | DENY_RECOMMEND | 0.80 | RCI-07, RCI-08 | 7.9s |
| LIVE_033 | **sku_mismatch** (the proof case) | DENY_RECOMMEND | 1.0 | RCI-07, RCI-08 | 7.3s |
| LIVE_039 | stock_image | DENY_RECOMMEND | — | RCI-10 | **1 ms, no model call** |
| LIVE_043 | reused_image | DENY_RECOMMEND | — | RCI-09 | **1 ms, no model call** |
| LIVE_047 | injection_attempt | REVIEW | 1.0 | RCI-13 | 6.3s |

₹12,207 held, ₹0 released, 2/7 (28.6%) resolved without a model call, total model cost
₹4.96 for the batch. Confidences genuinely vary (0.80 / 0.95 / 1.0) — these are model
outputs, not fixtures.

**LIVE_001 is a false positive, and it is instructive.** Ground truth is
`should_release`. The model denied it because the order metadata specifies a *Black*
case while the photograph shows a *purple glitter* case — a real inconsistency in the
FraudBench source pairing. The system flagged a genuine contradiction in its inputs.

Because that sample is first in the batch, this 7-claim slice approves nothing. Running
5 genuine claims directly gives a fairer picture: **the verifier returned
`supports_claim: yes` on 4 of 5**, and the holds were policy, not detection —

| Claim | Outcome | Why |
|---|---|---|
| LIVE_001 | DENY_RECOMMEND | metadata/photo contradiction described above |
| LIVE_002 | REVIEW | `RCI-15` exposure above merchant ceiling (verdict: supports, 0.95) |
| LIVE_003 | REVIEW | `RCI-15` exposure above merchant ceiling (verdict: supports, 0.95) |
| LIVE_004 | REVIEW | `RCI-14` confidence below the exposure-scaled bar |
| LIVE_005 | **APPROVE** | clean and supported |

A confident *supports* verdict still routed to a human because the amount exceeded the
merchant's ceiling. That is the cost-sensitive ladder behaving as designed.

## Quickstart

Requires Node 20+. TypeScript runs directly — no build step.

### Mock — no API key, no network, deterministic

`MODE=mock` is the default, so no shell prefix is needed:

```
npm install
npm run demo:spine     # L1 -> L4, deterministic only, zero model calls
npm run demo:full      # SPEC section 9 five-case walkthrough + replay/idempotency proofs
npm run demo:decide    # all outcomes, then the verifier killed mid-run (fail-safe)
npm run eval           # writes eval/RESULTS.md
npm run dashboard      # writes dashboard/index.html
```

`demo:full` exits non-zero if any invariant fails, so it doubles as a smoke test.

### Live — real model calls

```
npm run fetch:fraudbench     # required: populates the local FraudBench subset
npm run demo:server          # http://localhost:8787
```

Copy [`shared/config/env.example`](shared/config/env.example) to `.env` and set
`GEMINI_API_KEY`. Then open `http://localhost:8787` and click **Run sample** (7 claims,
one per scenario).

- **The demo server must stay running in its own terminal.** Connection refused in the
  browser means the process is not up.
- **Run full batch** is 50 claims / ~42 live model calls and prompts for confirmation.
  Free-tier quota is per-model and per-day; exhausting it mid-run trips the circuit
  breaker and the remaining claims fail-safe to REVIEW. See the `GEMINI_MODEL` note in
  `env.example` for measured per-model latency.
- Only `LLM_MODE` goes live. `MODE` stays `mock`, so payments, store and notifier never
  leave mock data.

To force the mode explicitly, syntax is shell-specific:

```bash
MODE=mock npm run demo:spine             # bash / zsh
```
```powershell
$env:MODE = 'mock'; npm run demo:spine   # PowerShell
```

## Relationship to Razorpay's existing stack

Razorpay already reasons at order level, not just payment level, and already handles
refund evidence:

- **Dispute Responder Agent** optimises how evidence is *presented* to banks.
- **RTO Shield / RTO Insights** score order-level return and RTO risk.

Neither verifies whether *incoming* evidence is trustworthy in the first place. That is
the gap this fills — evidence integrity as a layer beneath tooling Razorpay has already
built.

This is explicitly **not** a claim that Razorpay does not verify refunds. It does. The
assumption this project attacks is a different one: that submitted evidence is
trustworthy enough to evaluate at all, which is what generative AI broke.

## Reason codes

`RCI-01`–`RCI-12` are the set defined in SPEC §3 F5. `RCI-13`–`RCI-15` are
operator-added, on the rule that no `REVIEW` should ever reach a human with an empty
`reason_codes` array — see [`shared/lib/reasoncodes.ts`](shared/lib/reasoncodes.ts).

L1 emits its own codes and short-circuits before any model call. Every other code is
emitted by **L4**, from the signal the named layer produced — decision authority stays
in one deterministic place.

| Code | Name | Signal from | Emitted by |
|---|---|---|---|
| RCI-01 | ORDER_NOT_FOUND | L1 | L1 |
| RCI-02 | AMOUNT_EXCEEDS_ORDER | L1 | L1 |
| RCI-03 | WINDOW_EXPIRED | L1 | L1 |
| RCI-04 | SKU_MISMATCH | L1 | L1 |
| RCI-05 | DUPLICATE_CLAIM | L1 | L1 |
| RCI-06 | PAYMENT_NOT_CAPTURED | L1 | L1 |
| RCI-07 | CLAIM_UNSUPPORTED | L3 | L4 |
| RCI-08 | INTERNAL_CONTRADICTION | L3 | L4 |
| RCI-09 | EVIDENCE_REUSED | L2 | L4 |
| RCI-10 | STOCK_IMAGE_SUBMITTED | L2 | L4 |
| RCI-11 | INSUFFICIENT_EVIDENCE | L3 / verifier unavailable | L4 |
| RCI-12 | VELOCITY_EXCEEDED | L1 | L1 |
| RCI-13 | INJECTION_SUSPECTED *(operator-added)* | L0 | L4 |
| RCI-14 | CONFIDENCE_BELOW_THRESHOLD *(operator-added)* | L4 policy | L4 |
| RCI-15 | POLICY_CEILING_EXCEEDED *(operator-added)* | L4 policy | L4 |

## Repo layout

| Path | Contents |
|---|---|
| `layers/` | L1 gate, L2 reuse, L3 verifier, L4 decision engine, and `pipeline.ts` wiring them |
| `shared/adapters/` | payments, store, notifier, evidence, and the LLM wrapper (the only model call site) |
| `shared/lib/` | sanitiser (L0), perceptual hashing, replay, circuit breaker, reason codes, budget, feedback |
| `shared/config/` | policy, thresholds, `env.example` — config-driven, nothing hardcoded |
| `eval/` | evaluation harness, baselines, calibration, holdout, injection suite, FraudBench loader |
| `dashboard/` | single-file dashboard generator (no CDN, no server required to view) |
| `scripts/` | the three demo entry points |
| `server.ts` | local demo server: serves the dashboard, streams a live run over SSE |

Full specification: [SPEC.md](SPEC.md). Evaluation detail: [eval/RESULTS.md](eval/RESULTS.md).
Dataset provenance and terms: [eval/fraudbench/README.md](eval/fraudbench/README.md).

## Citations

- **arXiv 2605.08820** — FraudBench (NTU + Alibaba). 822 real reviews, 7,928 images, 29
  categories, fakes from 6 generation models; 11 MLLMs, 4 specialised detectors and
  humans evaluated. Source of every adversarial sample used here, consumed only.
- **arXiv 2606.03215** — interviews with merchants and platform workers on GenAI-enabled
  refund fraud: merchants rely on general AI tools plus manual heuristics, GenAI
  outpaces them, and cost asymmetry places the burden of proof on the merchant.
