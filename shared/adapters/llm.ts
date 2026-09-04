/**
 * LLM adapter - Claude multimodal wrapper for the L3 Claim Verifier.
 *
 * This is the ONLY place an LLM is reachable from. All matching, arithmetic,
 * thresholds and routing elsewhere in RCIE are deterministic code.
 *
 * The mock adapter replays scripted verifier RESPONSES so the pipeline can be
 * exercised offline. It contains no image handling of any kind: it neither reads,
 * produces nor alters evidence (SPEC §0).
 */
import { isMock } from '../mode.ts';

export class LlmTimeoutError extends Error {
  readonly code = 'timeout' as const;
}

export class LlmTransportError extends Error {
  readonly code = 'transport_error' as const;
}

export interface LlmImageRef {
  /** Opaque reference to evidence the caller already holds. */
  image_ref: string;
  media_type: string;
  /**
   * base64 payload supplied by the caller, or null when only the reference is
   * available (MODE=mock). Never populated by this adapter.
   */
  data_base64: string | null;
}

export interface LlmRequest {
  /** Claim id, carried through for audit and replay correlation. */
  correlation_id: string;
  system: string;
  /** Claim text arrives already fenced as data by lib/sanitiser.ts (F9). */
  user_text: string;
  images: LlmImageRef[];
  max_tokens: number;
  timeout_ms: number;
}

export interface LlmResponse {
  text: string;
  model_version: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export interface LlmAdapter {
  readonly kind: 'mock' | 'live';
  readonly model_version: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// --------------------------------------------------------------------------
// Mock
// --------------------------------------------------------------------------

export type MockBehaviour = 'ok' | 'malformed' | 'timeout' | 'transport_error';

export interface MockScriptEntry {
  behaviour: MockBehaviour;
  /** Raw response body for `ok` and `malformed`. */
  text?: string;
}

export interface MockLlmOptions {
  /** correlation_id -> scripted response. */
  script: Map<string, MockScriptEntry>;
  /**
   * Response used when a claim has no script entry. Must never assert support
   * for a claim - an unscripted claim is an unknown one.
   */
  fallback: MockScriptEntry;
  model_version: string;
}

export interface MockLlmAdapter extends LlmAdapter {
  /**
   * Fault injection for the F11 demo: after this is called every subsequent
   * request fails as a transport error, as if the model endpoint went down.
   */
  kill(reason: string): void;
  revive(): void;
  readonly call_count: number;
}

class MockLlm implements MockLlmAdapter {
  readonly kind = 'mock' as const;
  readonly model_version: string;
  #script: Map<string, MockScriptEntry>;
  #fallback: MockScriptEntry;
  #killed: string | null = null;
  #calls = 0;

  constructor(options: MockLlmOptions) {
    this.#script = options.script;
    this.#fallback = options.fallback;
    this.model_version = options.model_version;
  }

  get call_count(): number {
    return this.#calls;
  }

  kill(reason: string): void {
    this.#killed = reason;
  }

  revive(): void {
    this.#killed = null;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.#calls += 1;
    const startedAt = performance.now();

    if (this.#killed !== null) {
      throw new LlmTransportError(this.#killed);
    }

    const entry = this.#script.get(request.correlation_id) ?? this.#fallback;

    if (entry.behaviour === 'transport_error') {
      throw new LlmTransportError('mock: upstream returned 503');
    }
    if (entry.behaviour === 'timeout') {
      // The real timeout race lives in L3 and applies in live mode. The mock
      // reports the timeout immediately rather than stalling the demo for
      // `timeout_ms`; the classification and downstream handling are identical.
      throw new LlmTimeoutError(`mock: no response within ${request.timeout_ms}ms`);
    }

    const text = entry.text ?? '';
    return {
      text,
      model_version: this.model_version,
      input_tokens: Math.ceil(request.system.length / 4) + Math.ceil(request.user_text.length / 4),
      output_tokens: Math.ceil(text.length / 4),
      latency_ms: Math.round(performance.now() - startedAt),
    };
  }
}

export function createMockLlmAdapter(options: MockLlmOptions): MockLlmAdapter {
  return new MockLlm(options);
}

export function createLlmAdapter(options?: MockLlmOptions): LlmAdapter {
  if (isMock()) {
    if (!options) {
      throw new Error('MODE=mock requires a scripted MockLlmOptions for the llm adapter.');
    }
    return new MockLlm(options);
  }

  // TODO(LIVE): implement against the Anthropic Messages API (multimodal).
  // Requires .env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL
  // Send `system` as the system prompt and `user_text` + `images` as one user
  // turn; images must be attached as base64 blocks loaded by the caller.
  throw new Error('TODO(LIVE): live llm adapter not implemented. Set MODE=mock.');
}
