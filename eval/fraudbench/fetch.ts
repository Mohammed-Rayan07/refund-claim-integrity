/**
 * npm run fetch:fraudbench
 *
 * Downloads a stratified subset of the publicly released FraudBench benchmark
 * (HuggingFace `TristanYan/FraudBench`, arXiv 2605.08820, NTU + Alibaba,
 * CC-BY-NC-SA-4.0) into `eval/fraudbench/data/` and writes `manifest.json`.
 *
 * SPEC section 0 - CONSUME ONLY. This module performs exactly two operations on
 * evidence: an HTTP GET, and a byte-for-byte write of the response to disk.
 * There is no decoder, no encoder, no resize, no re-compression, no compositing
 * and no model call anywhere in this file. It cannot produce or alter a sample;
 * it can only place a published one on the local filesystem. Product catalogue
 * photography is fetched from the URLs the benchmark's own metadata carries.
 *
 * The downloaded data and the manifest are gitignored: the benchmark is
 * NonCommercial-ShareAlike licensed and is not ours to redistribute.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO = 'TristanYan/FraudBench';
const API = `https://huggingface.co/api/datasets/${REPO}`;
const DATA_DIR = 'eval/fraudbench/data';
const MANIFEST = 'eval/fraudbench/manifest.json';

/**
 * Six physical-goods categories. Services categories (Hotels, Delivery) are
 * excluded: a shipping-damage refund claim has no meaning there. The six map
 * onto the merchant policy's category overrides.
 */
const CATEGORIES: Array<{ fb: string; rcie: string }> = [
  { fb: 'Electronics', rcie: 'electronics' },
  { fb: 'Cell Phones & Accessories', rcie: 'electronics' },
  { fb: 'Clothing, Shoes & Jewelry', rcie: 'apparel' },
  { fb: 'Home & Kitchen', rcie: 'home' },
  { fb: 'Grocery & Gourmet Food', rcie: 'grocery' },
  { fb: 'Toys & Games', rcie: 'home' },
];

/** Deepfake source reviews taken per category, and genuine-damage reviews. */
const DEEPFAKE_SOURCES_PER_CATEGORY = 2;
const GENUINE_DAMAGE_PER_CATEGORY = 3;

interface HfSibling {
  rfilename: string;
}
interface HfMeta {
  sha: string;
  lastModified: string;
  siblings: HfSibling[];
}

function urlFor(sha: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/datasets/${REPO}/resolve/${sha}/${encoded}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Byte-for-byte write of a GET response. Skips files already present. */
async function download(url: string, destRel: string): Promise<{ bytes: number; sha256: string }> {
  const dest = resolve(process.cwd(), destRel);
  if (existsSync(dest) && statSync(dest).size > 0) {
    const existing = readFileSync(dest);
    return { bytes: existing.length, sha256: createHash('sha256').update(existing).digest('hex') };
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

// --------------------------------------------------------------------------
// Benchmark record shapes (as published)
// --------------------------------------------------------------------------

interface ProductMeta {
  main_category: string;
  title: string;
  price: number | null;
  images: Array<{
    thumb: string | null;
    large: string | null;
    hi_res: string | null;
    variant: string;
  }>;
  store: string;
}
interface MetaReview {
  rating: number;
  title: string;
  text: string;
  asin: string;
  date: string;
  image_files: string[];
  product_meta: ProductMeta;
}
interface EditPerImage {
  image: string;
  damage: string;
  target_part: string;
  reviewer_comment: string;
  outputs: Record<string, { status: string; path: string }>;
}
interface EditMeta {
  category: string;
  source_review: string;
  product_name: string;
  main_category: string;
  per_image: EditPerImage[];
}

// --------------------------------------------------------------------------
// Manifest shape consumed by loader.ts
// --------------------------------------------------------------------------

export interface ManifestSample {
  sample_id: string;
  image_ref: string;
  label: 'authentic' | 'synthetic';
  generator: string | null;
  /** FraudBench category, verbatim. */
  category: string;
  /** RCIE product category, for the merchant policy ceiling. */
  rcie_category: string;
  /** `<Category>/<Split>/<Review_NNN>` - the benchmark unit this came from. */
  source_review: string;
  product_title: string;
  /** Benchmark-published list price in USD, when the record carries one. */
  price_usd: number | null;
  /**
   * Text published alongside the sample. For an authentic negative review it is
   * the reviewer's own words; for a synthetic sample it is the `reviewer_comment`
   * the benchmark published with the edit. Never written by this repo.
   */
  published_text: string;
  /** Damage type the benchmark's edit targeted, for synthetic samples. */
  damage_type: string | null;
  /** Review rating (1-5) for authentic samples. */
  rating: number | null;
  sha256: string;
  bytes: number;
}

export interface ManifestCatalogueImage {
  catalogue_ref: string;
  image_ref: string;
  product_title: string;
  source_review: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  dataset: string;
  dataset_sha: string;
  arxiv: string;
  license: string;
  fetched_at: string;
  note: string;
  samples: ManifestSample[];
  /** Merchant product photography, for L2 stock-image detection. */
  catalogue: ManifestCatalogueImage[];
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Fetching FraudBench subset from ${REPO} ...`);
  const meta = await getJson<HfMeta>(API);
  console.log(`  dataset sha ${meta.sha} (last modified ${meta.lastModified})`);

  const files = meta.siblings.map((s) => s.rfilename);
  const has = new Set(files);

  const samples: ManifestSample[] = [];
  const catalogue: ManifestCatalogueImage[] = [];
  const seenCatalogue = new Set<string>();
  let downloaded = 0;

  for (const { fb, rcie } of CATEGORIES) {
    console.log(`\n[${fb}]`);
    const slug = fb.replace(/\W+/g, '');

    const reviewIds = (split: string): string[] => [
      ...new Set(
        files.filter((f) => f.startsWith(`${fb}/${split}/Review_`)).map((f) => f.split('/')[2]!),
      ),
    ].sort();

    const generators = [
      ...new Set(
        files
          .filter(
            (f) => f.startsWith(`${fb}/DeepFake/`) && !f.startsWith(`${fb}/DeepFake/Metadata/`),
          )
          .map((f) => f.split('/')[2]!),
      ),
    ].sort();

    // ---- A. genuine damage: real 1-2 star reviews with real photos ----
    let taken = 0;
    for (const review of reviewIds('Negative')) {
      if (taken >= GENUINE_DAMAGE_PER_CATEGORY) break;
      const n = review.replace('Review_', '');
      const metaPath = `${fb}/Negative/${review}/MetaReview_${n}.json`;
      if (!has.has(metaPath)) continue;
      const mr = await getJson<MetaReview>(urlFor(meta.sha, metaPath));
      const first = mr.image_files[0];
      if (!first) continue;
      const imgPath = `${fb}/Negative/${review}/${first}`;
      if (!has.has(imgPath)) continue;

      const rel = `${DATA_DIR}/${imgPath}`;
      const { bytes, sha256 } = await download(urlFor(meta.sha, imgPath), rel);
      downloaded += 1;
      samples.push({
        sample_id: `AUTH_NEG_${slug}_${n}`,
        image_ref: rel,
        label: 'authentic',
        generator: null,
        category: fb,
        rcie_category: rcie,
        source_review: `${fb}/Negative/${review}`,
        product_title: mr.product_meta.title,
        price_usd: mr.product_meta.price,
        published_text: mr.text,
        damage_type: null,
        rating: mr.rating,
        sha256,
        bytes,
      });
      taken += 1;
      console.log(`  authentic damage  ${review}  ${mr.product_meta.title.slice(0, 52)}`);
    }

    // ---- B/E. deepfake sources: the pristine original + each generator edit ----
    let sources = 0;
    for (const review of reviewIds('Positive')) {
      if (sources >= DEEPFAKE_SOURCES_PER_CATEGORY) break;
      const n = review.replace('Review_', '');
      const editPath = `${fb}/DeepFake/Metadata/Edit_${n}.json`;
      const metaPath = `${fb}/Positive/${review}/MetaReview_${n}.json`;
      if (!has.has(editPath) || !has.has(metaPath)) continue;

      const edit = await getJson<EditMeta>(urlFor(meta.sha, editPath));
      const mr = await getJson<MetaReview>(urlFor(meta.sha, metaPath));
      const per = edit.per_image[0];
      if (!per) continue;

      const okGenerators = generators.filter(
        (g) =>
          per.outputs[g]?.status === 'ok' &&
          has.has(`${fb}/DeepFake/${g}/${review}/${per.image}`),
      );
      if (okGenerators.length === 0) continue;

      // The unedited source photograph. Its pairing with the benchmark's own
      // fabricated complaint is the controlled counterpart to the edited samples.
      const srcPath = `${fb}/Positive/${review}/${per.image}`;
      if (has.has(srcPath)) {
        const rel = `${DATA_DIR}/${srcPath}`;
        const { bytes, sha256 } = await download(urlFor(meta.sha, srcPath), rel);
        downloaded += 1;
        samples.push({
          sample_id: `AUTH_POS_${slug}_${n}`,
          image_ref: rel,
          label: 'authentic',
          generator: null,
          category: fb,
          rcie_category: rcie,
          source_review: `${fb}/Positive/${review}`,
          product_title: mr.product_meta.title,
          price_usd: mr.product_meta.price,
          published_text: per.reviewer_comment,
          damage_type: per.damage,
          rating: mr.rating,
          sha256,
          bytes,
        });
      }

      for (const g of okGenerators) {
        const genPath = `${fb}/DeepFake/${g}/${review}/${per.image}`;
        const rel = `${DATA_DIR}/${genPath}`;
        const { bytes, sha256 } = await download(urlFor(meta.sha, genPath), rel);
        downloaded += 1;
        samples.push({
          sample_id: `FAKE_${g}_${slug}_${n}`,
          image_ref: rel,
          label: 'synthetic',
          generator: g,
          category: fb,
          rcie_category: rcie,
          source_review: `${fb}/Positive/${review}`,
          product_title: mr.product_meta.title,
          price_usd: mr.product_meta.price,
          published_text: per.reviewer_comment,
          damage_type: per.damage,
          rating: null,
          sha256,
          bytes,
        });
      }
      console.log(
        `  deepfake source   ${review}  ${okGenerators.length} generators  ${edit.product_name.slice(0, 40)}`,
      );

      // ---- D. merchant catalogue photography for this product ----
      const catUrl =
        mr.product_meta.images.find((i) => i.hi_res)?.hi_res ??
        mr.product_meta.images.find((i) => i.large)?.large;
      if (catUrl && !seenCatalogue.has(catUrl)) {
        seenCatalogue.add(catUrl);
        const rel = `${DATA_DIR}/${fb}/Catalogue/${review}_${mr.asin}.jpg`;
        try {
          const { bytes, sha256 } = await download(catUrl, rel);
          downloaded += 1;
          catalogue.push({
            catalogue_ref: `CAT_${mr.asin}`,
            image_ref: rel,
            product_title: mr.product_meta.title,
            source_review: `${fb}/Positive/${review}`,
            sha256,
            bytes,
          });
        } catch (err) {
          console.log(
            `  (catalogue image unavailable: ${err instanceof Error ? err.message : err})`,
          );
        }
      }

      sources += 1;
    }
  }

  const manifest: Manifest = {
    dataset: REPO,
    dataset_sha: meta.sha,
    arxiv: '2605.08820',
    license: 'cc-by-nc-sa-4.0',
    fetched_at: new Date().toISOString(),
    note:
      'Stratified subset, consumed verbatim. Every file here was written byte-for-byte ' +
      'from an HTTP GET; nothing in this repository generates, edits or augments a sample.',
    samples,
    catalogue,
  };

  writeFileSync(resolve(process.cwd(), MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const byLabel = { authentic: 0, synthetic: 0 };
  for (const s of samples) byLabel[s.label] += 1;
  const gens = [...new Set(samples.flatMap((s) => (s.generator ? [s.generator] : [])))].sort();

  console.log(`\n${downloaded} files on disk under ${DATA_DIR}/`);
  console.log(
    `${samples.length} samples (${byLabel.authentic} authentic, ${byLabel.synthetic} synthetic) ` +
      `across ${gens.length} generators: ${gens.join(', ')}`,
  );
  console.log(`${catalogue.length} merchant catalogue images`);
  console.log(`manifest -> ${MANIFEST}  (dataset sha ${meta.sha})`);
}

await main();
