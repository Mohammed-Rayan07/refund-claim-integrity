/**
 * FraudBench subset loader - CONSUME ONLY (SPEC §0).
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
 * the evaluation meaningless. When the dataset is absent the loader reports an
 * empty subset and the pipeline runs on synthetic business fixtures alone.
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
}

export interface FraudBenchSubset {
  present: boolean;
  path: string | null;
  samples: FraudBenchSample[];
  generators: string[];
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

/**
 * Reads `<dir>/manifest.json`, an array of FraudBenchSample records describing the
 * local subset. Malformed entries are dropped rather than guessed at.
 *
 * TODO(LIVE): point at a real local copy of the benchmark.
 * Requires .env: FRAUDBENCH_PATH (directory containing manifest.json + images)
 */
export function loadFraudBenchSubset(): FraudBenchSubset {
  const dir = process.env.FRAUDBENCH_PATH ?? DEFAULT_DIR;
  const manifestPath = resolve(process.cwd(), dir, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    return {
      present: false,
      path: null,
      samples: [],
      generators: [],
      note:
        `no FraudBench subset at ${dir}/${MANIFEST_FILENAME} - ` +
        'fetch the benchmark and set FRAUDBENCH_PATH (see eval/fraudbench/README.md)',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      present: false,
      path: manifestPath,
      samples: [],
      generators: [],
      note: `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      present: false,
      path: manifestPath,
      samples: [],
      generators: [],
      note: 'manifest must be a JSON array of samples',
    };
  }

  const samples = parsed.filter(isSample);
  const generators = [
    ...new Set(samples.flatMap((s) => (s.generator === null ? [] : [s.generator]))),
  ].sort();

  return {
    present: samples.length > 0,
    path: manifestPath,
    samples,
    generators,
    note:
      samples.length === parsed.length
        ? `${samples.length} samples across ${generators.length} generators`
        : `${samples.length} of ${parsed.length} manifest entries were well-formed`,
  };
}
