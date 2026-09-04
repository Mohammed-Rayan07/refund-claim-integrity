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

Chunks 1-2 are built: config, mock adapters, reason codes, audit trail, the L1
deterministic integrity gate, the L0 injection defense, the L3 claim verifier with
strict schema validation and an abstention path, the complete L4 decision ladder
with cost-sensitive thresholds, and fail-safe degradation with a circuit breaker.
L2 evidence-reuse detection arrives in Chunk 3.

## Run

Requires Node 20+ (TypeScript runs directly; no install needed for the demo).

```bash
MODE=mock npm run demo:spine    # L1 -> L4, deterministic-only, zero model calls
MODE=mock npm run demo:decide   # L0 -> L1 -> L3 -> L4, all three outcomes + fail-safe
```

`demo:decide` runs two phases: a healthy verifier, then the verifier killed
mid-run to show the queue degrading to REVIEW rather than approving anything.

FraudBench samples are consumed only, and no manifest is committed - see
[eval/fraudbench/README.md](eval/fraudbench/README.md).

Copy `shared/config/env.example` to `.env` before using `MODE=live`. Every live
connection point is marked `TODO(LIVE)` with the exact `.env` key it needs.

## Full specification

See [SPEC.md](SPEC.md).
