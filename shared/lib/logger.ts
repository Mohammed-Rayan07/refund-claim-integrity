/**
 * F6 — Full audit trail (SPEC §3 F6).
 *
 * Every check, input hash, and decision is logged as an AuditEvent so any
 * decision is reconstructible after the fact. Payloads are hashed rather than
 * stored verbatim: the hash proves what was seen without duplicating claim
 * content into the audit log.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuditEvent } from '../types.ts';

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32);
}

/** Deterministic JSON so the same payload always hashes to the same value. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export interface AuditSink {
  append(event: AuditEvent): void;
}

export class AuditLogger {
  #sink: AuditSink;

  constructor(sink: AuditSink) {
    this.#sink = sink;
  }

  record(
    claimId: string,
    layer: string,
    event: string,
    payload: unknown,
    detail?: Record<string, unknown>,
  ): AuditEvent {
    const entry: AuditEvent = {
      id: `AE_${randomUUID()}`,
      claim_id: claimId,
      layer,
      event,
      payload_hash: hashPayload(payload),
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    };
    this.#sink.append(entry);
    return entry;
  }
}
