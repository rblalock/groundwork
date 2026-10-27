import * as upngModule from "@pdf-lib/upng";
import jpeg from "jpeg-js";
import { decodeHeicBounded, MAX_DECODED_BYTES, MAX_PIXELS, shrink, type Rgba } from "./images";

export { MAX_PIXELS };

// A business's logo, from a Settings upload or a texted photo. Its type comes from its bytes, never its
// name or the type it claims. It is decoded, turned upright, scaled down, and encoded again, so nothing
// but pixels survives (no EXIF, location, or comments). A PNG stays a PNG and keeps its transparency; a
// JPEG, or an iPhone's HEIC, becomes a JPEG. PDFs embed only PNG and JPEG, and nothing here decodes WebP,
// GIF, or SVG, so those are refused with a message that says what works.

/** The largest file accepted, before it's normalized. */
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;
/** The long side after normalizing: about 240 dpi across a PDF header's logo box, and plenty for the app. */
export const LOGO_MAX_SIDE = 600;
const MIN_SIDE = 16;

export type ImageFormat = "png" | "jpeg" | "heic" | "webp" | "gif" | "svg" | "unknown";

export type NormalizedLogo = { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg"; width: number; height: number };

// A CommonJS module with an `exports.default`: Node's loader nests it one level deeper than bundlers do.
type Upng = typeof upngModule;
const UPNG: Upng = ((): Upng => {
  const nested = upngModule as unknown as { default?: Upng & { default?: Upng } };
  if (typeof upngModule.decode === "function") return upngModule;
  return nested.default?.default ?? (nested.default as Upng);
})();

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** What the bytes are, from their signature. */
export function sniffImage(bytes: Uint8Array): ImageFormat {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return "gif";
  // HEIC and HEIF: an ISO box `ftyp` whose brand is one of the still-image ones.
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && /^(heic|heix|heim|heis|mif1|msf1|hevc|hevx)$/.test(ascii(bytes, 8, 4))) return "heic";
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "unknown";
}

/**
 * Checks and normalizes a logo. Throws `LOGO_TOO_LARGE` (over 5 MB, or a canvas too big to decode),
 * `LOGO_UNSUPPORTED` (WebP, GIF, SVG, or not an image), `LOGO_ANIMATED`, `LOGO_TOO_SMALL`, or
 * `LOGO_UNREADABLE` (a PNG, JPEG, or HEIC that doesn't decode).
 */
export async function normalizeLogo(bytes: Uint8Array): Promise<NormalizedLogo> {
  if (bytes.byteLength > LOGO_MAX_BYTES) throw new Error("LOGO_TOO_LARGE");
  const format = sniffImage(bytes);
  if (format !== "png" && format !== "jpeg" && format !== "heic") throw new Error("LOGO_UNSUPPORTED");
  // A HEIC is checked here by its coded size, and again by libheif's own view in `decodeHeicImage`.
  const problem = declaredSizeProblem(bytes, format);
  if (problem === "unreadable") throw new Error("LOGO_UNREADABLE");
  if (problem === "too_large") throw new Error("LOGO_TOO_LARGE");
  if (problem === "animated") throw new Error("LOGO_ANIMATED");
  const image = format === "png" ? decodePng(bytes) : format === "jpeg" ? decodeJpeg(bytes) : await decodeHeicImage(bytes);
  if (image.width * image.height > MAX_PIXELS) throw new Error("LOGO_TOO_LARGE");
  if (image.data.byteLength !== image.width * image.height * 4) throw new Error("LOGO_UNREADABLE");
  if (image.width < MIN_SIDE || image.height < MIN_SIDE) throw new Error("LOGO_TOO_SMALL");
  const scaled = shrink(image, LOGO_MAX_SIDE);
  const upright = format === "jpeg" ? orient(scaled, jpegOrientation(bytes)) : scaled;
  const pixels = new Uint8Array(upright.data.buffer, upright.data.byteOffset, upright.data.byteLength);
  if (format === "png") {
    const buffer = pixels.slice().buffer;
    return { bytes: new Uint8Array(UPNG.encode([buffer], upright.width, upright.height, 0)), mimeType: "image/png", width: upright.width, height: upright.height };
  }
  const encoded = jpeg.encode({ width: upright.width, height: upright.height, data: Buffer.from(pixels) }, 90).data;
  return { bytes: new Uint8Array(encoded), mimeType: "image/jpeg", width: upright.width, height: upright.height };
}

type DeclaredSize = { width: number; height: number; animated?: boolean; decodedBytes?: number };

/** Samples per pixel for each valid PNG colour type, and the bit depths it allows. */
const PNG_TYPES: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] }, // grey
  2: { channels: 3, depths: [8, 16] }, // RGB
  3: { channels: 1, depths: [1, 2, 4, 8] }, // palette
  4: { channels: 2, depths: [8, 16] }, // grey and alpha
  6: { channels: 4, depths: [8, 16] }, // RGBA
};

/**
 * A PNG's size from its IHDR, which must be the first chunk and the only one; what its image data inflates
 * to (a filter byte per row, then the packed samples); and whether an acTL makes it animated. Null for a
 * header that doesn't follow the format.
 */
export function pngSize(bytes: Uint8Array): DeclaredSize | null {
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const depth = bytes[24];
  const type = PNG_TYPES[bytes[25]];
  if (!type || !type.depths.includes(depth)) return null;
  let headers = 0;
  let animated = false;
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const chunk = ascii(bytes, offset + 4, 4);
    if (chunk === "IHDR") headers++;
    if (chunk === "acTL") animated = true;
    if (chunk === "IEND") break;
    offset += 12 + view.getUint32(offset);
  }
  if (headers !== 1) return null;
  const decodedBytes = height * (1 + Math.ceil((width * type.channels * depth) / 8));
  return { width, height, animated, decodedBytes };
}

/** A JPEG's size from its frame header (SOF0 to SOF15, not DHT, JPG, or DAC). */
export function jpegSize(bytes: Uint8Array): DeclaredSize | null {
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data before any frame header
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > bytes.length) return null;
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * The largest coded size a HEIC declares, from its `ispe` (image spatial extent) properties under meta →
 * iprp → ipco. libheif reports an image's size after cropping (`clap`) but decodes the whole coded image,
 * so this bounds what decoding allocates. A photo can hold several (a grid and its tiles, a thumbnail):
 * the largest is taken. Null when there are none, which the format doesn't allow.
 */
export function heicSize(bytes: Uint8Array): DeclaredSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** The child boxes in [start, end): their type and where their contents start and end. */
  const boxes = (start: number, end: number) => {
    const out: Array<{ type: string; body: number; end: number }> = [];
    for (let at = start; at + 8 <= end; ) {
      let size = view.getUint32(at);
      let body = at + 8;
      if (size === 1) {
        if (at + 16 > end) break;
        size = Number(view.getBigUint64(at + 8));
        body = at + 16;
      } else if (size === 0) size = end - at;
      if (size < body - at || at + size > end) break;
      out.push({ type: ascii(bytes, at + 4, 4), body, end: at + size });
      at += size;
    }
    return out;
  };
  const meta = boxes(0, bytes.length).find((b) => b.type === "meta");
  // `meta` is a full box: four bytes of version and flags before its children.
  const iprp = meta && boxes(meta.body + 4, meta.end).find((b) => b.type === "iprp");
  const ipco = iprp && boxes(iprp.body, iprp.end).find((b) => b.type === "ipco");
  if (!ipco) return null;
  let largest: DeclaredSize | null = null;
  for (const box of boxes(ipco.body, ipco.end)) {
    if (box.type !== "ispe" || box.body + 12 > box.end) continue;
    const size = { width: view.getUint32(box.body + 4), height: view.getUint32(box.body + 8) };
    if (!largest || size.width * size.height > largest.width * largest.height) largest = size;
  }
  return largest;
}

function decodePng(bytes: Uint8Array): Rgba {
  let decoded: ReturnType<Upng["decode"]>;
  let frames: ArrayBuffer[];
  try {
    // A copy of exactly these bytes: a Node Buffer's slice() is a view, and a small Buffer shares its
    // ArrayBuffer with others, so `.buffer` would hand UPNG the whole pool.
    decoded = UPNG.decode(new Uint8Array(bytes).buffer);
    frames = UPNG.toRGBA8(decoded);
  } catch {
    throw new Error("LOGO_UNREADABLE");
  }
  if ((decoded.tabs.acTL?.num_frames ?? 1) > 1 || frames.length > 1) throw new Error("LOGO_ANIMATED");
  if (!frames[0]) throw new Error("LOGO_UNREADABLE");
  return { width: decoded.width, height: decoded.height, data: new Uint8Array(frames[0]) };
}

function decodeJpeg(bytes: Uint8Array): Rgba {
  try {
    return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1_000_000, maxMemoryUsageInMB: 160 });
  } catch (error) {
    if (error instanceof Error && /maxResolutionInMP|maxMemoryUsageInMB/.test(error.message)) throw new Error("LOGO_TOO_LARGE");
    throw new Error("LOGO_UNREADABLE");
  }
}

/**
 * Decodes a HEIC's first top-level image, which heic-decode's default decodes too, after checking every
 * top-level image's size as libheif reports it (a grid's is its whole output) before any pixel is decoded.
 * heic-decode makes libheif's context itself, so libheif's own size limits can't be set and stay at their
 * defaults; `heicSize` bounds the coded size beforehand.
 */
async function decodeHeicImage(bytes: Uint8Array): Promise<Rgba> {
  try {
    return await decodeHeicBounded(bytes);
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "IMAGE_TOO_LARGE" ? "LOGO_TOO_LARGE" : "LOGO_UNREADABLE");
  }
}

/**
 * What's wrong with an image's declared size, read from its header before anything is decoded: no size
 * to read, a canvas over `MAX_PIXELS` (or a PNG that inflates past `MAX_DECODED_BYTES`), or an animation.
 * Null when it's fine. Logos and photos uploaded on a quote's page both check this.
 */
export function declaredSizeProblem(bytes: Uint8Array, format: "png" | "jpeg" | "heic"): "unreadable" | "too_large" | "animated" | null {
  const declared = format === "png" ? pngSize(bytes) : format === "jpeg" ? jpegSize(bytes) : heicSize(bytes);
  if (!declared || declared.width === 0 || declared.height === 0) return "unreadable";
  if (declared.width * declared.height > MAX_PIXELS) return "too_large";
  if (declared.decodedBytes !== undefined && declared.decodedBytes > MAX_DECODED_BYTES) return "too_large";
  if (declared.animated) return "animated";
  return null;
}

/** The EXIF orientation (1 to 8) of a JPEG, 1 when it has none: phones store photos sideways and say so here. */
export function jpegOrientation(bytes: Uint8Array): number {
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // the image data starts; no more headers
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && ascii(bytes, i + 4, 6) === "Exif\0\0") return tiffOrientation(bytes.subarray(i + 10, i + 2 + length));
    i += 2 + length;
  }
  return 1;
}

function tiffOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49;
  const u16 = (o: number) => (little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
  const u32 = (o: number) => (little ? u16(o) + u16(o + 2) * 65536 : u16(o) * 65536 + u16(o + 2));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  for (let k = 0, count = u16(ifd); k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Turns pixels stored with EXIF orientation `o` the way they're meant to be seen. */
export function orient(image: Rgba, o: number): Rgba {
  if (o <= 1 || o > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = o >= 5;
  const width = swap ? h : w;
  const height = swap ? w : h;
  const out = new Uint8Array(w * h * 4);
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const [dx, dy] =
        o === 2 ? [w - 1 - sx, sy]
        : o === 3 ? [w - 1 - sx, h - 1 - sy]
        : o === 4 ? [sx, h - 1 - sy]
        : o === 5 ? [sy, sx]
        : o === 6 ? [h - 1 - sy, sx]
        : o === 7 ? [h - 1 - sy, w - 1 - sx]
        : [sy, w - 1 - sx];
      const s = (sy * w + sx) * 4;
      const d = (dy * width + dx) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  }
  return { width, height, data: out };
}
