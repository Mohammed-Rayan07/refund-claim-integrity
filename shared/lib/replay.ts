/**
 * F13 - Deterministic replay (SPEC §3 F13).
 *
 * Any historical decision must be reconstructible from the audit log: the same
 * inputs, the same config snapshot, the same deterministic code, the same
 * outcome. Replay never re-calls the model - the whole point is to check the
 * DETERMINISTIC layers (L1 gate, L4 ladder) still produce what they produced,
 * using the model verdict exactly as it was recorded. Re-invoking the LLM would
 * make replay non-deterministic and would spend money re-answering a question
 * that was already answered and logged.
 *
 * L1 is re-executed live (it is pure code over order/payment/store state, and
 * re-running it is how a code or config regression would surface). L2 and L3
 * are reconstructed from their own audit entries rather than re-run, because
 * their raw inputs (evidence bytes, the model's own reasoning) are not - and
 * should not be - persisted verbatim in the audit trail (payloads are hashed,
 * SPEC §3 F6).
 *
 * A caveat, stated rather than hidden: L1's duplicate/velocity checks read
 * `store.listPriorClaimsByCustomer/ByOrder`, which reflect the store's CURRENT
 * contents. If claims were added or removed since the original decision, a
 * replay can legitimately diverge - that divergence is itself useful signal
 * ("this decision depended on claim history that has since changed") and is
 * reported, never masked.
 */
import { AuditLogger, hashPayload } from './logger.ts';
import { runIntegrityGate, type IntegrityGateResult } from '../../layers/L1-deterministic/index.ts';
import { decide, type DecisionResult, type ReuseSignal, type VerifierAbsence } from '../../layers/L4-decision/index.ts';
import type { VerifierFailureKind, VerifierResult, VerifierVerdict } from '../../layers/L3-verifier/index.ts';
import type { LoadedConfig } from '../config/index.ts';
import type { PaymentsAdapter } from '../adapters/payments.ts';
import type { StoreAdapter } from '../adapters/store.ts';
import type { Claim, Decision } from '../types.ts';
import { sanitiseClaimText } from './sanitiser.ts';

export interface ReplayDeps {
  payments: PaymentsAdapter;
  store: StoreAdapter;
  config: LoadedConfig;
}

export interface ReplayContext {
  claim: Claim;
  original: Decision;
  gate: IntegrityGateResult;
  reuse: ReuseSignal | null;
  verifier: VerifierResult | null;
  verifier_absence: VerifierAbsence | null;
}

export interface ReplayReport {
  claim_id: string;
  original: Decision;
  replayed: Decision;
  outcome_matches: boolean;
  reason_codes_match: boolean;
  matches: boolean;
  diffs: string[];
  config_drifted: boolean;
}

function reconstructReuse(store: StoreAdapter, claimId: string): Promise<ReuseSignal | null> {
  return store.listReuseHits(claimId).then((hits) => {
    if (hits.length === 0) return null;
    const best = [...hits].sort((a, b) => b.similarity - a.similarity)[0]!;
    return {
      max_similarity: best.similarity,
      source: best.source,
      matched_ref: best.catalogue_ref ?? best.matched_claim_id ?? 'unknown',
    };
  });
}

const VERDICT_KEYS: (keyof VerifierVerdict)[] = [
  'supports_claim',
  'sku_match',
  'internal_consistency',
  'contradictions',
  'confidence',
  'injection_suspected',
  'reasoning',
];

function isVerdictShaped(detail: Record<string, unknown>): boolean {
  return VERDICT_KEYS.every((k) => k in detail);
}

/**
 * Reconstructs the L3 outcome purely from what L3 itself wrote to the audit
 * trail - never from L4's derived 'decision_made' record, which would make the
 * check circular. Returns `undefined` when no L3 event exists (verifier never
 * reached), distinct from `null` (an explicit absence reason IS on record).
 */
function reconstructVerifier(
  store: StoreAdapter,
  claimId: string,
): { verifier: VerifierResult | null; absence: VerifierAbsence | null } {
  const events = store.listAudit(claimId).filter((e) => e.layer === 'L3');

  const verdictEvent = [...events].reverse().find((e) => e.event === 'verifier_verdict');
  if (verdictEvent?.detail && isVerdictShaped(verdictEvent.detail)) {
    const d = verdictEvent.detail;
    const verdict: VerifierVerdict = {
      supports_claim: d['supports_claim'] as VerifierVerdict['supports_claim'],
      sku_match: d['sku_match'] as VerifierVerdict['sku_match'],
      internal_consistency: d['internal_consistency'] as number,
      contradictions: d['contradictions'] as string[],
      confidence: d['confidence'] as number,
      injection_suspected: d['injection_suspected'] as boolean,
      reasoning: d['reasoning'] as string,
    };
    return {
      verifier: {
        ok: true,
        verdict,
        model_version: String(d['model_version'] ?? 'unknown'),
        prompt_version: String(d['prompt_version'] ?? 'unknown'),
        latency_ms: Number(d['latency_ms'] ?? 0),
        attempts: Number(d['attempts'] ?? 1),
        input_tokens: 0,
        output_tokens: 0,
        references_only: d['evidence_mode'] === 'references_only',
      },
      absence: null,
    };
  }

  const failedEvent = [...events].reverse().find((e) => e.event === 'verifier_failed');
  if (failedEvent?.detail) {
    const d = failedEvent.detail;
    return {
      verifier: {
        ok: false,
        failure: d['failure'] as VerifierFailureKind,
        message: String(d['message'] ?? 'unknown failure'),
        model_version: null,
        prompt_version: 'unknown',
        latency_ms: 0,
        attempts: Number(d['attempts'] ?? 1),
        input_tokens: 0,
        output_tokens: 0,
      },
      absence: null,
    };
  }

  const skipped = [...events]
    .reverse()
    .find((e) => e.event === 'verifier_skipped_circuit_open' || e.event === 'verifier_not_configured');
  if (skipped) {
    return {
      verifier: null,
      absence: skipped.event === 'verifier_skipped_circuit_open' ? 'circuit_open' : 'adapter_unavailable',
    };
  }

  return { verifier: null, absence: 'not_reached' };
}

/** Rebuilds everything `decide()` needs for a claim, without calling the model. */
export async function reconstructContext(claimId: string, deps: ReplayDeps): Promise<ReplayContext> {
  const { payments, store, config } = deps;

  const claim = await store.getClaim(claimId);
  if (!claim) throw new Error(`replay: no claim ${claimId} in the store`);
  const original = await store.getDecision(claimId);
  if (!original) throw new Error(`replay: no decision on record for ${claimId} - nothing to replay`);

  // L1 is cheap, pure and re-run live rather than reconstructed (see module note).
  // A scratch audit sink keeps this re-derivation out of the claim's real trail.
  const scratch = new AuditLogger({ append: () => {} });
  const gate = await runIntegrityGate(claim, { payments, store, config, audit: scratch });

  const reuse = gate.passed ? await reconstructReuse(store, claimId) : null;
  const { verifier, absence } = gate.passed ? reconstructVerifier(store, claimId) : { verifier: null, absence: null };

  return { claim, original, gate, reuse, verifier, verifier_absence: absence };
}

/**
 * Re-runs the deterministic ladder (L1 + L4) from logged inputs and checks it
 * reproduces the recorded decision. Writes exactly one 'REPLAY' audit event -
 * never a second 'decision_made', so the real trail is never doubled.
 */
export async function replayDecision(claimId: string, deps: ReplayDeps): Promise<ReplayReport> {
  const ctx = await reconstructContext(claimId, deps);
  const { claim, original, gate, reuse, verifier, verifier_absence } = ctx;

  const sanitised = sanitiseClaimText(claim.claim_text);
  const scratch = new AuditLogger({ append: () => {} });

  const result: DecisionResult = decide(
    {
      claim,
      gate,
      sanitised,
      reuse,
      verifier,
      verifier_absence,
      latency_ms: original.latency_ms,
      cost_inr: original.cost_inr,
    },
    { config: deps.config, audit: scratch },
  );

  const replayed = result.decision;
  const diffs: string[] = [];
  if (replayed.outcome !== original.outcome) {
    diffs.push(`outcome: ${original.outcome} -> ${replayed.outcome}`);
  }
  const origCodes = [...original.reason_codes].sort();
  const replCodes = [...replayed.reason_codes].sort();
  if (JSON.stringify(origCodes) !== JSON.stringify(replCodes)) {
    diffs.push(`reason_codes: [${origCodes.join(',')}] -> [${replCodes.join(',')}]`);
  }
  const config_drifted = original.config_snapshot_id !== deps.config.snapshot_id;
  if (config_drifted) {
    diffs.push(`config snapshot: ${original.config_snapshot_id} -> ${deps.config.snapshot_id} (thresholds/policy changed since)`);
  }

  const report: ReplayReport = {
    claim_id: claimId,
    original,
    replayed,
    outcome_matches: replayed.outcome === original.outcome,
    reason_codes_match: JSON.stringify(origCodes) === JSON.stringify(replCodes),
    matches: diffs.length === 0,
    diffs,
    config_drifted,
  };

  const replayDetail = {
    original_outcome: original.outcome,
    replayed_outcome: replayed.outcome,
    diffs: report.diffs,
    config_drifted,
  };
  deps.store.appendAudit({
    id: `AE_REPLAY_${claimId}_${Date.now()}`,
    claim_id: claimId,
    layer: 'REPLAY',
    event: report.matches ? 'replay_matched' : 'replay_diverged',
    payload_hash: hashPayload(replayDetail),
    timestamp: new Date().toISOString(),
    detail: replayDetail,
  });

  return report;
}
