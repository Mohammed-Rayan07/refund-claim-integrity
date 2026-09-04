/**
 * F3 - Perceptual hashing for evidence reuse detection (SPEC §3 F3).
 *
 * `dHash` is the real thing: a 64-bit difference hash over a grayscale matrix,
 * robust to re-encoding, mild rescaling and small brightness shifts, which is
 * exactly how a resubmitted image usually differs from its original.
 *
 * This module only ever READS pixel values. It has no capability to produce,
 * alter or reconstruct an image, and a hash cannot be inverted back into one -
 * which is what makes the cross-merchant shared index privacy-preserving.
 */
import { createHash } from 'node:crypto';

/** dHash compares 9 columns across 8 rows, yielding 64 bits. */
const HASH_W = 9;
const HASH_H = 8;
export const HASH_BITS = (HASH_W - 1) * HASH_H;

export interface GrayscaleImage {
  width: number;
  height: number;
  /** Row-major luminance values, 0-255, length = width * height. */
  pixels: Uint8Array;
}

/** Nearest-neighbour downsample. Cheap and sufficient at 9x8. */
function downsample(image: GrayscaleImage): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < HASH_H; y += 1) {
    const srcY = Math.min(image.height - 1, Math.floor((y * image.height) / HASH_H));
    const row: number[] = [];
    for (let x = 0; x < HASH_W; x += 1) {
      const srcX = Math.min(image.width - 1, Math.floor((x * image.width) / HASH_W));
      row.push(image.pixels[srcY * image.width + srcX] ?? 0);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 64-bit difference hash, returned as 16 lowercase hex characters.
 * Bit i is 1 when a pixel is brighter than the one to its right.
 */
export function dHash(image: GrayscaleImage): string {
  if (image.width < 1 || image.height < 1) {
    throw new Error('dHash requires a non-empty image');
  }
  const grid = downsample(image);
  const bits: number[] = [];
  for (const row of grid) {
    for (let x = 0; x < HASH_W - 1; x += 1) {
      bits.push((row[x] ?? 0) > (row[x + 1] ?? 0) ? 1 : 0);
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!;
    hex += nibble.toString(16);
  }
  return hex;
}

const HEX_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Number of differing bits between two hashes of equal length. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`hash length mismatch: ${a.length} vs ${b.length}`);
  }
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    distance += HEX_POPCOUNT[xor]!;
  }
  return distance;
}

/** 1.0 = identical, 0.0 = every bit differs. */
export function similarity(a: string, b: string): number {
  return 1 - hammingDistance(a, b) / (a.length * 4);
}

/**
 * MODE=mock stand-in for a real hash.
 *
 * There are no image bytes in this repository, so mock evidence is hashed by its
 * reference instead of its pixels. Identical references collide exactly (which is
 * what the reuse fixtures exercise); unrelated references do not. Real
 * near-duplicate behaviour - the case pHash exists for - only appears once actual
 * bytes are available.
 *
 * TODO(LIVE): decode the evidence blob for `image_ref`, convert to grayscale and
 * call `dHash` instead of this function.
 * Requires .env: DATABASE_URL (evidence blobs are addressed by image_ref)
 */
export function mockHashFromRef(imageRef: string): string {
  return createHash('sha256').update(imageRef).digest('hex').slice(0, HASH_BITS / 4);
}
