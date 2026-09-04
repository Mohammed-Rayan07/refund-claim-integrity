/**
 * Evidence adapter - resolves an `image_ref` to the bytes the verifier needs and
 * to a real perceptual hash.
 *
 * SPEC section 0. This module READS image files and DECODES them to pixels. It
 * has no encoder, no writer and no transform: there is no function here that can
 * produce an image file, alter one, or write pixels back to disk. Decoding is
 * one-way, and a dHash cannot be inverted into a picture.
 *
 * Two consumers:
 *  - L3 needs base64 bytes so the model assesses the actual photograph rather
 *    than a filename, and needs the media type to be right. Roughly half the
 *    FraudBench generator outputs are PNG data stored under a `.jpg` name, so
 *    the type is sniffed from magic bytes; trusting the extension would mean
 *    labelling a PNG as JPEG on the wire.
 *  - L2 needs a dHash computed from real pixels, not from the reference string.
 *    `mockHashFromRef` is deliberately NOT reachable from here: a mock hash
 *    inside a run labelled live would be a fabricated measurement.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { dHash } from '../lib/phash.ts';
import { decodeToGrayscale, sniffMediaType } from '../lib/imagedecode.ts';

export interface EvidenceBytes {
  image_ref: string;
  /** Sniffed from the file's magic bytes, never from its extension. */
  media_type: string;
  data_base64: string;
  bytes: number;
}

export interface EvidenceAdapter {
  readonly kind: 'local_files';
  /** Throws rather than returning a placeholder when the file cannot be read. */
  load(image_ref: string): EvidenceBytes;
  /** Real dHash over decoded luminance. Throws if the image cannot be decoded. */
  phash(image_ref: string): string;
  /** File size without reading the whole file into memory. */
  size(image_ref: string): number;
}

class LocalFileEvidence implements EvidenceAdapter {
  readonly kind = 'local_files' as const;
  #hashes = new Map<string, string>();

  load(image_ref: string): EvidenceBytes {
    const buf = readFileSync(resolve(process.cwd(), image_ref));
    const media_type = sniffMediaType(buf);
    if (!media_type) {
      throw new Error(`unrecognised image format for ${image_ref}`);
    }
    return {
      image_ref,
      media_type,
      data_base64: buf.toString('base64'),
      bytes: buf.length,
    };
  }

  size(image_ref: string): number {
    return statSync(resolve(process.cwd(), image_ref)).size;
  }

  phash(image_ref: string): string {
    const cached = this.#hashes.get(image_ref);
    if (cached) return cached;
    // Deliberately loud on failure. A silent fallback to a reference-derived
    // hash would report a reuse measurement that never looked at a pixel.
    const buf = readFileSync(resolve(process.cwd(), image_ref));
    const hash = dHash(decodeToGrayscale(buf, image_ref));
    this.#hashes.set(image_ref, hash);
    return hash;
  }
}

/**
 * Evidence stored as local files - the shape the FraudBench subset takes.
 *
 * TODO(LIVE): a merchant deployment addresses evidence blobs by `image_ref` in
 * object storage rather than on local disk.
 * Requires .env: DATABASE_URL
 */
export function createLocalFileEvidenceAdapter(): EvidenceAdapter {
  return new LocalFileEvidence();
}
