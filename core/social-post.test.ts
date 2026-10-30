// Stored photos go to a temp folder as file:// URLs, so they read back.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BLOB_LOCAL_DIR = mkdtempSync(join(tmpdir(), "social-post-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { PricedRegion } from "../schema/types";
import type { BeforeAfter } from "./before-after";
import { storeInboundAttachment } from "./blob";
import { newId } from "./db";
import type { PricedPhoto } from "./priced-photo";
import { callToAction, postLines, renderSocialPost, socialCaption, socialPostLayout } from "./social-post";
import { TEST_ORG } from "./test-db";

test("a square post puts the two halves side by side, a story stacks them, both the same size", () => {
  const square = socialPostLayout("square", 168);
  assert.deepEqual([square.width, square.height], [1080, 1080]);
  assert.deepEqual(square.before, { x: 0, y: 0, width: 536, height: 912 });
  assert.deepEqual(square.after, { x: 544, y: 0, width: 536, height: 912 });
  const story = socialPostLayout("story", 240);
  assert.deepEqual([story.width, story.height], [1080, 1920]);
  assert.deepEqual(story.before, { x: 0, y: 0, width: 1080, height: 836 });
  assert.deepEqual(story.after, { x: 0, y: 844, width: 1080, height: 836 });
});

const phone = { phone: "+13055550142", email: "hello@greenleaf.example" };
const lines = ["Mulch installed", "Bed edging", "Hedge trimming"];

test("the caption names the lines and asks for the next job by text, else email, else not at all", () => {
  assert.equal(
    socialCaption(lines, phone, { cta: true, language: "en" }),
    "Before and after: mulch installed, bed edging, and hedge trimming. Want yours done? Text (305) 555-0142.",
  );
  assert.equal(socialCaption(lines, phone, { cta: false, language: "en" }), "Before and after: mulch installed, bed edging, and hedge trimming.");
  assert.equal(
    socialCaption(["Mulch installed"], { phone: null, email: "hello@greenleaf.example" }, { cta: true, language: "en" }),
    "Before and after: mulch installed. Want yours done? Email hello@greenleaf.example.",
  );
  assert.equal(socialCaption(["Mulch installed", "Bed edging"], { phone: null, email: null }, { cta: true, language: "en" }), "Before and after: mulch installed and bed edging.");
  assert.equal(callToAction({ phone: " ", email: null }, "en"), null);
  assert.equal(socialCaption([], phone, { cta: false, language: "en" }), "Before and after.");
});

test("the caption in Spanish", () => {
  assert.equal(
    socialCaption(["Mulch instalado", "Bordes de camas", "Poda de setos"], phone, { cta: true, language: "es" }),
    "Antes y después: mulch instalado, bordes de camas y poda de setos. ¿Quieres que hagamos el tuyo? Escríbenos al (305) 555-0142.",
  );
  assert.equal(
    socialCaption(["Mulch instalado"], { phone: null, email: "hola@greenleaf.example" }, { cta: true, language: "es" }),
    "Antes y después: mulch instalado. ¿Quieres que hagamos el tuyo? Escríbenos a hola@greenleaf.example.",
  );
  assert.equal(socialCaption(["Mulch instalado"], { phone: null, email: null }, { cta: true, language: "es" }), "Antes y después: mulch instalado.");
});

function region(lineIndex: number, name: string): PricedRegion {
  return { lineIndex, itemId: null, name, quantity: 1, unitLabel: "", totalCents: 1000, phrase: name, objects: [], located: false };
}

function photoRow(over: Partial<PricedPhoto>): PricedPhoto {
  return {
    id: newId("ppho"),
    orgId: TEST_ORG,
    quoteId: "quo_test",
    revisionNumber: 1,
    sourceKind: "quote_attachment",
    sourceId: "att_test",
    sourceUrl: "",
    url: "",
    customerUrl: null,
    width: 400,
    height: 300,
    photoHeight: null,
    regions: [],
    candidates: [],
    memberId: null,
    createdAt: new Date("2026-10-28T12:00:00Z"),
    editedBy: null,
    editedAt: null,
    ...over,
  };
}

/** A pair of flat photos: a gray landscape before and a green portrait after. */
async function fixturePair(): Promise<BeforeAfter> {
  const flat = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();
  const beforeUrl = await storeInboundAttachment("before.jpg", "image/jpeg", await flat(800, 600, "#8a8a8a"));
  const afterUrl = await storeInboundAttachment("after.jpg", "image/jpeg", await flat(600, 800, "#3c8c3c"));
  return {
    quoteId: "quo_test",
    title: "412 Oak St front yard",
    totalCents: 28500,
    version: 1,
    before: photoRow({ sourceUrl: beforeUrl }),
    after: photoRow({ sourceKind: "work_photo", sourceUrl: afterUrl, regions: [region(0, "Mulch installed"), region(1, "Bed edging"), region(2, "Mulch installed")] }),
  };
}

test("the post is drawn at the format's size, each half filled, with the band under them", async () => {
  const pair = await fixturePair();
  assert.deepEqual(postLines(pair), ["Mulch installed", "Bed edging"]);
  const business = { name: "Green Leaf Landscaping", ...phone, logo: null };
  for (const format of ["square", "story"] as const) {
    const { png, width, height } = await renderSocialPost(pair, { format, cta: true, language: "en", business });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, width, height], format === "square" ? [1080, 1080, 1080, 1080] : [1080, 1920, 1080, 1920]);
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    // The after half is green to its far edge: center-cropped to fill, never letterboxed.
    const after = format === "square" ? [[1075, 400], [800, 900]] : [[540, 1660], [1075, 900]];
    for (const [x, y] of after) assert.ok(pixel(x, y)[1] > pixel(x, y)[0] + 30, `the after fills its half at ${x},${y}`);
    const gap = format === "square" ? pixel(540, 500) : pixel(540, 840);
    assert.ok(gap.every((c) => c < 40), "a gap between the halves");
    assert.ok(pixel(4, height - 4).every((c) => c < 40), "the band");
    assert.ok(pixel(28, 40).every((c) => c < 90), "the before's label pill, left of its text");
  }
});

test("the logo sits on a white tile in the band, and the photos must be readable", async () => {
  const pair = await fixturePair();
  const logo = { bytes: new Uint8Array(await sharp({ create: { width: 200, height: 100, channels: 3, background: "#204020" } }).png().toBuffer()), mimeType: "image/png" };
  const business = { name: "Green Leaf", phone: null, email: null, logo };
  const { png, height } = await renderSocialPost(pair, { format: "square", cta: false, language: "es", business });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  const bandMiddle = height - 84;
  assert.ok(pixel(44, bandMiddle - 50).every((c) => c > 240), "the tile's white edge");
  assert.ok(pixel(140, bandMiddle)[1] < 100, "the logo on it");
  await assert.rejects(
    renderSocialPost({ ...pair, after: photoRow({ sourceUrl: "fake://inbound/after.jpg" }) }, { format: "story", cta: true, language: "en", business }),
    /UNREADABLE_PHOTO/,
  );
});
