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
import Anthropic from '@anthropic-ai/sdk';
import { llmMode } from '../mode.ts';

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
  /**
   * Files API id, for evidence too large to inline. Set by the caller after an
   * upload; the adapter only references it. Takes precedence over data_base64.
   */
  file_id?: string | null;
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
  /**
   * JSON Schema the response must conform to. The caller owns the schema; the
   * adapter only forwards it. Live requests pass it as `output_config.format`
   * so the model is constrained at decode time rather than asked politely.
   * The caller still validates the parsed result - this narrows the failure
   * surface, it does not replace the strict check in L3.
   */
  output_schema?: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  model_version: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  /** How the response was terminated, when the transport reports it. */
  stop_reason?: string | null;
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

// --------------------------------------------------------------------------
// Live - Anthropic Messages API (multimodal)
// --------------------------------------------------------------------------

export interface LiveLlmOptions {
  /** Model id, e.g. `claude-opus-5`. */
  model: string;
  /** Reasoning effort passed through as `output_config.effort`. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

class LiveLlm implements LlmAdapter {
  readonly kind = 'live' as const;
  readonly model_version: string;
  #client: Anthropic;
  #effort: LiveLlmOptions['effort'];
  #calls = 0;

  constructor(options: LiveLlmOptions) {
    // Requires .env: ANTHROPIC_API_KEY (resolved by the SDK from the environment)
    this.#client = new Anthropic({ maxRetries: 0 });
    this.model_version = options.model;
    this.#effort = options.effort;
  }

  get call_count(): number {
    return this.#calls;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.#calls += 1;
    const startedAt = performance.now();

    // Images first, then the instruction text: the model reads the evidence in
    // the order a reviewer would, and the text block is the one that carries
    // the fenced, untrusted claim data.
    const content: Anthropic.ContentBlockParam[] = [];
    for (const image of request.images) {
      if (image.file_id) {
        content.push({ type: 'image', source: { type: 'file', file_id: image.file_id } });
        continue;
      }
      if (image.data_base64 === null) {
        // A live call with a bare reference would silently assess nothing.
        throw new LlmTransportError(
          `evidence ${image.image_ref} has no bytes - refusing to send a live ` +
            'request the model cannot see',
        );
      }
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: image.data_base64,
        },
      });
    }
    content.push({ type: 'text', text: request.user_text });

    const output_config: Record<string, unknown> = { effort: this.#effort };
    if (request.output_schema) {
      output_config['format'] = { type: 'json_schema', schema: request.output_schema };
    }

    let response: Anthropic.Message;
    try {
      response = await this.#client.messages.create(
        {
          model: this.model_version,
          max_tokens: request.max_tokens,
          system: request.system,
          messages: [{ role: 'user', content }],
          output_config,
        } as Anthropic.MessageCreateParamsNonStreaming,
        { timeout: request.timeout_ms },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new LlmTimeoutError(`live: no response within ${request.timeout_ms}ms`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LlmTransportError(`live: ${err.status ?? 'network'} ${err.message}`);
      }
      throw new LlmTransportError(err instanceof Error ? err.message : String(err));
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text,
      model_version: response.model,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      latency_ms: Math.round(performance.now() - startedAt),
      stop_reason: response.stop_reason,
    };
  }
}

/**
 * The live verifier adapter. Gated on LLM_MODE=live rather than the global MODE,
 * so a live verifier run cannot pull payments, store or notifier live with it.
 */
export function createLiveLlmAdapter(options: LiveLlmOptions): LlmAdapter {
  if (llmMode() !== 'live') {
    throw new Error('createLiveLlmAdapter requires LLM_MODE=live.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('LLM_MODE=live requires ANTHROPIC_API_KEY in the environment (.env).');
  }
  return new LiveLlm(options);
}

export function createLlmAdapter(options?: MockLlmOptions): LlmAdapter {
  if (llmMode() === 'mock') {
    if (!options) {
      throw new Error('LLM_MODE=mock requires a scripted MockLlmOptions for the llm adapter.');
    }
    return new MockLlm(options);
  }

  return createLiveLlmAdapter({
    model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',
    effort: (process.env.ANTHROPIC_EFFORT as LiveLlmOptions['effort']) ?? 'medium',
  });
}
