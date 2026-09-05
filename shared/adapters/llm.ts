/**
 * LLM adapter - multimodal wrapper for the L3 Claim Verifier.
 *
 * This is the ONLY place an LLM is reachable from. All matching, arithmetic,
 * thresholds and routing elsewhere in RCIE are deterministic code.
 *
 * Two live providers are implemented, selected by LLM_PROVIDER (see
 * `llmProvider` below): Google Gemini (the default) and Anthropic Claude
 * (kept in the repo, opt in with LLM_PROVIDER=anthropic). Both speak the same
 * LlmAdapter interface, so nothing outside this file - L3, L4, the pipeline,
 * eval, the dashboard - knows or cares which provider answered a request.
 *
 * The mock adapter replays scripted verifier RESPONSES so the pipeline can be
 * exercised offline. It contains no image handling of any kind: it neither reads,
 * produces nor alters evidence (SPEC §0).
 */
import Anthropic from '@anthropic-ai/sdk';
import { llmMode } from '../mode.ts';

export type LlmProvider = 'anthropic' | 'gemini';

/**
 * LLM_PROVIDER=anthropic opts back into Claude. Unset, empty, or any other
 * value defaults to Gemini - the current default live L3 provider. This is
 * the only switch: it never affects payments, store or notifier, which stay
 * on MODE as always.
 */
export function llmProvider(): LlmProvider {
  return process.env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'gemini';
}

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
// Live - Anthropic Messages API (multimodal). Kept in the repo, opt in with
// LLM_PROVIDER=anthropic; Gemini (below) is the default live provider.
// --------------------------------------------------------------------------

export interface LiveLlmOptions {
  /**
   * Model id for the Anthropic path, e.g. `claude-opus-5`. Ignored on the
   * Gemini path - see the note in `createLiveLlmAdapter`.
   */
  model: string;
  /** Reasoning effort passed through as `output_config.effort`. Anthropic-only. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

class AnthropicLlm implements LlmAdapter {
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

// --------------------------------------------------------------------------
// Live - Google Gemini generateContent API (multimodal). The default live
// provider (see `llmProvider`). Talks to the stable, generally-available
// `models/{model}:generateContent` REST endpoint directly over `fetch` - no
// SDK dependency, so swapping providers adds nothing to package.json.
// --------------------------------------------------------------------------

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiOptions {
  model: string;
  apiKey: string;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { code: number; message: string; status: string };
}

/**
 * Strips schema keys the Gemini API's `responseSchema` (an OpenAPI 3.0
 * subset) does not accept - `additionalProperties` chiefly - so the same
 * VERDICT_JSON_SCHEMA the Anthropic path sends still reaches Gemini without
 * a 400. This narrows the failure surface exactly as the comment on
 * VERDICT_JSON_SCHEMA (layers/L3-verifier/index.ts) already documents for
 * the Anthropic path: it does not replace `validateVerdict`, which still
 * runs, unmodified, on every response from either provider.
 */
function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const strip = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(strip);
      return;
    }
    if (node !== null && typeof node === 'object') {
      delete (node as Record<string, unknown>)['additionalProperties'];
      for (const v of Object.values(node as Record<string, unknown>)) strip(v);
    }
  };
  strip(clone);
  return clone;
}

class GeminiLlm implements LlmAdapter {
  readonly kind = 'live' as const;
  readonly model_version: string;
  #apiKey: string;
  #calls = 0;

  constructor(options: GeminiOptions) {
    this.model_version = options.model;
    this.#apiKey = options.apiKey;
  }

  get call_count(): number {
    return this.#calls;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.#calls += 1;
    const startedAt = performance.now();

    // Images first, then the instruction text - same order as the Anthropic
    // path and the same reason: the text block carries the fenced, untrusted
    // claim data.
    const parts: GeminiPart[] = [];
    for (const image of request.images) {
      if (image.file_id) {
        // The Files API id path is Anthropic-specific plumbing (eval's
        // oversized-upload path); not implemented for Gemini. Refusing beats
        // silently dropping the image and scoring a request the model never saw.
        throw new LlmTransportError(
          `evidence ${image.image_ref} arrived as a Files API id - not supported on the ` +
            'Gemini path, refusing to send a request the model cannot see',
        );
      }
      if (image.data_base64 === null) {
        throw new LlmTransportError(
          `evidence ${image.image_ref} has no bytes - refusing to send a live ` +
            'request the model cannot see',
        );
      }
      parts.push({ inlineData: { mimeType: image.media_type, data: image.data_base64 } });
    }
    parts.push({ text: request.user_text });

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: request.max_tokens,
      // This model thinks by default, which routinely pushes a real
      // multimodal call past L3's fixed timeout_ms (layers/L3-verifier,
      // shared/config/thresholds.json - both out of scope for this change).
      // Disabling it keeps the adapter within a budget this file does not
      // control, at the cost of the model's extended reasoning; the strict
      // schema check and the fail-safe REVIEW/timeout path are what actually
      // guarantee correctness either way.
      thinkingConfig: { thinkingBudget: 0 },
    };
    if (request.output_schema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(request.output_schema);
    }

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout_ms);
    let res: Response;
    try {
      res = await fetch(
        `${GEMINI_API_BASE}/models/${encodeURIComponent(this.model_version)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.#apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LlmTimeoutError(`live: no response within ${request.timeout_ms}ms`);
      }
      throw new LlmTransportError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }

    const parsed = (await res.json().catch(() => null)) as GeminiResponse | null;

    if (!res.ok) {
      const message = parsed?.error?.message ?? `${res.status} ${res.statusText}`;
      throw new LlmTransportError(`live: ${res.status} ${message}`);
    }
    if (!parsed) {
      throw new LlmTransportError('live: response was not JSON');
    }

    const candidate = parsed.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');

    return {
      text,
      model_version: this.model_version,
      input_tokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      latency_ms: Math.round(performance.now() - startedAt),
      stop_reason: candidate?.finishReason ?? null,
    };
  }
}

/**
 * The live verifier adapter. Gated on LLM_MODE=live rather than the global MODE,
 * so a live verifier run cannot pull payments, store or notifier live with it.
 * Provider is chosen by `llmProvider()` (LLM_PROVIDER=anthropic to opt back
 * into Claude; Gemini is the default).
 */
export function createLiveLlmAdapter(options: LiveLlmOptions): LlmAdapter {
  if (llmMode() !== 'live') {
    throw new Error('createLiveLlmAdapter requires LLM_MODE=live.');
  }

  if (llmProvider() === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        'LLM_MODE=live with the default Gemini provider requires GEMINI_API_KEY in the environment (.env).',
      );
    }
    // `options.model`/`options.effort` arrive shaped for Anthropic - existing,
    // unmodified callers (server.ts, eval/live_batch.ts) source them from
    // ANTHROPIC_MODEL/ANTHROPIC_EFFORT and pass them regardless of provider.
    // They do not apply to Gemini, so this branch ignores them and reads its
    // own GEMINI_MODEL instead; "effort" has no Gemini equivalent here.
    return new GeminiLlm({
      // gemini-3.5-flash rather than the fastest available model: the newest
      // flash tiers carry a free-tier cap of 20 requests/day, which a single
      // batch exhausts - after which every claim fail-safes to REVIEW and the
      // run measures the rate limiter instead of the verifier. Measured on a
      // real FraudBench image: 3.5-flash ~10s, 2.5-flash ~39s (past any sane
      // timeout), 3.8-flash ~6s but quota-capped.
      model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash',
      apiKey: process.env.GEMINI_API_KEY,
    });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY in the environment (.env).');
  }
  return new AnthropicLlm(options);
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
