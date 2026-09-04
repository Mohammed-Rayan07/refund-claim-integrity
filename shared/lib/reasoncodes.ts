/**
 * F5 - Structured reason codes (SPEC §3 F5).
 * Machine-readable, mirroring chargeback reason-code convention.
 * Every decision carries these; nothing user-facing is free text only.
 *
 * RCI-01..RCI-12 are the set defined in SPEC §3 F5.
 *
 * RCI-13..RCI-15 are OPERATOR-ADDED beyond the spec, on the rule that no REVIEW
 * may be a silent flag. SPEC §7's ladder routes three cases to REVIEW without
 * naming a code - injection suspected, confidence below the exposure-scaled bar,
 * and exposure above the merchant's policy ceiling. A reviewer opening those in
 * the queue would see an empty `reason_codes` array and no machine-readable
 * account of why a human was asked. These three close that gap. The divergence
 * from the spec's twelve is deliberate and documented here rather than silent.
 */

export const REASON_CODES = {
  'RCI-01': 'ORDER_NOT_FOUND',
  'RCI-02': 'AMOUNT_EXCEEDS_ORDER',
  'RCI-03': 'WINDOW_EXPIRED',
  'RCI-04': 'SKU_MISMATCH',
  'RCI-05': 'DUPLICATE_CLAIM',
  'RCI-06': 'PAYMENT_NOT_CAPTURED',
  'RCI-07': 'CLAIM_UNSUPPORTED',
  'RCI-08': 'INTERNAL_CONTRADICTION',
  'RCI-09': 'EVIDENCE_REUSED',
  'RCI-10': 'STOCK_IMAGE_SUBMITTED',
  'RCI-11': 'INSUFFICIENT_EVIDENCE',
  'RCI-12': 'VELOCITY_EXCEEDED',
  // --- operator-added, see the module note above ---
  'RCI-13': 'INJECTION_SUSPECTED',
  'RCI-14': 'CONFIDENCE_BELOW_THRESHOLD',
  'RCI-15': 'POLICY_CEILING_EXCEEDED',
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

/** Codes beyond SPEC §3 F5's twelve. Surfaced so the dashboard can mark them. */
export const OPERATOR_ADDED_CODES: readonly ReasonCode[] = ['RCI-13', 'RCI-14', 'RCI-15'];

export function reasonName(code: ReasonCode): string {
  return REASON_CODES[code];
}

export function describe(code: ReasonCode): string {
  return `${code} ${REASON_CODES[code]}`;
}

export function describeAll(codes: ReasonCode[]): string {
  return codes.length === 0 ? '(none)' : codes.map(describe).join(', ');
}

export function isReasonCode(value: string): value is ReasonCode {
  return Object.hasOwn(REASON_CODES, value);
}
