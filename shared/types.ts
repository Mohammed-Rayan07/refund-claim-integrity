/**
 * Data model — SPEC §6.
 * Money is stored in whole INR (the fixtures and policy config are in rupees).
 */

export type ClaimStatus = 'submitted' | 'in_review' | 'resolved';
export type PaymentState = 'captured' | 'failed' | 'pending' | 'refunded' | 'reversed';
export type OrderState = 'created' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
export type Outcome = 'APPROVE' | 'REVIEW' | 'DENY_RECOMMEND';
export type ReuseSource = 'customer_history' | 'merchant_catalogue' | 'shared_index';
export type VerifierSupport = 'yes' | 'no' | 'insufficient';

export interface LineItem {
  sku: string;
  title: string;
  category: string;
  qty: number;
  unit_price_inr: number;
}

export interface Order {
  id: string;
  customer_id: string;
  line_items: LineItem[];
  total_inr: number;
  captured_at: string | null;
  delivered_at: string | null;
  state: OrderState;
}

export interface Payment {
  id: string;
  order_id: string;
  state: PaymentState;
  amount_inr: number;
}

export interface Claim {
  id: string;
  order_id: string;
  customer_id: string;
  claim_text: string;
  claimed_sku: string;
  amount_inr: number;
  submitted_at: string;
  image_refs: string[];
  status: ClaimStatus;
}

export interface Evidence {
  id: string;
  claim_id: string;
  image_ref: string;
  phash: string | null;
  submitted_at: string;
}

export interface Decision {
  id: string;
  claim_id: string;
  outcome: Outcome;
  reason_codes: string[];
  confidence: number | null;
  exposure_inr: number;
  model_version: string | null;
  prompt_version: string | null;
  config_snapshot_id: string;
  latency_ms: number;
  cost_inr: number;
  decided_at: string;
}

export interface ReuseHit {
  id: string;
  claim_id: string;
  matched_claim_id: string | null;
  catalogue_ref: string | null;
  similarity: number;
  source: ReuseSource;
}

export interface AuditEvent {
  id: string;
  claim_id: string;
  layer: string;
  event: string;
  payload_hash: string;
  timestamp: string;
  detail?: Record<string, unknown>;
}

export interface HumanReview {
  id: string;
  claim_id: string;
  reviewer: string;
  verdict: Outcome;
  agreed_with_system: boolean;
  notes: string;
  at: string;
}

export interface Policy {
  version: string;
  merchant_id: string;
  auto_approve_ceiling: number;
  review_rules: Array<{ id: string; when: string; outcome: Outcome }>;
  category_overrides: Record<string, { auto_approve_ceiling: number }>;
}

export interface Thresholds {
  version: string;
  integrity_gate: {
    refund_window_days: number;
    velocity_window_days: number;
    velocity_max_claims: number;
    amount_tolerance_inr: number;
  };
  decision: {
    base_threshold: number;
    scaling_factor: number;
    max_confidence_threshold: number;
    reuse_cut: number;
  };
  verifier: {
    timeout_ms: number;
    max_retries: number;
  };
}
