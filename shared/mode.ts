/**
 * Global adapter toggle. Every adapter in /shared/adapters branches on this and
 * nothing else. MODE=mock is the default: no credentials, no network.
 */
export type Mode = 'mock' | 'live';

function parse(raw: string, varName: string): Mode {
  const v = raw.trim().toLowerCase();
  if (v === 'live') return 'live';
  if (v === 'mock') return 'mock';
  throw new Error(`Invalid ${varName}="${raw}". Expected "mock" or "live".`);
}

export function currentMode(): Mode {
  return parse(process.env.MODE ?? 'mock', 'MODE');
}

export function isMock(): boolean {
  return currentMode() === 'mock';
}

/**
 * Narrow override for the LLM adapter alone (`LLM_MODE=live`).
 *
 * The evaluation needs real model calls against real benchmark images while
 * every adapter that touches an order, a payment or a merchant stays on mock
 * data. Flipping the global MODE would take the live branch in payments, store
 * and notifier as well; those branches are unimplemented and throw, but relying
 * on a throw for money safety is not a design. This override is the seam, and
 * it is deliberately one-directional: it can only widen the LLM adapter, never
 * any other adapter.
 *
 * Defaults to MODE when unset, so nothing changes for existing runs.
 */
export function llmMode(): Mode {
  const raw = process.env.LLM_MODE;
  return raw === undefined || raw.trim() === '' ? currentMode() : parse(raw, 'LLM_MODE');
}
