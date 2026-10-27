import assert from "node:assert/strict";
import test from "node:test";
import * as upngModule from "@pdf-lib/upng";
import jpeg from "jpeg-js";
import { readFileSync } from "node:fs";
import { LOGO_MAX_BYTES, LOGO_MAX_SIDE, MAX_PIXELS, heicSize, jpegOrientation, jpegSize, normalizeLogo, orient, pngSize, sniffImage } from "./logo";

const UPNG = ((upngModule as unknown as { default?: { default?: typeof upngModule } }).default?.default ??
  (upngModule as unknown as { default?: typeof upngModule }).default ??
  upngModule) as typeof upngModule;

/** An RGBA PNG: opaque red on the left half, see-through on the right. */
function png(width: number, height: number, frames = 1): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width / 2; x++) data.set([220, 30, 30, 255], (y * width + x) * 4);
  }
  const buffers = Array.from({ length: frames }, () => data.slice().buffer);
  return new Uint8Array(UPNG.encode(buffers, width, height, 0, frames > 1 ? buffers.map(() => 100) : undefined));
}

/** A JPEG, optionally carrying EXIF with an orientation tag and a camera comment. */
function jpg(width: number, height: number, orientation?: number): Uint8Array {
  const data = Buffer.alloc(width * height * 4, 0x80);
  // A little-endian TIFF header with one IFD entry: 0x0112 (orientation), SHORT, 1, value.
  const exif = orientation
    ? Buffer.from([
        ...Buffer.from("Exif\0\0", "latin1"),
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00,
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ])
    : undefined;
  const image = { width, height, data, exifBuffer: exif, comments: ["Camera X, 25.7617 N 80.1918 W"] };
  return new Uint8Array(jpeg.encode(image, 85).data);
}

test("an image's type comes from its bytes", () => {
  assert.equal(sniffImage(png(20, 20)), "png");
  assert.equal(sniffImage(jpg(20, 20)), "jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(sniffImage(new TextEncoder().encode("GIF89a....")), "gif");
  assert.equal(sniffImage(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), "svg");
  assert.equal(sniffImage(new TextEncoder().encode("  <svg></svg>")), "svg");
  assert.equal(sniffImage(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0])), "heic");
  assert.equal(sniffImage(new TextEncoder().encode("%PDF-1.7")), "unknown");
});

test("WebP, GIF, SVG, and files that aren't images are refused, whatever they're called", async () => {
  for (const bytes of [
    new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "),
    new TextEncoder().encode("GIF89a...."),
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    new TextEncoder().encode("%PDF-1.7"),
    new Uint8Array([1, 2, 3]),
  ]) {
    await assert.rejects(normalizeLogo(bytes), /^Error: LOGO_UNSUPPORTED$/);
  }
});

test("a file over 5 MB, or a canvas too big to decode, is refused before decoding", async () => {
  const big = new Uint8Array(LOGO_MAX_BYTES + 1);
  big.set(png(20, 20));
  await assert.rejects(normalizeLogo(big), /LOGO_TOO_LARGE/);
  // A valid PNG header claiming 100,000 x 100,000 pixels.
  const bomb = png(20, 20);
  const view = new DataView(bomb.buffer);
  view.setUint32(16, 100_000);
  view.setUint32(20, 100_000);
  await assert.rejects(normalizeLogo(bomb), /LOGO_TOO_LARGE/);
});

test("broken, tiny, and animated images are refused", async () => {
  const broken = png(40, 40).slice(0, 60);
  await assert.rejects(normalizeLogo(broken), /LOGO_UNREADABLE/);
  await assert.rejects(normalizeLogo(jpg(40, 40).slice(0, 30)), /LOGO_UNREADABLE/);
  await assert.rejects(normalizeLogo(png(8, 8)), /LOGO_TOO_SMALL/);
  await assert.rejects(normalizeLogo(png(40, 40, 2)), /LOGO_ANIMATED/);
});

test("a PNG stays a PNG, keeps its transparency, and is scaled to fit", async () => {
  const logo = await normalizeLogo(png(1800, 300));
  assert.equal(logo.mimeType, "image/png");
  assert.ok(logo.width <= LOGO_MAX_SIDE && logo.height <= LOGO_MAX_SIDE);
  assert.equal(logo.width / logo.height, 6);
  const decoded = UPNG.decode(logo.bytes.slice().buffer);
  const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  assert.deepEqual([...pixels.slice(0, 4)], [220, 30, 30, 255], "left stays opaque red");
  assert.equal(pixels[(logo.width - 1) * 4 + 3], 0, "right stays see-through");
  // Small logos are left at their size.
  assert.equal((await normalizeLogo(png(120, 40))).width, 120);
  // A small Buffer shares its memory with others (Node's pool): only its own bytes are read.
  const pooled = Buffer.from(Array.from(png(120, 40)));
  assert.notEqual(pooled.byteOffset, 0);
  assert.equal((await normalizeLogo(pooled)).width, 120);
});

test("a JPEG comes back upright, with its EXIF and comments gone", async () => {
  const sideways = jpg(80, 40, 6);
  assert.equal(jpegOrientation(sideways), 6);
  assert.ok(Buffer.from(sideways).includes("Camera X"));
  const logo = await normalizeLogo(sideways);
  assert.equal(logo.mimeType, "image/jpeg");
  assert.deepEqual([logo.width, logo.height], [40, 80], "rotated a quarter turn");
  assert.equal(jpegOrientation(logo.bytes), 1);
  assert.ok(!Buffer.from(logo.bytes).includes("Exif"));
  assert.ok(!Buffer.from(logo.bytes).includes("Camera X"));
  assert.equal(jpegOrientation(jpg(20, 20)), 1);
});

test("orient turns and flips pixels as EXIF says", () => {
  // 2 x 1: pixel A then pixel B.
  const image = { width: 2, height: 1, data: new Uint8Array([1, 1, 1, 255, 2, 2, 2, 255]) };
  const first = (o: number) => {
    const out = orient(image, o);
    return [out.width, out.height, out.data[0]];
  };
  assert.deepEqual(first(1), [2, 1, 1]);
  assert.deepEqual(first(2), [2, 1, 2]);
  assert.deepEqual(first(3), [2, 1, 2]);
  assert.deepEqual(first(6), [1, 2, 1]);
  assert.deepEqual(first(8), [1, 2, 2]);
});

/** A real 64 x 32 HEIC (made with libheif), with its declared size (`ispe`) rewritten when asked. */
function heic(width?: number, height?: number): Uint8Array {
  const bytes = new Uint8Array(readFileSync(new URL("../test-fixtures/logo-64x32.heic", import.meta.url)));
  if (width !== undefined && height !== undefined) {
    const at = Buffer.from(bytes).indexOf("ispe");
    const view = new DataView(bytes.buffer);
    view.setUint32(at + 8, width); // after the type, four bytes of version and flags
    view.setUint32(at + 12, height);
  }
  return bytes;
}

test("a HEIC is checked by its coded size and by libheif's, before any pixel is decoded", async () => {
  // The fixture is coded 64 x 64 and cropped (clap) to 64 x 32: libheif reports and decodes 64 x 32.
  assert.deepEqual(heicSize(heic()), { width: 64, height: 64 });
  const logo = await normalizeLogo(heic());
  assert.deepEqual([logo.mimeType, logo.width, logo.height], ["image/jpeg", 64, 32]);
  // 20,000 x 20,000 declared in a 426-byte file. libheif would still report the cropped 64 x 32, so
  // only the coded size catches it: refused before decoding.
  const huge = heic(20_000, 20_000);
  assert.ok(huge.length < 1000);
  await assert.rejects(normalizeLogo(huge), /^Error: LOGO_TOO_LARGE$/);
  await assert.rejects(normalizeLogo(heic(4001, 4000)), /LOGO_TOO_LARGE/);
  assert.ok(4001 * 4000 > MAX_PIXELS);
  // No declared size, or a header cut short before libheif can find an image: unreadable.
  const noSize = heic();
  noSize.set(Buffer.from("free"), Buffer.from(noSize).indexOf("ispe"));
  assert.equal(heicSize(noSize), null);
  await assert.rejects(normalizeLogo(noSize), /^Error: LOGO_UNREADABLE$/);
  await assert.rejects(normalizeLogo(heic().slice(0, 300)), /^Error: LOGO_UNREADABLE$/);
});

/** A PNG chunk with a zero CRC: these are refused before anything checks a CRC. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  return out;
}

test("a PNG needs exactly one IHDR, first, and is refused by what it would inflate to", async () => {
  const good = png(30, 20);
  // UPNG picks the smallest colour type, here a palette: a filter byte and the packed indexes per row.
  assert.deepEqual(pngSize(good), { width: 30, height: 20, animated: false, decodedBytes: 20 * (1 + Math.ceil((30 * good[24]) / 8)) });
  assert.equal(good[25], 3);
  assert.equal(pngSize(png(30, 20, 2))?.animated, true);
  const signature = good.slice(0, 8);
  const ihdr = good.slice(8, 33);
  const rest = good.slice(33);
  const notFirst = Buffer.concat([signature, chunk("tEXt", Buffer.from("Comment\0x", "latin1")), ihdr, rest]);
  const twice = Buffer.concat([signature, ihdr, ihdr, rest]);
  assert.equal(pngSize(notFirst), null);
  assert.equal(pngSize(twice), null);
  await assert.rejects(normalizeLogo(twice), /^Error: LOGO_UNREADABLE$/);
  const badDepth = good.slice();
  badDepth[24] = 3; // a bit depth no colour type allows
  assert.equal(pngSize(badDepth), null);
  // 3,000 x 3,000 is under the pixel cap, but at 16-bit RGBA it inflates to 72 MB: refused before decoding.
  const deep = good.slice();
  const view = new DataView(deep.buffer);
  view.setUint32(16, 3000);
  view.setUint32(20, 3000);
  deep[24] = 16;
  deep[25] = 6;
  assert.ok(3000 * 3000 < MAX_PIXELS);
  assert.equal(pngSize(deep)?.decodedBytes, 3000 * (1 + 3000 * 8));
  await assert.rejects(normalizeLogo(deep), /^Error: LOGO_TOO_LARGE$/);
});

test("a JPEG's size is read from its frame header and checked before it's decoded", async () => {
  // A JPEG whose frame header declares 65,535 x 65,535, with nothing after it.
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0xff, 0xff, 0xff, 0xff, 0x03]);
  assert.deepEqual(jpegSize(sof), { width: 65_535, height: 65_535 });
  await assert.rejects(normalizeLogo(sof), /^Error: LOGO_TOO_LARGE$/);
  assert.deepEqual(jpegSize(jpg(30, 20)), { width: 30, height: 20 });
  await assert.rejects(normalizeLogo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])), /LOGO_UNREADABLE/);
});
