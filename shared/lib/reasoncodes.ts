/**
 * F5 — Structured reason codes (SPEC §3 F5).
 * Machine-readable, mirroring chargeback reason-code convention.
 * Every decision carries these; nothing user-facing is free text only.
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
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

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
