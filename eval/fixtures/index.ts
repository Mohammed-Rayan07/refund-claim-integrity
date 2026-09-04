/**
 * Synthetic fixtures - ORDERS, SKUs, CUSTOMERS, PAYMENTS and REFUND HISTORY only.
 *
 * SPEC §0 / §5: generating synthetic business data is fine. Generating fake
 * damage evidence is forbidden and this repo contains no capability to do it.
 * `image_refs` here are opaque placeholder strings; no image is produced, read,
 * edited or synthesised anywhere in this module.
 *
 * Everything is deterministic: fixed base date, fixed ids, no randomness.
 */
import type { Claim, Evidence, LineItem, Order, Payment, PaymentState } from '../../shared/types.ts';

export const BASE_NOW = '2026-09-01T00:00:00.000Z';

export type Scenario =
  | 'clean'
  | 'order_not_found'
  | 'order_ownership_mismatch'
  | 'payment_not_captured'
  | 'refund_state_invalid'
  | 'sku_mismatch'
  | 'amount_exceeds'
  | 'window_expired'
  | 'duplicate_claim'
  | 'velocity_exceeded';

export interface FixtureCase {
  claim_id: string;
  scenario: Scenario;
  /** The reason code L1 is expected to emit, or null when L1 should pass clean. */
  expected_reason_code: string | null;
  note: string;
}

export interface Fixtures {
  orders: Order[];
  payments: Payment[];
  claims: Claim[];
  evidence: Evidence[];
  cases: FixtureCase[];
}

interface CatalogueEntry {
  sku: string;
  title: string;
  category: string;
  unit_price_inr: number;
}

const CATALOGUE: CatalogueEntry[] = [
  { sku: 'SKU-EL-1001', title: 'Wireless Earbuds', category: 'electronics', unit_price_inr: 2499 },
  { sku: 'SKU-EL-1002', title: 'Bluetooth Speaker', category: 'electronics', unit_price_inr: 3299 },
  { sku: 'SKU-EL-1003', title: '65W Fast Charger', category: 'electronics', unit_price_inr: 1899 },
  { sku: 'SKU-EL-1004', title: 'Smart Watch', category: 'electronics', unit_price_inr: 7499 },
  { sku: 'SKU-AP-2001', title: 'Cotton Kurta', category: 'apparel', unit_price_inr: 1299 },
  { sku: 'SKU-AP-2002', title: 'Running Shoes', category: 'apparel', unit_price_inr: 3499 },
  { sku: 'SKU-AP-2003', title: 'Denim Jacket', category: 'apparel', unit_price_inr: 2799 },
  { sku: 'SKU-HM-3001', title: 'Ceramic Dinner Set', category: 'home', unit_price_inr: 2199 },
  { sku: 'SKU-HM-3002', title: 'Table Lamp', category: 'home', unit_price_inr: 1499 },
  { sku: 'SKU-GR-4001', title: 'Cold Pressed Oil 5L', category: 'grocery', unit_price_inr: 1199 },
];

/** Claim text is ordinary customer prose - a description, never an instruction. */
const CLAIM_TEXTS = [
  'Item arrived with a cracked casing, visible along the left edge.',
  'Package was open on delivery and the item inside is scratched.',
  'Product stopped working within two days of delivery.',
  'Wrong colour delivered compared to what I ordered.',
  'Fabric has a tear near the seam, present when unboxed.',
  'Screen has a dead pixel line across the middle.',
  'Item is missing accessories listed on the product page.',
  'Bottle leaked in transit, half the contents lost.',
];

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString();
}

function pick<T>(list: T[], i: number): T {
  const item = list[i % list.length];
  if (!item) throw new Error('empty fixture list');
  return item;
}

class FixtureBuilder {
  orders: Order[] = [];
  payments: Payment[] = [];
  claims: Claim[] = [];
  evidence: Evidence[] = [];
  cases: FixtureCase[] = [];

  #orderSeq = 0;
  #claimSeq = 0;

  /** Creates an order plus its payment. Timings are expressed in days before BASE_NOW. */
  makeOrder(opts: {
    customer_id: string;
    skus: string[];
    capturedDaysAgo: number;
    deliveredDaysAgo: number | null;
    paymentState: PaymentState;
  }): { order: Order; payment: Payment } {
    this.#orderSeq += 1;
    const id = `ORD_${String(this.#orderSeq).padStart(4, '0')}`;

    const line_items: LineItem[] = opts.skus.map((sku, idx) => {
      const entry = CATALOGUE.find((c) => c.sku === sku);
      if (!entry) throw new Error(`unknown sku ${sku}`);
      return {
        sku: entry.sku,
        title: entry.title,
        category: entry.category,
        qty: idx === 0 ? 1 : 1,
        unit_price_inr: entry.unit_price_inr,
      };
    });

    const total_inr = line_items.reduce((sum, li) => sum + li.unit_price_inr * li.qty, 0);
    const captured = opts.paymentState === 'failed' || opts.paymentState === 'pending';

    const order: Order = {
      id,
      customer_id: opts.customer_id,
      line_items,
      total_inr,
      captured_at: captured ? null : daysBefore(BASE_NOW, opts.capturedDaysAgo),
      delivered_at:
        opts.deliveredDaysAgo === null ? null : daysBefore(BASE_NOW, opts.deliveredDaysAgo),
      state: opts.deliveredDaysAgo === null ? (captured ? 'created' : 'paid') : 'delivered',
    };

    const payment: Payment = {
      id: `PAY_${String(this.#orderSeq).padStart(4, '0')}`,
      order_id: id,
      state: opts.paymentState,
      amount_inr: total_inr,
    };

    this.orders.push(order);
    this.payments.push(payment);
    return { order, payment };
  }

  makeClaim(opts: {
    order_id: string;
    customer_id: string;
    claimed_sku: string;
    amount_inr: number;
    submittedDaysAgo: number;
    imageCount?: number;
    scenario: Scenario;
    expected_reason_code: string | null;
    note: string;
  }): Claim {
    this.#claimSeq += 1;
    const id = `CLM_${String(this.#claimSeq).padStart(4, '0')}`;
    const submitted_at = daysBefore(BASE_NOW, opts.submittedDaysAgo);
    const imageCount = opts.imageCount ?? 2;

    // Placeholder references only. No image data exists in this repo.
    const image_refs = Array.from({ length: imageCount }, (_, i) => `placeholder://${id}/img${i + 1}`);

    const claim: Claim = {
      id,
      order_id: opts.order_id,
      customer_id: opts.customer_id,
      claim_text: pick(CLAIM_TEXTS, this.#claimSeq),
      claimed_sku: opts.claimed_sku,
      amount_inr: opts.amount_inr,
      submitted_at,
      image_refs,
      status: 'submitted',
    };

    for (const [i, ref] of image_refs.entries()) {
      this.evidence.push({
        id: `EV_${id}_${i + 1}`,
        claim_id: id,
        image_ref: ref,
        phash: null, // computed in Chunk 3 (L2)
        submitted_at,
      });
    }

    this.claims.push(claim);
    this.cases.push({
      claim_id: id,
      scenario: opts.scenario,
      expected_reason_code: opts.expected_reason_code,
      note: opts.note,
    });
    return claim;
  }

  price(sku: string): number {
    const entry = CATALOGUE.find((c) => c.sku === sku);
    if (!entry) throw new Error(`unknown sku ${sku}`);
    return entry.unit_price_inr;
  }
}

export function buildFixtures(): Fixtures {
  const b = new FixtureBuilder();
  let customerSeq = 0;
  const nextCustomer = (): string => {
    customerSeq += 1;
    return `CUST_${String(customerSeq).padStart(3, '0')}`;
  };

  // --- 20 clean claims: captured, delivered, in-window, correct SKU and amount ---
  for (let i = 0; i < 20; i += 1) {
    const customer = nextCustomer();
    const primary = pick(CATALOGUE, i).sku;
    const secondary = pick(CATALOGUE, i + 3).sku;
    const skus = primary === secondary ? [primary] : [primary, secondary];
    const { order } = b.makeOrder({
      customer_id: customer,
      skus,
      capturedDaysAgo: 14,
      deliveredDaysAgo: 10,
      paymentState: 'captured',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: primary,
      amount_inr: b.price(primary),
      submittedDaysAgo: 3,
      scenario: 'clean',
      expected_reason_code: null,
      note: 'all eight integrity checks pass',
    });
  }

  // --- 4 order-not-found ---
  for (let i = 0; i < 4; i += 1) {
    const customer = nextCustomer();
    const sku = pick(CATALOGUE, i + 1).sku;
    b.makeClaim({
      order_id: `ORD_MISSING_${i + 1}`,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 2,
      scenario: 'order_not_found',
      expected_reason_code: 'RCI-01',
      note: 'claim references an order id that does not exist',
    });
  }

  // --- 3 order-ownership mismatch ---
  for (let i = 0; i < 3; i += 1) {
    const owner = nextCustomer();
    const claimant = nextCustomer();
    const sku = pick(CATALOGUE, i + 2).sku;
    const { order } = b.makeOrder({
      customer_id: owner,
      skus: [sku],
      capturedDaysAgo: 12,
      deliveredDaysAgo: 8,
      paymentState: 'captured',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: claimant,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 2,
      scenario: 'order_ownership_mismatch',
      expected_reason_code: 'RCI-01',
      note: 'order belongs to a different customer',
    });
  }

  // --- 5 payment not captured (failed / pending) ---
  for (let i = 0; i < 5; i += 1) {
    const customer = nextCustomer();
    const sku = pick(CATALOGUE, i + 4).sku;
    const state: PaymentState = i % 2 === 0 ? 'failed' : 'pending';
    const { order } = b.makeOrder({
      customer_id: customer,
      skus: [sku],
      capturedDaysAgo: 9,
      deliveredDaysAgo: null,
      paymentState: state,
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 2,
      scenario: 'payment_not_captured',
      expected_reason_code: 'RCI-06',
      note: `payment is ${state}, nothing was ever collected`,
    });
  }

  // --- 4 invalid refund state (already refunded / reversed) ---
  for (let i = 0; i < 4; i += 1) {
    const customer = nextCustomer();
    const sku = pick(CATALOGUE, i + 6).sku;
    const state: PaymentState = i % 2 === 0 ? 'refunded' : 'reversed';
    const { order } = b.makeOrder({
      customer_id: customer,
      skus: [sku],
      capturedDaysAgo: 15,
      deliveredDaysAgo: 11,
      paymentState: state,
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 2,
      scenario: 'refund_state_invalid',
      expected_reason_code: 'RCI-06',
      note: state === 'refunded' ? 'double refund attempt' : 'refund on a reversed payment',
    });
  }

  // --- 6 SKU mismatch: claimed item was never in the order ---
  for (let i = 0; i < 6; i += 1) {
    const customer = nextCustomer();
    const ordered = pick(CATALOGUE, i).sku;
    const claimed = pick(CATALOGUE, i + 5).sku;
    const { order } = b.makeOrder({
      customer_id: customer,
      skus: [ordered],
      capturedDaysAgo: 13,
      deliveredDaysAgo: 9,
      paymentState: 'captured',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: claimed,
      amount_inr: b.price(ordered),
      submittedDaysAgo: 3,
      scenario: 'sku_mismatch',
      expected_reason_code: 'RCI-04',
      note: `claims ${claimed}, order contains ${ordered}`,
    });
  }

  // --- 5 amount exceeds the line item / order ---
  for (let i = 0; i < 5; i += 1) {
    const customer = nextCustomer();
    const sku = pick(CATALOGUE, i + 2).sku;
    const { order } = b.makeOrder({
      customer_id: customer,
      skus: [sku],
      capturedDaysAgo: 12,
      deliveredDaysAgo: 7,
      paymentState: 'captured',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku) + 1500 + i * 250,
      submittedDaysAgo: 2,
      scenario: 'amount_exceeds',
      expected_reason_code: 'RCI-02',
      note: 'refund asked for more than the item was worth',
    });
  }

  // --- 5 refund window expired ---
  for (let i = 0; i < 5; i += 1) {
    const customer = nextCustomer();
    const sku = pick(CATALOGUE, i + 7).sku;
    const { order } = b.makeOrder({
      customer_id: customer,
      skus: [sku],
      capturedDaysAgo: 75 + i * 5,
      deliveredDaysAgo: 70 + i * 5,
      paymentState: 'captured',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 1,
      scenario: 'window_expired',
      expected_reason_code: 'RCI-03',
      note: 'filed well outside the configured refund window',
    });
  }

  // --- 4 duplicate claims: same order, same line item, claimed twice ---
  for (let i = 0; i < 4; i += 1) {
    const customer = nextCustomer();
    const sku = pick(CATALOGUE, i + 3).sku;
    const { order } = b.makeOrder({
      customer_id: customer,
      skus: [sku],
      capturedDaysAgo: 20,
      deliveredDaysAgo: 16,
      paymentState: 'captured',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 8,
      scenario: 'clean',
      expected_reason_code: null,
      note: 'first claim on this line item - legitimate',
    });
    b.makeClaim({
      order_id: order.id,
      customer_id: customer,
      claimed_sku: sku,
      amount_inr: b.price(sku),
      submittedDaysAgo: 3,
      scenario: 'duplicate_claim',
      expected_reason_code: 'RCI-05',
      note: 'second claim on the same order and line item',
    });
  }

  // --- velocity: two customers filing past the configured limit ---
  // The first three claims sit inside the limit; the fourth and fifth trip it.
  for (let c = 0; c < 2; c += 1) {
    const customer = nextCustomer();
    for (let i = 0; i < 5; i += 1) {
      const sku = pick(CATALOGUE, c + i).sku;
      const { order } = b.makeOrder({
        customer_id: customer,
        skus: [sku],
        capturedDaysAgo: 25 - i * 2,
        deliveredDaysAgo: 22 - i * 2,
        paymentState: 'captured',
      });
      const tripsLimit = i >= 3;
      b.makeClaim({
        order_id: order.id,
        customer_id: customer,
        claimed_sku: sku,
        amount_inr: b.price(sku),
        submittedDaysAgo: 20 - i * 4,
        scenario: tripsLimit ? 'velocity_exceeded' : 'clean',
        expected_reason_code: tripsLimit ? 'RCI-12' : null,
        note: tripsLimit
          ? 'customer past the configured claims-per-window limit'
          : 'within the configured claims-per-window limit',
      });
    }
  }

  return {
    orders: b.orders,
    payments: b.payments,
    claims: b.claims,
    evidence: b.evidence,
    cases: b.cases,
  };
}
