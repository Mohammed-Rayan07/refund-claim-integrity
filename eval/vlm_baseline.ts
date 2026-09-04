/**
 * B2 - the VLM-only baseline, run for real.
 *
 * This is the common approach SPEC section 1 argues against: point a multimodal
 * model at the photograph and ask whether it is AI-generated. It sees the image
 * and nothing else - no order, no SKU, no claim text, no customer history -
 * because that is precisely the architecture being compared against. It is not a
 * strawman: it is given the same image, the same model and the same effort as
 * the claim-conditioned verifier, and its prompt is the strongest honest
 * statement of the question it is being asked.
 *
 * A "fake" verdict is treated as a flag. Anything else is a release.
 *
 * SPEC section 0: this module sends images and reads text. It produces nothing.
 */
import type { EvidenceAdapter } from '../shared/adapters/evidence.ts';
import type { LlmAdapter, LlmImageRef } from '../shared/adapters/llm.ts';

export const VLM_PROMPT_VERSION = 'b2-vlm-only-v1';

export const VLM_SYSTEM =
  'You are an image forensics classifier. Return only the requested JSON.';

export const VLM_PROMPT = `Assess whether this product photograph has been generated or edited by an AI image model.

This is the question a fraud team most often asks of a refund photo. Answer it as
well as it can be answered from the image alone.

Consider generation and editing artefacts: implausible lighting or shadows,
inconsistent reflections, texture or edge artefacts around damaged regions,
geometry that does not hold together, text or logos that do not resolve.

Return ONLY this JSON:
{
  "assessment": "ai_generated|authentic|uncertain",
  "confidence": 0.0-1.0,
  "reasoning": "..."
}`;

const VLM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    assessment: { type: 'string', enum: ['ai_generated', 'authentic', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' },
  },
  required: ['assessment', 'confidence', 'reasoning'],
  additionalProperties: false,
};

export interface VlmVerdict {
  claim_id: string;
  image_ref: string;
  assessment: 'ai_generated' | 'authentic' | 'uncertain' | 'failed';
  confidence: number | null;
  reasoning: string;
  model_version: string | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  /** True when the model was sent actual image bytes. */
  saw_image: boolean;
}

export interface VlmDeps {
  llm: LlmAdapter;
  evidence_bytes: EvidenceAdapter;
  uploaded: Map<string, string>;
  timeout_ms: number;
}

export async function runVlmBaseline(
  claim_id: string,
  image_ref: string,
  deps: VlmDeps,
): Promise<VlmVerdict> {
  const startedAt = performance.now();
  const base = {
    claim_id,
    image_ref,
    model_version: null as string | null,
    input_tokens: 0,
    output_tokens: 0,
  };

  let image: LlmImageRef;
  try {
    const file_id = deps.uploaded.get(image_ref) ?? null;
    if (file_id) {
      image = { image_ref, media_type: 'image/jpeg', data_base64: null, file_id };
    } else {
      const loaded = deps.evidence_bytes.load(image_ref);
      image = {
        image_ref,
        media_type: loaded.media_type,
        data_base64: loaded.data_base64,
      };
    }
  } catch (err) {
    return {
      ...base,
      assessment: 'failed',
      confidence: null,
      reasoning: `evidence unreadable: ${err instanceof Error ? err.message : String(err)}`,
      latency_ms: Math.round(performance.now() - startedAt),
      saw_image: false,
    };
  }

  try {
    const response = await deps.llm.complete({
      correlation_id: `${claim_id}#b2`,
      system: VLM_SYSTEM,
      user_text: VLM_PROMPT,
      images: [image],
      max_tokens: 512,
      timeout_ms: deps.timeout_ms,
      output_schema: VLM_SCHEMA,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return {
        ...base,
        model_version: response.model_version,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        assessment: 'failed',
        confidence: null,
        reasoning: `unparseable response: ${response.text.slice(0, 120)}`,
        latency_ms: Math.round(performance.now() - startedAt),
        saw_image: true,
      };
    }

    const o = parsed as Record<string, unknown>;
    const assessment = o['assessment'];
    const valid =
      assessment === 'ai_generated' || assessment === 'authentic' || assessment === 'uncertain';

    return {
      ...base,
      model_version: response.model_version,
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      assessment: valid ? assessment : 'failed',
      confidence: typeof o['confidence'] === 'number' ? o['confidence'] : null,
      reasoning: typeof o['reasoning'] === 'string' ? o['reasoning'] : '',
      latency_ms: Math.round(performance.now() - startedAt),
      saw_image: true,
    };
  } catch (err) {
    return {
      ...base,
      assessment: 'failed',
      confidence: null,
      reasoning: err instanceof Error ? err.message : String(err),
      latency_ms: Math.round(performance.now() - startedAt),
      saw_image: true,
    };
  }
}
