/**
 * The spine: L0 (sanitise) -> L1 (deterministic gate) -> L3 (verifier) -> L4 (decide).
 *
 * L2 reuse detection arrives in Chunk 3; its input to L4 is null until then.
 *
 * Fail-safe direction (F11): every error, timeout, malformed response and open
 * circuit lands on REVIEW. There is no path in this file - or anywhere below it -
 * that moves money.
 */
import { randomUUID } from 'node:crypto';
import type { LoadedConfig } from '../shared/config/index.ts';
import type { PaymentsAdapter } from '../shared/adapters/payments.ts';
import type { StoreAdapter } from '../shared/adapters/store.ts';
import type { NotifierAdapter } from '../shared/adapters/notifier.ts';
import type { LlmAdapter } from '../shared/adapters/llm.ts';
import { AuditLogger } from '../shared/lib/logger.ts';
import { sanitiseClaimText, type SanitisedClaimText } from '../shared/lib/sanitiser.ts';
import { CircuitBreaker, type BreakerSnapshot } from '../shared/lib/circuit.ts';
import type { Claim, Decision } from '../shared/types.ts';
import { runIntegrityGate, type IntegrityGateResult } from './L1-deterministic/index.ts';
import { runVerifier, type VerifierResult } from './L3-verifier/index.ts';
import { decide, type VerifierAbsence } from './L4-decision/index.ts';

export interface PipelineResult {
  claim: Claim;
  sanitised: SanitisedClaimText;
  gate: IntegrityGateResult | null;
  verifier: VerifierResult | null;
  verifier_absence: VerifierAbsence | null;
  decision: Decision;
  summary: string;
  decision_basis: string;
  injection_suspected: boolean;
  required_confidence: number;
  /** True when the claim was settled without spending a model call (F17). */
  resolved_without_model_call: boolean;
  breaker: BreakerSnapshot;
}

export interface Pipeline {
  resolve(claim: Claim): Promise<PipelineResult>;
  breaker(): BreakerSnapshot;
}

export interface PipelineDeps {
  payments: PaymentsAdapter;
  store: StoreAdapter;
  notifier: NotifierAdapter;
  /** Absent = deterministic-only mode: L1 runs, nothing is ever auto-approved. */
  llm?: LlmAdapter;
  config: LoadedConfig;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const audit = new AuditLogger({ append: (event) => deps.store.appendAudit(event) });
  const cfg = deps.config.thresholds.verifier;
  const breaker = new CircuitBreaker(
    cfg.circuit_breaker_consecutive_failures,
    cfg.circuit_breaker_cooldown_ms,
  );

  /** Last-resort fail-safe: an unexpected throw must still produce a REVIEW. */
  async function failSafe(
    claim: Claim,
    startedAt: number,
    layer: string,
    message: string,
  ): Promise<PipelineResult> {
    audit.record(claim.id, layer, 'unhandled_error', { claim_id: claim.id }, { message });
    const decision: Decision = {
      id: `DEC_${randomUUID()}`,
      claim_id: claim.id,
      outcome: 'REVIEW',
      reason_codes: ['RCI-11'],
      confidence: null,
      exposure_inr: claim.amount_inr,
      model_version: null,
      prompt_version: null,
      config_snapshot_id: deps.config.snapshot_id,
      latency_ms: Math.round(performance.now() - startedAt),
      cost_inr: 0,
      decided_at: new Date().toISOString(),
    };
    const summary = `${layer} error (${message}) - failed safe to REVIEW`;
    await deps.store.saveDecision(decision);
    await deps.notifier.notifyReviewQueue({
      claim_id: claim.id,
      outcome: decision.outcome,
      reason_codes: decision.reason_codes,
      exposure_inr: decision.exposure_inr,
      summary,
    });
    return {
      claim,
      sanitised: sanitiseClaimText(claim.claim_text),
      gate: null,
      verifier: null,
      verifier_absence: 'not_reached',
      decision,
      summary,
      decision_basis: 'unhandled_error',
      injection_suspected: false,
      required_confidence: Number.NaN,
      resolved_without_model_call: true,
      breaker: breaker.snapshot(),
    };
  }

  return {
    breaker: () => breaker.snapshot(),

    async resolve(claim: Claim): Promise<PipelineResult> {
      const startedAt = performance.now();

      audit.record(claim.id, 'PIPELINE', 'claim_received', claim, {
        order_id: claim.order_id,
        customer_id: claim.customer_id,
        amount_inr: claim.amount_inr,
        image_ref_count: claim.image_refs.length,
      });

      // --- L0: treat claim text as hostile data before anything else sees it ---
      const sanitised = sanitiseClaimText(claim.claim_text);
      audit.record(
        claim.id,
        'L0',
        sanitised.injection_suspected ? 'injection_suspected' : 'claim_text_sanitised',
        { claim_id: claim.id, safe_text: sanitised.safe_text },
        {
          injection_suspected: sanitised.injection_suspected,
          signals: sanitised.signals,
          fence_escaped: sanitised.escaped,
        },
      );

      // --- L1: deterministic integrity gate ---
      let gate: IntegrityGateResult;
      try {
        gate = await runIntegrityGate(claim, {
          payments: deps.payments,
          store: deps.store,
          config: deps.config,
          audit,
        });
      } catch (err) {
        return failSafe(
          claim,
          startedAt,
          'L1',
          err instanceof Error ? err.message : String(err),
        );
      }

      // --- L3: verifier, only for claims that survived L1 ---
      let verifier: VerifierResult | null = null;
      let verifier_absence: VerifierAbsence | null = null;
      let modelCallMade = false;

      if (!gate.passed) {
        // Short-circuited deterministically: no model budget spent.
        verifier_absence = 'not_reached';
      } else if (!deps.llm) {
        // Deterministic-only mode (F11 graceful degradation): still useful, still safe.
        verifier_absence = 'adapter_unavailable';
        audit.record(claim.id, 'L3', 'verifier_not_configured', { claim_id: claim.id }, {
          mode: 'deterministic_only',
        });
      } else if (breaker.isOpen()) {
        verifier_absence = 'circuit_open';
        audit.record(
          claim.id,
          'L3',
          'verifier_skipped_circuit_open',
          { claim_id: claim.id },
          { ...breaker.snapshot() },
        );
      } else {
        const evidence = await deps.store.listEvidenceForClaim(claim.id);
        try {
          verifier = await runVerifier(
            {
              claim,
              order: gate.order!,
              line_item: gate.line_item!,
              evidence,
              sanitised,
            },
            { llm: deps.llm!, config: deps.config, audit },
          );
          modelCallMade = verifier.attempts > 0;
        } catch (err) {
          return failSafe(
            claim,
            startedAt,
            'L3',
            err instanceof Error ? err.message : String(err),
          );
        }

        if (verifier.ok) {
          breaker.recordSuccess();
          audit.record(
            claim.id,
            'L3',
            'verifier_verdict',
            verifier.verdict,
            {
              ...verifier.verdict,
              model_version: verifier.model_version,
              prompt_version: verifier.prompt_version,
              attempts: verifier.attempts,
              latency_ms: verifier.latency_ms,
              evidence_mode: verifier.references_only ? 'references_only' : 'image_bytes',
            },
          );
        } else {
          const tripped = breaker.recordFailure();
          audit.record(
            claim.id,
            'L3',
            'verifier_failed',
            { claim_id: claim.id, failure: verifier.failure },
            {
              failure: verifier.failure,
              message: verifier.message,
              attempts: verifier.attempts,
              breaker: breaker.snapshot(),
              circuit_tripped: tripped,
            },
          );
          if (tripped) {
            // Operator alert: the queue is now running deterministic-only.
            await deps.notifier.notifyReviewQueue({
              claim_id: claim.id,
              outcome: 'REVIEW',
              reason_codes: ['RCI-11'],
              exposure_inr: claim.amount_inr,
              summary:
                `CIRCUIT BREAKER OPEN after ${cfg.circuit_breaker_consecutive_failures} ` +
                'consecutive verifier failures - queue degraded to deterministic-only, all ' +
                'undecidable claims routed to human review',
            });
          }
        }
      }

      // --- L4: deterministic decision ---
      const outcome = decide(
        {
          claim,
          gate,
          sanitised,
          reuse: null, // L2 arrives in Chunk 3
          verifier,
          verifier_absence,
          latency_ms: Math.round(performance.now() - startedAt),
          cost_inr: 0,
        },
        { config: deps.config, audit },
      );

      await deps.store.saveDecision(outcome.decision);

      // A recommendation goes to a person. Nothing here settles the claim.
      if (outcome.decision.outcome !== 'APPROVE') {
        await deps.notifier.notifyReviewQueue({
          claim_id: claim.id,
          outcome: outcome.decision.outcome,
          reason_codes: outcome.decision.reason_codes,
          exposure_inr: outcome.decision.exposure_inr,
          summary: outcome.summary,
        });
      }

      return {
        claim,
        sanitised,
        gate,
        verifier,
        verifier_absence,
        decision: outcome.decision,
        summary: outcome.summary,
        decision_basis: outcome.decision_basis,
        injection_suspected: outcome.injection_suspected,
        required_confidence: outcome.required_confidence,
        resolved_without_model_call: !modelCallMade,
        breaker: breaker.snapshot(),
      };
    },
  };
}
