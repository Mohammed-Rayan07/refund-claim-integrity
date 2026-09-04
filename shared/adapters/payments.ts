/**
 * Payments adapter — Razorpay order / payment state.
 *
 * READ-ONLY BY CONSTRUCTION. This interface exposes no method that creates,
 * captures, refunds, reverses or otherwise moves money, and it never will.
 * RCIE recommends; a human acts. See SPEC §0 / §3 F4.
 *
 * MODE=mock is served from in-memory synthetic orders and payments.
 */
import { isMock } from '../mode.ts';
import type { Order, Payment } from '../types.ts';

export interface PaymentsAdapter {
  readonly kind: 'mock' | 'live';
  getOrder(orderId: string): Promise<Order | null>;
  getPaymentForOrder(orderId: string): Promise<Payment | null>;
}

export interface PaymentsSeed {
  orders: Order[];
  payments: Payment[];
}

class MockPaymentsAdapter implements PaymentsAdapter {
  readonly kind = 'mock' as const;
  #orders = new Map<string, Order>();
  #paymentsByOrder = new Map<string, Payment>();

  constructor(seed: PaymentsSeed) {
    for (const order of seed.orders) this.#orders.set(order.id, order);
    for (const payment of seed.payments) this.#paymentsByOrder.set(payment.order_id, payment);
  }

  async getOrder(orderId: string): Promise<Order | null> {
    return this.#orders.get(orderId) ?? null;
  }

  async getPaymentForOrder(orderId: string): Promise<Payment | null> {
    return this.#paymentsByOrder.get(orderId) ?? null;
  }
}

export function createPaymentsAdapter(seed: PaymentsSeed): PaymentsAdapter {
  if (isMock()) return new MockPaymentsAdapter(seed);

  // TODO(LIVE): implement against the Razorpay Orders/Payments read APIs.
  // Requires .env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
  // Fetch-only endpoints: GET /v1/orders/{id}, GET /v1/orders/{id}/payments.
  // Do NOT add refund-creating endpoints here — this adapter stays read-only.
  throw new Error('TODO(LIVE): live payments adapter not implemented. Set MODE=mock.');
}
