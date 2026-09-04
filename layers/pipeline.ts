/**
 * The spine: L1 -> L4.
 *
 * L0 (sanitiser), L2 (reuse) and L3 (verifier) are not wired yet; the decision
 * engine is told the verifier is unavailable and fails safe to REVIEW.
 *
 * Any thrown error inside a claim is caught here and becomes REVIEW, never
 * APPROVE. There is no path in this file - or anywhere below it - that moves money.
 */
import type { LoadedConfig } from '../shared/config/index.ts';
import type { PaymentsAdapter } from '../shared/adapters/payments.ts';
import type { StoreAdapter } from '../shared/adapters/store.ts';
import type { NotifierAdapter } from '../shared/adapters/notifier.ts';
import { AuditLogger } from '../shared/lib/logger.ts';
import type { Claim, Decision } from '../shared/types.ts';
import { runIntegrityGate, type IntegrityGateResult } from './L1-deterministic/index.ts';
import { decide } from './L4-decision/index.ts';
import { randomUUID } from 'node:crypto';

export interface Pipeline {
  resolve(claim: Claim): Promise<PipelineResult>;
}

export interface PipelineResult {
  claim: Claim;
  gate: IntegrityGateResult | null;
  decision: Decision;
  summary: string;
  /** True when the claim was settled by L1 alone, i.e. no model budget spent. */
  resolved_without_model_call: boolean;
}

export interface PipelineDeps {
  payments: PaymentsAdapter;
  store: StoreAdapter;
  notifier: NotifierAdapter;
  config: LoadedConfig;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const audit = new AuditLogger({ append: (event) => deps.store.appendAudit(event) });

  return {
    async resolve(claim: Claim): Promise<PipelineResult> {
      const startedAt = performance.now();
      audit.record(claim.id, 'PIPELINE', 'claim_received', claim, {
        order_id: claim.order_id,
        customer_id: claim.customer_id,
        amount_inr: claim.amount_inr,
        image_ref_count: claim.image_refs.length,
      });

      let gate: IntegrityGateResult | null = null;
      try {
        gate = await runIntegrityGate(claim, {
          payments: deps.payments,
          store: deps.store,
          config: deps.config,
          audit,
        });
      } catch (err) {
        // Fail-safe: an error inside the gate must never look like a clean pass.
        const message = err instanceof Error ? err.message : String(err);
        audit.record(claim.id, 'L1', 'integrity_gate_error', { claim_id: claim.id }, { message });

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
        const summary = `L1 error (${message}) - failed safe to REVIEW`;
        await deps.store.saveDecision(decision);
        await deps.notifier.notifyReviewQueue({
          claim_id: claim.id,
          outcome: decision.outcome,
          reason_codes: decision.reason_codes,
          exposure_inr: decision.exposure_inr,
          summary,
        });
        return { claim, gate: null, decision, summary, resolved_without_model_call: true };
      }

      const { decision, summary } = decide(
        {
          claim,
          gate,
          verifier: null,
          verifier_absence: 'unavailable',
          latency_ms: Math.round(performance.now() - startedAt),
        },
        { config: deps.config, audit },
      );

      await deps.store.saveDecision(decision);

      // A recommendation goes to a person. Nothing here settles the claim.
      if (decision.outcome !== 'APPROVE') {
        await deps.notifier.notifyReviewQueue({
          claim_id: claim.id,
          outcome: decision.outcome,
          reason_codes: decision.reason_codes,
          exposure_inr: decision.exposure_inr,
          summary,
        });
      }

      return {
        claim,
        gate,
        decision,
        summary,
        // Nothing above L1 ran, so no model budget was spent on this claim.
        resolved_without_model_call: true,
      };
    },
  };
}
