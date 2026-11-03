import { all as heicImages } from "heic-decode";
import jpeg from "jpeg-js";

/**
 * Decoding is bounded: a small file can claim a huge canvas. Logos (core/logo.ts), texted photos,
 * and photos uploaded on a quote's page are checked against these before anything is decoded, and again
 * on what the decoder returns.
 */
export const MAX_PIXELS = 16_000_000;
/** What a PNG inflates to before it's turned into 8-bit RGBA: a 16-bit RGBA PNG is twice its RGBA size. */
export const MAX_DECODED_BYTES = MAX_PIXELS * 4;
/** Photos are bigger than logos: iPhones shoot 24 MP by default and 48 MP at full size, so texted and uploaded photos get room for that before they're scaled down. */
export const PHOTO_MAX_PIXELS = 50_000_000;

/** The model reads JPEG, PNG, WebP and GIF. iPhones send HEIC, which it rejects. */
const HEIC = /^image\/hei[cf](-sequence)?$/i;
const MAX_SIDE = 2048;

export function isHeic(mimeType: string): boolean {
  return HEIC.test(mimeType);
}

/**
 * Decodes a HEIC's first top-level image, which heic-decode's default decodes too, after checking every
 * top-level image's size as libheif reports it (a grid's is its whole output) before any pixel is decoded.
 * Throws `IMAGE_UNREADABLE` or `IMAGE_TOO_LARGE`. heic-decode makes libheif's context itself, so libheif's
 * own size limits stay at their defaults; callers bound the coded size beforehand where they can
 * (`heicSize` in core/logo.ts).
 */
export async function decodeHeicBounded(bytes: Uint8Array, maxPixels = MAX_PIXELS): Promise<Rgba> {
  let images: Awaited<ReturnType<typeof heicImages>>;
  try {
    images = await heicImages({ buffer: bytes });
  } catch {
    throw new Error("IMAGE_UNREADABLE");
  }
  try {
    if (images.length === 0 || images.some((image) => image.width === 0 || image.height === 0)) throw new Error("IMAGE_UNREADABLE");
    if (images.some((image) => image.width * image.height > maxPixels)) throw new Error("IMAGE_TOO_LARGE");
    return await images[0].decode().catch(() => {
      throw new Error("IMAGE_UNREADABLE");
    });
  } finally {
    images.dispose();
  }
}

/** Decodes a HEIC photo (bounded by `PHOTO_MAX_PIXELS`) and re-encodes it as a JPEG, scaled down so its long side is at most 2048 px. */
export async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  const image = await decodeHeicBounded(bytes, PHOTO_MAX_PIXELS);
  const scaled = shrink(image, MAX_SIDE);
  return new Uint8Array(jpeg.encode({ ...scaled, data: Buffer.from(scaled.data) }, 85).data);
}

export type Rgba = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/**
 * Box-averages RGBA pixels down to fit `max`; returns the image as is when it already fits. Colour is
 * weighted by alpha, so a transparent logo's edges don't pick up the black of its see-through pixels.
 */
export function shrink(image: Rgba, max: number): Rgba {
  const factor = Math.ceil(Math.max(image.width, image.height) / max);
  if (factor <= 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const out = new Uint8Array(width * height * 4);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        let i = ((y * factor + dy) * image.width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++, i += 4) {
          const alpha = image.data[i + 3];
          sums[0] += image.data[i] * alpha;
          sums[1] += image.data[i + 1] * alpha;
          sums[2] += image.data[i + 2] * alpha;
          sums[3] += alpha;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = sums[3] === 0 ? 0 : Math.round(sums[c] / sums[3]);
      out[o + 3] = Math.round(sums[3] / area);
    }
  }
  return { width, height, data: out };
}
