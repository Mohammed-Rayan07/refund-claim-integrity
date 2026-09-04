/**
 * L2 - Evidence Reuse Detection (SPEC §3 F3).
 *
 * Hashes this claim's evidence and compares it against three sources:
 *
 *   1. customer_history   - images this customer submitted on earlier claims
 *   2. merchant_catalogue - the merchant's own product photography, which catches
 *                           a stock image being passed off as damage evidence
 *   3. shared_index       - a cross-merchant index that holds HASHES ONLY.
 *
 * The shared index is the design decision worth stating plainly: merchants get
 * collective defense against an image reused across storefronts without any
 * merchant ever sharing a customer's photograph. A perceptual hash cannot be
 * inverted into an image, so the index carries no evidence, only fingerprints.
 * The type below has no field capable of holding image data.
 *
 * No model is involved. This is arithmetic over hashes.
 */
import { randomUUID } from 'node:crypto';
import { mockHashFromRef, similarity } from '../../shared/lib/phash.ts';
import type { LoadedConfig } from '../../shared/config/index.ts';
import type { StoreAdapter } from '../../shared/adapters/store.ts';
import type { AuditLogger } from '../../shared/lib/logger.ts';
import type { Claim, Evidence, ReuseSource } from '../../shared/types.ts';

/** Merchant product photography. A reference plus its hash - no image bytes. */
export interface CatalogueImage {
  sku: string;
  image_ref: string;
  phash: string;
}

/**
 * One entry in the cross-merchant index. Deliberately carries no image_ref and
 * no image data: a hash, which merchant contributed it, and when.
 */
export interface SharedIndexEntry {
  phash: string;
  contributed_by_merchant: string;
  first_seen_at: string;
}

export interface ReuseMatch {
  source: ReuseSource;
  similarity: number;
  /** Claim id, catalogue ref, or the shared-index fingerprint that matched. */
  matched_ref: string;
  claim_image_ref: string;
}

export interface ReuseResult {
  /** Highest similarity found across every source, 0 when nothing was compared. */
  max_similarity: number;
  best: ReuseMatch | null;
  matches: ReuseMatch[];
  hashed_count: number;
}

export interface ReuseDeps {
  store: StoreAdapter;
  config: LoadedConfig;
  audit: AuditLogger;
  catalogue: CatalogueImage[];
  shared_index: SharedIndexEntry[];
}

/**
 * Hash of a piece of evidence, using the stored hash when one exists.
 *
 * TODO(LIVE): compute dHash from the decoded evidence bytes instead.
 * Requires .env: DATABASE_URL
 */
function hashOf(evidence: Evidence): string {
  return evidence.phash ?? mockHashFromRef(evidence.image_ref);
}

export async function runReuseDetection(
  claim: Claim,
  evidence: Evidence[],
  deps: ReuseDeps,
): Promise<ReuseResult> {
  const { store, config, audit } = deps;
  const cut = config.thresholds.decision.reuse_cut;

  const claimHashes = evidence.map((e) => ({ ref: e.image_ref, hash: hashOf(e) }));
  const matches: ReuseMatch[] = [];

  const consider = (
    source: ReuseSource,
    matched_ref: string,
    claim_image_ref: string,
    score: number,
  ): void => {
    if (score > cut) {
      matches.push({ source, similarity: score, matched_ref, claim_image_ref });
    }
  };

  // 1. This customer's prior claims.
  const priorClaims = await store.listPriorClaimsByCustomer(claim.customer_id, claim.submitted_at);
  for (const prior of priorClaims) {
    const priorEvidence = await store.listEvidenceForClaim(prior.id);
    for (const pe of priorEvidence) {
      const priorHash = hashOf(pe);
      for (const current of claimHashes) {
        consider('customer_history', prior.id, current.ref, similarity(current.hash, priorHash));
      }
    }
  }

  // 2. The merchant's own catalogue imagery (stock-photo submission).
  for (const item of deps.catalogue) {
    for (const current of claimHashes) {
      consider('merchant_catalogue', item.image_ref, current.ref, similarity(current.hash, item.phash));
    }
  }

  // 3. Cross-merchant shared index - hashes only.
  for (const entry of deps.shared_index) {
    for (const current of claimHashes) {
      consider(
        'shared_index',
        `${entry.contributed_by_merchant}:${entry.phash}`,
        current.ref,
        similarity(current.hash, entry.phash),
      );
    }
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  const best = matches[0] ?? null;
  const result: ReuseResult = {
    max_similarity: best?.similarity ?? 0,
    best,
    matches,
    hashed_count: claimHashes.length,
  };

  for (const match of matches) {
    await store.saveReuseHit({
      id: `RH_${randomUUID()}`,
      claim_id: claim.id,
      matched_claim_id: match.source === 'customer_history' ? match.matched_ref : null,
      catalogue_ref: match.source === 'customer_history' ? null : match.matched_ref,
      similarity: match.similarity,
      source: match.source,
    });
  }

  audit.record(
    claim.id,
    'L2',
    best ? 'evidence_reuse_detected' : 'no_evidence_reuse',
    { claim_id: claim.id, hashes: claimHashes.map((h) => h.hash) },
    {
      hashed_count: result.hashed_count,
      reuse_cut: cut,
      max_similarity: result.max_similarity,
      match_count: matches.length,
      best_source: best?.source ?? null,
      best_matched_ref: best?.matched_ref ?? null,
      // Recorded so the trail never implies pixels were compared when they were not.
      hash_mode: evidence.every((e) => e.phash === null) ? 'mock_ref_hash' : 'perceptual',
    },
  );

  return result;
}
