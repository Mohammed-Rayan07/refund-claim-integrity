/**
 * FraudBench subset loader - CONSUME ONLY (SPEC section 0).
 *
 * FraudBench (HuggingFace `TristanYan/FraudBench`, arXiv 2605.08820, NTU + Alibaba)
 * is a publicly released benchmark for research on DETECTION. This module reads a
 * locally provided subset manifest and attaches its sample references to claims so
 * the pipeline can be measured against them.
 *
 * It reads. It never writes, generates, edits, augments or derives a sample.
 * There is deliberately no code path here that produces evidence of any kind.
 *
 * No manifest is checked into this repo: fabricating benchmark entries would make
 * the evaluation meaningless, and the benchmark is NonCommercial-ShareAlike
 * licensed. Run `npm run fetch:fraudbench` to populate it. When the dataset is
 * absent the loader reports an empty subset and the pipeline runs on synthetic
 * business fixtures alone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FraudBenchSample {
  /** Benchmark-assigned sample id. */
  sample_id: string;
  /** Path or URI of the image within the local dataset copy. */
  image_ref: string;
  /** Ground-truth label as published by the benchmark. */
  label: 'authentic' | 'synthetic';
  /** Generator that produced a synthetic sample; used for the F10 holdout split. */
  generator: string | null;

  // --- optional context, present when the manifest came from fetch.ts ---
  /** FraudBench category, verbatim. */
  category?: string;
  /** RCIE product category, for the merchant policy ceiling. */
  rcie_category?: string;
  /** `<Category>/<Split>/<Review_NNN>` - the benchmark unit this came from. */
  source_review?: string;
  product_title?: string;
  price_usd?: number | null;
  /** Text the benchmark published alongside the sample. Never written by us. */
  published_text?: string;
  /** Damage type the benchmark's edit targeted, for synthetic samples. */
  damage_type?: string | null;
  rating?: number | null;
  sha256?: string;
  bytes?: number;
}

/** Merchant product photography referenced by the benchmark's product metadata. */
export interface FraudBenchCatalogueImage {
  catalogue_ref: string;
  image_ref: string;
  product_title: string;
  source_review: string;
  sha256?: string;
  bytes?: number;
}

export interface FraudBenchSubset {
  present: boolean;
  path: string | null;
  samples: FraudBenchSample[];
  generators: string[];
  catalogue: FraudBenchCatalogueImage[];
  /** Upstream dataset revision, recorded so a run can be replayed (F13). */
  dataset: string | null;
  dataset_sha: string | null;
  fetched_at: string | null;
  /** Why the subset is empty, when it is. */
  note: string;
}

const MANIFEST_FILENAME = 'manifest.json';
const DEFAULT_DIR = 'eval/fraudbench';

function isSample(value: unknown): value is FraudBenchSample {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o['sample_id'] === 'string' &&
    typeof o['image_ref'] === 'string' &&
    (o['label'] === 'authentic' || o['label'] === 'synthetic') &&
    (o['generator'] === null || typeof o['generator'] === 'string')
  );
}

function isCatalogueImage(value: unknown): value is FraudBenchCatalogueImage {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o['catalogue_ref'] === 'string' &&
    typeof o['image_ref'] === 'string' &&
    typeof o['product_title'] === 'string'
  );
}

function empty(path: string | null, note: string): FraudBenchSubset {
  return {
    present: false,
    path,
    samples: [],
    generators: [],
    catalogue: [],
    dataset: null,
    dataset_sha: null,
    fetched_at: null,
    note,
  };
}

/**
 * Reads `<dir>/manifest.json`. Two shapes are accepted: the object written by
 * `fetch.ts` (`{ dataset_sha, samples, catalogue, ... }`), and a bare JSON array
 * of samples for a hand-assembled local copy. Malformed entries are dropped
 * rather than guessed at.
 *
 * Set FRAUDBENCH_PATH to point at a copy outside the repo.
 */
export function loadFraudBenchSubset(): FraudBenchSubset {
  const dir = process.env.FRAUDBENCH_PATH ?? DEFAULT_DIR;
  const manifestPath = resolve(process.cwd(), dir, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    return empty(
      null,
      `no FraudBench subset at ${dir}/${MANIFEST_FILENAME} - ` +
        'run `npm run fetch:fraudbench` (see eval/fraudbench/README.md)',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return empty(
      manifestPath,
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let rawSamples: unknown[];
  let rawCatalogue: unknown[] = [];
  let dataset: string | null = null;
  let dataset_sha: string | null = null;
  let fetched_at: string | null = null;

  if (Array.isArray(parsed)) {
    rawSamples = parsed;
  } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['samples'])) {
    const o = parsed as Record<string, unknown>;
    rawSamples = o['samples'] as unknown[];
    rawCatalogue = Array.isArray(o['catalogue']) ? (o['catalogue'] as unknown[]) : [];
    dataset = typeof o['dataset'] === 'string' ? o['dataset'] : null;
    dataset_sha = typeof o['dataset_sha'] === 'string' ? o['dataset_sha'] : null;
    fetched_at = typeof o['fetched_at'] === 'string' ? o['fetched_at'] : null;
  } else {
    return empty(manifestPath, 'manifest must be a JSON array of samples, or an object with a `samples` array');
  }

  const samples = rawSamples.filter(isSample);
  const catalogue = rawCatalogue.filter(isCatalogueImage);
  const generators = [
    ...new Set(samples.flatMap((s) => (s.generator === null ? [] : [s.generator]))),
  ].sort();

  return {
    present: samples.length > 0,
    path: manifestPath,
    samples,
    generators,
    catalogue,
    dataset,
    dataset_sha,
    fetched_at,
    note:
      samples.length === rawSamples.length
        ? `${samples.length} samples across ${generators.length} generators` +
          (dataset_sha ? ` (dataset sha ${dataset_sha.slice(0, 12)})` : '')
        : `${samples.length} of ${rawSamples.length} manifest entries were well-formed`,
  };
}
