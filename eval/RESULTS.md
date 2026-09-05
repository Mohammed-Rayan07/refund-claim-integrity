# RCIE evaluation

Generated 2026-09-05T16:49:22.803Z · MODE=`mock` · config snapshot `c489c3fa97197b97` · 113 claims

**No live run present.** `eval/live-run.json` was not found, so every number in this document (including the table immediately below) comes from `MODE=mock` scripted verifier verdicts - none of it measures real detection accuracy. Run `npm run fetch:fraudbench` then `LLM_MODE=live npm run eval:live` to add a real section above this line.

## Pipeline behaviour on scripted fixtures (MODE=mock)

**These are not detection-accuracy numbers.** In `MODE=mock` every verifier verdict comes from a scripted fixture response, so the table below measures whether the decision ladder *routes* each case correctly - not whether a model can tell real damage from fabricated damage. Real detection numbers require `MODE=live` against a model plus the FraudBench subset, and rows that depend on that subset are reported as `n/a` rather than computed.

`B1 Rules` and `B2 VLM` are structural **projections of this same run**, not separately scripted systems: B1 sees only the L1 order/payment checks, B2 sees only the evidence verdict and is blind to every order-context and cross-claim dimension. Neither was tuned to lose.

"Flagged" means **not auto-approved** - a REVIEW counts as a flag, because a legitimate customer still loses their instant refund. Positive class = the claim should be held.

| Metric | B1 Rules | B2 VLM | Ours |
|---|---|---|---|
| Precision | 1.000 | 0.348 | 0.659 |
| Recall | 0.645 | 0.129 | 0.968 |
| **False-positive rate** | **0.0%** | **29.4%** | **60.8%** |
| ₹ exposure correctly held | ₹1,30,060 | ₹23,492 | ₹1,82,340 |
| **₹ legitimate refunds wrongly flagged** | **₹0** | **₹31,185** | **₹1,00,869** |
| Abstention rate | 0.0% | 14.2% | 7.1% |
| Unseen-generator recall (F10) | n/a | n/a | n/a |
| Injection resistance (F9) | 0.0% | 0.0% | 100.0% |
| % resolved without a model call (F17) | 100.0% | 0.0% | 42.5% |
| Mean cost/claim, p95 latency | ₹0.000, 0 ms | ₹0.264, 0 ms | ₹0.161, 0 ms |

Unseen-generator recall is `n/a`: 3 of 6 generators held out. Cost uses the placeholder token prices in `shared/config/thresholds.json`; latency is mock-run wall clock and says nothing about live model latency.

## Confusion detail

| System | TP | FP | FN | TN |
|---|---|---|---|---|
| B1 Rules | 40 | 0 | 22 | 51 |
| B2 VLM | 8 | 15 | 54 | 36 |
| Ours | 60 | 31 | 2 | 20 |

## Case classes in the batch

| Class | Claims | should_hold | should_release |
|---|---|---|---|
| amount_exceeds | 5 | 5 | 0 |
| clean | 33 | 0 | 33 |
| duplicate_claim | 4 | 4 | 0 |
| evidence_contradicts | 4 | 4 | 0 |
| evidence_insufficient | 4 | 1 | 3 |
| genuine_undamaged | 3 | 3 | 0 |
| injection_attempt | 4 | 4 | 0 |
| low_confidence | 3 | 0 | 3 |
| low_quality_genuine | 4 | 0 | 4 |
| missed_fabrication | 2 | 2 | 0 |
| order_not_found | 4 | 4 | 0 |
| order_ownership_mismatch | 3 | 3 | 0 |
| payment_not_captured | 5 | 5 | 0 |
| refund_state_invalid | 4 | 4 | 0 |
| reused_image | 5 | 5 | 0 |
| sku_mismatch | 6 | 6 | 0 |
| stock_image | 3 | 3 | 0 |
| velocity_exceeded | 4 | 4 | 0 |
| verifier_malformed | 2 | 0 | 2 |
| verifier_schema_invalid | 2 | 0 | 2 |
| verifier_timeout | 2 | 0 | 2 |
| verifier_transport_error | 2 | 0 | 2 |
| window_expired | 5 | 5 | 0 |

AI-edited damage (FraudBench) is absent from this batch: 102 samples across 6 generators (dataset sha 27d94c1a4c4b). No substitute samples were generated - see `eval/fraudbench/README.md`.

## Calibration (F12)

49 directional verdicts, 8 abstentions (excluded - an abstention makes no claim to be calibrated). ECE 0.095.

| Confidence bin | n | Mean stated | Observed accuracy |
|---|---|---|---|
| 0.60–0.70 | 3 | 0.610 | 1.000 |
| 0.80–0.90 | 3 | 0.880 | 1.000 |
| 0.90–1.00 | 43 | 0.933 | 0.860 |

The curve is coarse because scripted fixtures take only a handful of distinct confidence values. It is a wiring check for the calibration path, not a real reliability curve.

## Injection resistance (F9)

4 attempts · 4 contained · 4 caught by the deterministic sanitiser before any model call · 0 approved.

B1 and B2 both score 0%: B1 never reads the claim text, and B2 has no notion of an instruction hidden in it. Neither is a weak strawman - neither architecture has anywhere to put the defense.

## Where it fails

**31 legitimate claims flagged** (₹1,00,869 of real customers' money delayed) and **2 invalid claims approved**. Both lists are generated from the run, not hand-written.

### Legitimate claims RCIE wrongly flagged

| Claim | Class | Outcome | ₹ | Why |
|---|---|---|---|---|
| CLM_0061 | clean | REVIEW | 2499 | confidence 0.94 below 0.97 required at INR 2499 exposure |
| CLM_0066 | clean | REVIEW | 3299 | confidence 0.94 below 0.97 required at INR 3299 exposure |
| CLM_0101 | clean | REVIEW | 2499 | confidence 0.94 below 0.97 required at INR 2499 exposure |
| CLM_0103 | clean | REVIEW | 3299 | confidence 0.94 below 0.97 required at INR 3299 exposure |
| CLM_0062 | clean | REVIEW | 3299 | confidence 0.94 below 0.97 required at INR 3299 exposure |
| CLM_0068 | clean | REVIEW | 7499 | confidence 0.94 below 0.97 required at INR 7499 exposure |
| CLM_0072 | verifier_timeout | REVIEW | 2199 | verifier timeout: mock: no response within 45000ms - failed safe to REVIEW |
| CLM_0073 | evidence_insufficient | REVIEW | 2799 | verifier abstained: the damage area is out of frame in both views; cannot judge without a closer image. |
| CLM_0074 | verifier_malformed | REVIEW | 1499 | verifier malformed_output: response was not JSON: Unexpected token 'S', "Sure - bas"... is not valid JSON - fa |
| CLM_0075 | low_confidence | REVIEW | 7499 | confidence 0.61 below 0.97 required at INR 7499 exposure |
| CLM_0076 | verifier_transport_error | REVIEW | 1199 | verifier transport_error: mock: upstream returned 503 - failed safe to REVIEW |
| CLM_0078 | verifier_schema_invalid | REVIEW | 1899 | verifier schema_invalid: supports_claim not one of yes\|no\|insufficient - failed safe to REVIEW |
| CLM_0080 | verifier_timeout | REVIEW | 1299 | verifier timeout: mock: no response within 45000ms - failed safe to REVIEW |
| CLM_0053 | clean | REVIEW | 7499 | confidence 0.94 below 0.97 required at INR 7499 exposure |
| CLM_0081 | evidence_insufficient | REVIEW | 1199 | verifier abstained: the damage area is out of frame in both views; cannot judge without a closer image. |
| CLM_0082 | verifier_malformed | REVIEW | 3299 | verifier malformed_output: response was not JSON: Unexpected token 'S', "Sure - bas"... is not valid JSON - fa |
| CLM_0083 | low_confidence | REVIEW | 3499 | confidence 0.61 below 0.86 required at INR 3499 exposure |
| CLM_0084 | verifier_transport_error | REVIEW | 1499 | verifier transport_error: mock: upstream returned 503 - failed safe to REVIEW |
| CLM_0086 | verifier_schema_invalid | REVIEW | 2799 | verifier schema_invalid: supports_claim not one of yes\|no\|insufficient - failed safe to REVIEW |
| CLM_0088 | evidence_insufficient | REVIEW | 1499 | verifier abstained: the damage area is out of frame in both views; cannot judge without a closer image. |
| CLM_0090 | low_confidence | REVIEW | 2199 | confidence 0.61 below 0.81 required at INR 2199 exposure |
| CLM_0001 | clean | REVIEW | 2499 | confidence 0.94 below 0.97 required at INR 2499 exposure |
| CLM_0002 | clean | REVIEW | 3299 | confidence 0.94 below 0.97 required at INR 3299 exposure |
| CLM_0004 | clean | REVIEW | 7499 | confidence 0.94 below 0.97 required at INR 7499 exposure |
| CLM_0011 | clean | REVIEW | 2499 | confidence 0.94 below 0.97 required at INR 2499 exposure |
| CLM_0012 | clean | REVIEW | 3299 | confidence 0.94 below 0.97 required at INR 3299 exposure |
| CLM_0014 | clean | REVIEW | 7499 | confidence 0.94 below 0.97 required at INR 7499 exposure |
| CLM_0097 | low_quality_genuine | REVIEW | 3499 | verifier abstained: both images are motion-blurred and underexposed; nothing can be confirmed. |
| CLM_0098 | low_quality_genuine | REVIEW | 2799 | verifier abstained: both images are motion-blurred and underexposed; nothing can be confirmed. |
| CLM_0099 | low_quality_genuine | REVIEW | 2199 | verifier abstained: both images are motion-blurred and underexposed; nothing can be confirmed. |
| CLM_0100 | low_quality_genuine | REVIEW | 1499 | verifier abstained: both images are motion-blurred and underexposed; nothing can be confirmed. |

### Invalid claims RCIE approved

| Claim | Class | ₹ | Why it slipped through |
|---|---|---|---|
| CLM_0112 | missed_fabrication | 1299 | evidence supports claim at confidence 0.94 (bar 0.77), INR 1299 within ceiling INR 5000 |
| CLM_0113 | missed_fabrication | 1499 | evidence supports claim at confidence 0.94 (bar 0.78), INR 1499 within ceiling INR 5000 |

### What is actually driving the false-positive rate

| Cause | Claims | ₹ delayed |
|---|---|---|
| confidence_below_threshold | 16 | ₹69,684 |
| verifier_abstained | 7 | ₹15,493 |
| verifier_unavailable | 8 | ₹15,692 |

Two of these are policy, not error: `confidence_below_threshold` and `exposure_above_ceiling` fire because the merchant configured a ceiling above which a human must look. Counting them as false positives is the harsh reading, and it is the one reported above - but the fix for those rows is a policy conversation, whereas `verifier_unavailable` rows are an availability bug and `verifier_abstained` rows are the system correctly refusing to guess on unusable photographs.

The structural blind spot: RCIE verifies that evidence is *consistent with the claim and the order*. Damage that was really inflicted and truthfully photographed is consistent, so a claim like that is approved. No evidence-integrity layer can catch it - it needs behavioural signal, which is where L1 velocity and L2 reuse do the work instead.

