/**
 * Store adapter — RCIE's own records: claims, evidence, decisions, reuse hits,
 * audit events, human review.
 *
 * MODE=mock is an in-memory store seeded from the synthetic fixtures.
 */
import { isMock } from '../mode.ts';
import type {
  AuditEvent,
  Claim,
  Decision,
  Evidence,
  HumanReview,
  ReuseHit,
} from '../types.ts';

export interface StoreAdapter {
  readonly kind: 'mock' | 'live';

  getClaim(claimId: string): Promise<Claim | null>;
  listClaims(): Promise<Claim[]>;
  /** Prior claims by this customer, submitted strictly before `before`. */
  listPriorClaimsByCustomer(customerId: string, before: string): Promise<Claim[]>;
  /** Prior claims against this order, submitted strictly before `before`. */
  listPriorClaimsByOrder(orderId: string, before: string): Promise<Claim[]>;

  listEvidenceForClaim(claimId: string): Promise<Evidence[]>;

  saveDecision(decision: Decision): Promise<void>;
  getDecision(claimId: string): Promise<Decision | null>;
  listDecisions(): Promise<Decision[]>;

  saveReuseHit(hit: ReuseHit): Promise<void>;
  listReuseHits(claimId: string): Promise<ReuseHit[]>;

  appendAudit(event: AuditEvent): void;
  listAudit(claimId: string): AuditEvent[];
  allAudit(): AuditEvent[];

  saveHumanReview(review: HumanReview): Promise<void>;
}

export interface StoreSeed {
  claims: Claim[];
  evidence: Evidence[];
}

class MockStoreAdapter implements StoreAdapter {
  readonly kind = 'mock' as const;
  #claims = new Map<string, Claim>();
  #evidence = new Map<string, Evidence[]>();
  #decisions = new Map<string, Decision>();
  #reuseHits = new Map<string, ReuseHit[]>();
  #audit: AuditEvent[] = [];
  #humanReviews: HumanReview[] = [];

  constructor(seed: StoreSeed) {
    for (const claim of seed.claims) this.#claims.set(claim.id, claim);
    for (const ev of seed.evidence) {
      const list = this.#evidence.get(ev.claim_id) ?? [];
      list.push(ev);
      this.#evidence.set(ev.claim_id, list);
    }
  }

  async getClaim(claimId: string): Promise<Claim | null> {
    return this.#claims.get(claimId) ?? null;
  }

  async listClaims(): Promise<Claim[]> {
    return [...this.#claims.values()].sort((a, b) =>
      a.submitted_at < b.submitted_at ? -1 : a.submitted_at > b.submitted_at ? 1 : 0,
    );
  }

  async listPriorClaimsByCustomer(customerId: string, before: string): Promise<Claim[]> {
    return [...this.#claims.values()].filter(
      (c) => c.customer_id === customerId && c.submitted_at < before,
    );
  }

  async listPriorClaimsByOrder(orderId: string, before: string): Promise<Claim[]> {
    return [...this.#claims.values()].filter(
      (c) => c.order_id === orderId && c.submitted_at < before,
    );
  }

  async listEvidenceForClaim(claimId: string): Promise<Evidence[]> {
    return this.#evidence.get(claimId) ?? [];
  }

  async saveDecision(decision: Decision): Promise<void> {
    this.#decisions.set(decision.claim_id, decision);
  }

  async getDecision(claimId: string): Promise<Decision | null> {
    return this.#decisions.get(claimId) ?? null;
  }

  async listDecisions(): Promise<Decision[]> {
    return [...this.#decisions.values()];
  }

  async saveReuseHit(hit: ReuseHit): Promise<void> {
    const list = this.#reuseHits.get(hit.claim_id) ?? [];
    list.push(hit);
    this.#reuseHits.set(hit.claim_id, list);
  }

  async listReuseHits(claimId: string): Promise<ReuseHit[]> {
    return this.#reuseHits.get(claimId) ?? [];
  }

  appendAudit(event: AuditEvent): void {
    this.#audit.push(event);
  }

  listAudit(claimId: string): AuditEvent[] {
    return this.#audit.filter((e) => e.claim_id === claimId);
  }

  allAudit(): AuditEvent[] {
    return [...this.#audit];
  }

  async saveHumanReview(review: HumanReview): Promise<void> {
    this.#humanReviews.push(review);
  }
}

export function createStoreAdapter(seed: StoreSeed): StoreAdapter {
  if (isMock()) return new MockStoreAdapter(seed);

  // TODO(LIVE): implement against SQLite/Postgres using the SPEC §6 schema.
  // Requires .env: DATABASE_URL
  throw new Error('TODO(LIVE): live store adapter not implemented. Set MODE=mock.');
}
