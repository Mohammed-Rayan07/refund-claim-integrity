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

Chunk 1 (spine) is built: config, adapters (mock), reason codes, audit trail, the
L1 deterministic integrity gate, synthetic fixtures, and the L4 decision engine's
deterministic branches. L0/L2/L3 arrive in later chunks.

## Run

Requires Node 20+ (TypeScript runs directly; no install needed for the demo).

```bash
MODE=mock npm run demo:spine
```

Copy `shared/config/env.example` to `.env` before using `MODE=live`. Every live
connection point is marked `TODO(LIVE)` with the exact `.env` key it needs.

## Full specification

See [SPEC.md](SPEC.md).
