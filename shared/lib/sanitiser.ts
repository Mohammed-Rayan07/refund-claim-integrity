/**
 * F9 - Prompt-injection defense (SPEC §3 F9, §7 L3 prompt).
 *
 * Claim text is attacker-controlled and flows into a multimodal model. This
 * module treats it as hostile input:
 *   - the text is escaped so it cannot close or forge the <user_claim_text> fence
 *   - it is returned as a fenced DATA block, never concatenated into instructions
 *   - instruction-shaped content is detected deterministically and flagged
 *
 * Detection is pure regex over the claim text. No model is involved: an injection
 * attempt must be catchable before we ever pay for a model call.
 */

export const FENCE_OPEN = '<user_claim_text>';
export const FENCE_CLOSE = '</user_claim_text>';

export interface InjectionSignal {
  id: string;
  /** The matched span, truncated, so the audit trail shows what tripped it. */
  matched: string;
}

export interface SanitisedClaimText {
  /** Escaped, fence-safe text. This is what the prompt embeds. */
  safe_text: string;
  /** The complete fenced data block, ready to drop into the prompt. */
  fenced_block: string;
  injection_suspected: boolean;
  signals: InjectionSignal[];
  /** True when escaping actually changed the text (fence-breakout attempt). */
  escaped: boolean;
}

interface Pattern {
  id: string;
  re: RegExp;
}

/**
 * Instruction-shaped content. Ordinary damage descriptions do not contain these:
 * a customer says "the casing is cracked", not "ignore previous instructions".
 */
const PATTERNS: Pattern[] = [
  { id: 'IGNORE_PRIOR_INSTRUCTIONS', re: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier|the\s+above)\s+(?:instructions?|prompts?|rules?|context)/i },
  { id: 'DISREGARD_DIRECTIVE', re: /disregard\s+(?:the\s+)?(?:above|previous|prior|system|earlier)/i },
  { id: 'ROLE_REASSIGNMENT', re: /\byou\s+are\s+now\b|\bact\s+as\s+(?:a|an|the)\b|\bpretend\s+(?:to\s+be|you)\b/i },
  { id: 'SYSTEM_ROLE_SPOOF', re: /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i },
  { id: 'NEW_INSTRUCTIONS', re: /\bnew\s+instructions?\b|\bupdated\s+instructions?\b/i },
  { id: 'FENCE_BREAKOUT', re: /<\s*\/?\s*user_claim_text\s*>/i },
  { id: 'SCHEMA_FORGERY', re: /"?\b(?:supports_claim|injection_suspected|internal_consistency)\b"?\s*:/i },
  { id: 'OUTPUT_HIJACK', re: /\breturn\s+only\s+this\s+json\b|\brespond\s+with\s+(?:only\s+)?json\b|\boutput\s+the\s+following\b/i },
  { id: 'DECISION_COERCION', re: /\b(?:auto[-\s]?)?approve\s+(?:this\s+|the\s+|my\s+)?(?:refund|claim|request)\b|\bmark\s+(?:this|it)\s+as\s+approved\b/i },
  { id: 'CONTROL_OVERRIDE', re: /\boverride\b[^.\n]{0,40}\b(?:policy|policies|decision|threshold|check|rule)s?\b/i },
  { id: 'SUPPRESS_REVIEW', re: /\bdo\s+not\s+(?:flag|review|deny|escalate|question)\b|\bskip\s+(?:the\s+)?(?:review|verification|checks?)\b/i },
  { id: 'CONFIDENCE_COERCION', re: /\b(?:set|report)\s+confidence\s+(?:to|as)\b|\bhigh(?:est)?\s+confidence\b\s*[:=]/i },
];

const MAX_SIGNAL_SPAN = 80;

/** Escapes angle brackets so user text can never open or close a prompt fence. */
function escapeFence(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sanitiseClaimText(rawText: string): SanitisedClaimText {
  const signals: InjectionSignal[] = [];

  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(rawText);
    if (match) {
      signals.push({ id: pattern.id, matched: match[0].slice(0, MAX_SIGNAL_SPAN).trim() });
    }
  }

  const safe_text = escapeFence(rawText);

  return {
    safe_text,
    fenced_block: `${FENCE_OPEN}\n${safe_text}\n${FENCE_CLOSE}`,
    injection_suspected: signals.length > 0,
    signals,
    escaped: safe_text !== rawText,
  };
}
