/**
 * Read-only image decoding, for perceptual hashing and for telling the model the
 * truth about what it is being sent.
 *
 * SPEC section 0. Everything here is one-way: bytes in, numbers out. There is no
 * encoder, no writer, no transform and no re-compression anywhere in this file,
 * and none may be added. The PNG path is hand-written against node's built-in
 * `zlib` precisely so that this repository carries a decoder and provably not a
 * codec - a PNG library would have brought an encoder in with it.
 *
 * The FraudBench subset needs both: roughly half the generator outputs are PNG
 * data stored under a `.jpg` name, so file extension is not trustworthy and the
 * media type is sniffed from magic bytes instead. Sending a PNG labelled
 * `image/jpeg` to a multimodal API is a silent way to corrupt an evaluation.
 */
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';

export interface GrayscaleImage {
  width: number;
  height: number;
  /** Row-major luminance values, 0-255, length = width * height. */
  pixels: Uint8Array;
}

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null;

/** Media type from magic bytes. The file extension is not consulted. */
export function sniffMediaType(buf: Buffer): SniffedType {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 6 && buf.toString('latin1', 0, 6).startsWith('GIF8')) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** ITU-R BT.601 luma. */
function luma(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

// --------------------------------------------------------------------------
// PNG - decode only (RFC 2083). No encoder, by construction.
// --------------------------------------------------------------------------

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses the per-scanline filters. Operates in place on `raw`. */
function unfilter(raw: Buffer, bytesPerLine: number, bpp: number, height: number): Buffer {
  const out = Buffer.allocUnsafe(bytesPerLine * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const lineStart = y * bytesPerLine;
    const prevStart = (y - 1) * bytesPerLine;
    for (let x = 0; x < bytesPerLine; x += 1) {
      const value = raw[pos + x] ?? 0;
      const a = x >= bpp ? (out[lineStart + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prevStart + x] ?? 0) : 0;
      const c = y > 0 && x >= bpp ? (out[prevStart + x - bpp] ?? 0) : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = value;
          break;
        case 1:
          recon = value + a;
          break;
        case 2:
          recon = value + b;
          break;
        case 3:
          recon = value + ((a + b) >> 1);
          break;
        case 4:
          recon = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filter} on row ${y}`);
      }
      out[lineStart + x] = recon & 0xff;
    }
    pos += bytesPerLine;
  }
  return out;
}

function decodePngToGrayscale(buf: Buffer): GrayscaleImage {
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8; // skip the signature
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      depth = buf[dataStart + 8]!;
      colorType = buf[dataStart + 9]!;
      interlace = buf[dataStart + 12]!;
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataStart + length);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4; // + CRC
  }

  if (width === 0 || height === 0) throw new Error('PNG: no IHDR');
  if (interlace !== 0) throw new Error('PNG: interlaced images are not supported');
  if (depth !== 8 && depth !== 16) throw new Error(`PNG: unsupported bit depth ${depth}`);
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`PNG: unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('PNG: palette image with no PLTE');

  const sampleBytes = depth / 8;
  const bpp = Math.max(1, channels * sampleBytes);
  const bytesPerLine = width * bpp;
  const raw = unfilter(inflateSync(Buffer.concat(idat)), bytesPerLine, bpp, height);

  const pixels = new Uint8Array(width * height);
  // 16-bit samples are read from their high byte: hashing needs 8-bit luminance.
  const step = sampleBytes;
  for (let y = 0; y < height; y += 1) {
    const line = y * bytesPerLine;
    for (let x = 0; x < width; x += 1) {
      const at = line + x * bpp;
      let value: number;
      if (colorType === 3) {
        const index = raw[at] ?? 0;
        value = luma(palette![index * 3] ?? 0, palette![index * 3 + 1] ?? 0, palette![index * 3 + 2] ?? 0);
      } else if (colorType === 0 || colorType === 4) {
        value = raw[at] ?? 0;
      } else {
        value = luma(raw[at] ?? 0, raw[at + step] ?? 0, raw[at + 2 * step] ?? 0);
      }
      pixels[y * width + x] = value;
    }
  }
  return { width, height, pixels };
}

// --------------------------------------------------------------------------

function decodeJpegToGrayscale(buf: Buffer): GrayscaleImage {
  const raw = jpeg.decode(buf, { useTArray: true });
  const pixels = new Uint8Array(raw.width * raw.height);
  for (let i = 0, p = 0; p < pixels.length; i += 4, p += 1) {
    pixels[p] = luma(raw.data[i] ?? 0, raw.data[i + 1] ?? 0, raw.data[i + 2] ?? 0);
  }
  return { width: raw.width, height: raw.height, pixels };
}

/**
 * Decodes to luminance. Throws on anything it cannot read - a reuse measurement
 * built on a guessed hash would be worse than no measurement at all.
 */
export function decodeToGrayscale(buf: Buffer, label: string): GrayscaleImage {
  const type = sniffMediaType(buf);
  if (type === 'image/jpeg') return decodeJpegToGrayscale(buf);
  if (type === 'image/png') return decodePngToGrayscale(buf);
  throw new Error(`cannot decode ${label}: unsupported or unrecognised image format (${type ?? 'unknown'})`);
}
