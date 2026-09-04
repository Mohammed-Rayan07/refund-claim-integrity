/**
 * LLM adapter — Claude multimodal wrapper for the L3 Claim Verifier.
 *
 * NOT IMPLEMENTED IN CHUNK 1. Only the model-agnostic interface exists here so
 * that L3 can be written against it. No layer may call an LLM API directly.
 *
 * The verifier is the ONLY consumer of this adapter: all matching, arithmetic,
 * thresholds and routing elsewhere in RCIE are deterministic code.
 */
import { isMock } from '../mode.ts';

export interface LlmImageRef {
  /** Opaque reference to evidence the caller already holds. */
  image_ref: string;
  media_type: string;
  /** base64 payload, supplied by the caller. This adapter never creates images. */
  data_base64: string;
}

export interface LlmRequest {
  system: string;
  /** Claim text is passed as fenced data, never as instructions (F9, Chunk 2). */
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

export function createLlmAdapter(): LlmAdapter {
  if (isMock()) {
    // Chunk 2 builds the mock verifier responses. Until then the spine must not
    // pretend a verifier exists — callers fall back to REVIEW (fail-safe, F11).
    throw new Error('LLM adapter not implemented until Chunk 2 (L3 verifier).');
  }

  // TODO(LIVE): implement against the Anthropic Messages API (multimodal).
  // Requires .env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL
  throw new Error('TODO(LIVE): live llm adapter not implemented. Set MODE=mock.');
}
