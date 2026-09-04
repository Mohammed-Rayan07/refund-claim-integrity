/**
 * L1 - Deterministic Integrity Gate (SPEC §3 F1).
 *
 * Pure code, sub-millisecond, no model call, fully explainable. Eight checks run
 * in a fixed order; the first hard failure emits its reason code and
 * short-circuits, so no model budget is ever spent on a claim that fails here.
 *
 * Every business value used below comes from config - nothing is hardcoded.
 */
import type { LoadedConfig } from '../../shared/config/index.ts';
import type { PaymentsAdapter } from '../../shared/adapters/payments.ts';
import type { StoreAdapter } from '../../shared/adapters/store.ts';
import type { AuditLogger } from '../../shared/lib/logger.ts';
import type { ReasonCode } from '../../shared/lib/reasoncodes.ts';
import type { Claim, LineItem, Order, Payment } from '../../shared/types.ts';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  reason_code?: ReasonCode;
  detail: string;
}

export interface IntegrityGateResult {
  passed: boolean;
  reason_codes: ReasonCode[];
  checks: CheckResult[];
  failed_check: string | null;
  /** Populated once the order is resolved - downstream layers reuse it. */
  order: Order | null;
  payment: Payment | null;
  line_item: LineItem | null;
}

const CHECK_IDS = [
  'CHK_ORDER_EXISTS',
  'CHK_PAYMENT_CAPTURED',
  'CHK_REFUND_STATE_VALID',
  'CHK_SKU_IN_ORDER',
  'CHK_AMOUNT_WITHIN_ORDER',
  'CHK_REFUND_WINDOW_OPEN',
  'CHK_NOT_DUPLICATE',
  'CHK_VELOCITY_WITHIN_LIMIT',
] as const;

export interface IntegrityGateDeps {
  payments: PaymentsAdapter;
  store: StoreAdapter;
  config: LoadedConfig;
  audit: AuditLogger;
}

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

export async function runIntegrityGate(
  claim: Claim,
  deps: IntegrityGateDeps,
): Promise<IntegrityGateResult> {
  const { payments, store, config, audit } = deps;
  const gate = config.thresholds.integrity_gate;

  const checks: CheckResult[] = [];
  let order: Order | null = null;
  let payment: Payment | null = null;
  let lineItem: LineItem | null = null;

  const pass = (id: string, detail: string): void => {
    checks.push({ id, status: 'pass', detail });
  };

  const fail = (id: string, reason_code: ReasonCode, detail: string): CheckResult => {
    const c: CheckResult = { id, status: 'fail', reason_code, detail };
    checks.push(c);
    return c;
  };

  const finish = (failed: CheckResult | null): IntegrityGateResult => {
    if (failed) {
      for (const id of CHECK_IDS.slice(checks.length)) {
        checks.push({ id, status: 'skipped', detail: 'short-circuited by earlier failure' });
      }
    }
    const reason_codes = checks.flatMap((c) =>
      c.status === 'fail' && c.reason_code ? [c.reason_code] : [],
    );
    const result: IntegrityGateResult = {
      passed: failed === null,
      reason_codes,
      checks,
      failed_check: failed?.id ?? null,
      order,
      payment,
      line_item: lineItem,
    };
    audit.record(
      claim.id,
      'L1',
      result.passed ? 'integrity_gate_passed' : 'integrity_gate_failed',
      {
        claim_id: claim.id,
        order_id: claim.order_id,
        claimed_sku: claim.claimed_sku,
        amount_inr: claim.amount_inr,
        submitted_at: claim.submitted_at,
      },
      {
        reason_codes,
        failed_check: failed?.id ?? null,
        checks_run: checks.filter((c) => c.status !== 'skipped').length,
        config_snapshot_id: config.snapshot_id,
      },
    );
    return result;
  };

  // 1. Order exists and belongs to the claiming customer.
  order = await payments.getOrder(claim.order_id);
  if (!order) {
    return finish(fail('CHK_ORDER_EXISTS', 'RCI-01', `order ${claim.order_id} not found`));
  }
  if (order.customer_id !== claim.customer_id) {
    return finish(
      fail(
        'CHK_ORDER_EXISTS',
        'RCI-01',
        `order ${order.id} belongs to ${order.customer_id}, claim filed by ${claim.customer_id}`,
      ),
    );
  }
  pass('CHK_ORDER_EXISTS', `order ${order.id} owned by ${claim.customer_id}`);

  // 2. Payment actually captured - not missing, failed or still pending.
  payment = await payments.getPaymentForOrder(claim.order_id);
  if (!payment) {
    return finish(
      fail('CHK_PAYMENT_CAPTURED', 'RCI-06', `no payment record for order ${order.id}`),
    );
  }
  if (payment.state === 'failed' || payment.state === 'pending') {
    return finish(
      fail('CHK_PAYMENT_CAPTURED', 'RCI-06', `payment ${payment.id} is ${payment.state}`),
    );
  }
  pass('CHK_PAYMENT_CAPTURED', `payment ${payment.id} state=${payment.state}`);

  // 3. Refund state machine valid - no double refund, no refund on a reversed payment.
  if (payment.state === 'refunded') {
    return finish(
      fail('CHK_REFUND_STATE_VALID', 'RCI-06', `payment ${payment.id} already refunded`),
    );
  }
  if (payment.state === 'reversed') {
    return finish(fail('CHK_REFUND_STATE_VALID', 'RCI-06', `payment ${payment.id} was reversed`));
  }
  pass('CHK_REFUND_STATE_VALID', 'no prior refund, payment not reversed');

  // 4. Claimed SKU present in the order.
  lineItem = order.line_items.find((li) => li.sku === claim.claimed_sku) ?? null;
  if (!lineItem) {
    const ordered = order.line_items.map((li) => li.sku).join(', ');
    return finish(
      fail(
        'CHK_SKU_IN_ORDER',
        'RCI-04',
        `sku ${claim.claimed_sku} not in order ${order.id} (ordered: ${ordered})`,
      ),
    );
  }
  pass('CHK_SKU_IN_ORDER', `sku ${lineItem.sku} present in order`);

  // 5. Refund amount within the order total, and within the line item when partial.
  const lineTotal = lineItem.unit_price_inr * lineItem.qty;
  const tolerance = gate.amount_tolerance_inr;
  if (claim.amount_inr > order.total_inr + tolerance) {
    return finish(
      fail(
        'CHK_AMOUNT_WITHIN_ORDER',
        'RCI-02',
        `claimed INR ${claim.amount_inr} exceeds order total INR ${order.total_inr}`,
      ),
    );
  }
  if (claim.amount_inr > lineTotal + tolerance) {
    return finish(
      fail(
        'CHK_AMOUNT_WITHIN_ORDER',
        'RCI-02',
        `claimed INR ${claim.amount_inr} exceeds line-item value INR ${lineTotal} for ${lineItem.sku}`,
      ),
    );
  }
  pass('CHK_AMOUNT_WITHIN_ORDER', `claimed INR ${claim.amount_inr} within line-item INR ${lineTotal}`);

  // 6. Refund window still open - measured from delivery where known, else capture.
  const windowStart = order.delivered_at ?? order.captured_at;
  if (!windowStart) {
    return finish(
      fail(
        'CHK_REFUND_WINDOW_OPEN',
        'RCI-03',
        `order ${order.id} has neither delivered_at nor captured_at`,
      ),
    );
  }
  const elapsedDays = daysBetween(windowStart, claim.submitted_at);
  const anchor = order.delivered_at ? 'delivery' : 'capture';
  if (elapsedDays > gate.refund_window_days) {
    return finish(
      fail(
        'CHK_REFUND_WINDOW_OPEN',
        'RCI-03',
        `filed ${elapsedDays.toFixed(1)}d after ${anchor}, window is ${gate.refund_window_days}d`,
      ),
    );
  }
  pass(
    'CHK_REFUND_WINDOW_OPEN',
    `filed ${elapsedDays.toFixed(1)}d after ${anchor}, window ${gate.refund_window_days}d`,
  );

  // 7. Duplicate claim - same order, same line item, already claimed.
  const priorOnOrder = await store.listPriorClaimsByOrder(claim.order_id, claim.submitted_at);
  const duplicate = priorOnOrder.find((c) => c.claimed_sku === claim.claimed_sku);
  if (duplicate) {
    return finish(
      fail(
        'CHK_NOT_DUPLICATE',
        'RCI-05',
        `${duplicate.id} already claims ${claim.claimed_sku} on order ${order.id}`,
      ),
    );
  }
  pass('CHK_NOT_DUPLICATE', `no prior claim for ${claim.claimed_sku} on this order`);

  // 8. Customer claim velocity - N claims in M days.
  const priorByCustomer = await store.listPriorClaimsByCustomer(
    claim.customer_id,
    claim.submitted_at,
  );
  const inWindow = priorByCustomer.filter(
    (c) => daysBetween(c.submitted_at, claim.submitted_at) <= gate.velocity_window_days,
  );
  const totalInWindow = inWindow.length + 1;
  if (inWindow.length >= gate.velocity_max_claims) {
    return finish(
      fail(
        'CHK_VELOCITY_WITHIN_LIMIT',
        'RCI-12',
        `${totalInWindow} claims in ${gate.velocity_window_days}d, limit is ${gate.velocity_max_claims}`,
      ),
    );
  }
  pass(
    'CHK_VELOCITY_WITHIN_LIMIT',
    `${totalInWindow} claims in ${gate.velocity_window_days}d, limit ${gate.velocity_max_claims}`,
  );

  return finish(null);
}
