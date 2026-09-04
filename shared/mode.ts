/**
 * Global adapter toggle. Every adapter in /shared/adapters branches on this and
 * nothing else. MODE=mock is the default: no credentials, no network.
 */
export type Mode = 'mock' | 'live';

export function currentMode(): Mode {
  const raw = (process.env.MODE ?? 'mock').trim().toLowerCase();
  if (raw === 'live') return 'live';
  if (raw === 'mock') return 'mock';
  throw new Error(`Invalid MODE="${raw}". Expected "mock" or "live".`);
}

export function isMock(): boolean {
  return currentMode() === 'mock';
}
