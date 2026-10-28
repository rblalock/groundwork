// Stored photos and renders go to a temp folder as file:// URLs, so they read back.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BLOB_LOCAL_DIR = mkdtempSync(join(tmpdir(), "priced-photo-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { pricedPhotos, quoteAttachments } from "../schema/schema";
import type { PricedRegion } from "../schema/types";
import { landscaping } from "../verticals/landscaping";
import { storeInboundAttachment } from "./blob";
import { db, newId } from "./db";
import { NOTO_SANS_BOLD_BASE64 } from "./fonts/noto-sans-bold";
import { z } from "zod";
import { memberAuth } from "./channel-dispatch";
import { addPhone, createMember, findMemberById, type Caller } from "./members";
import { saveItems } from "./pricebook";
import { createPricedPhoto, lineLabel, pricedPhotosFor, renderOverlay, RERENDER_MS, rerenderTooSoon } from "./priced-photo";
import { updateProfile } from "./profile";
import { createQuote, type Poster } from "./quotes";
import { TEST_ORG, withTestDb } from "./test-db";

const YARD = readFileSync(new URL("../agents/assistant/evals/fixtures/yard-front.jpg", import.meta.url));

const region = (lineIndex: number, name: string, quantity: number, unitLabel: string, totalCents: number, boxes: number[][]): PricedRegion => ({
  lineIndex,
  itemId: null,
  name,
  quantity,
  unitLabel,
  totalCents,
  phrase: "test",
  objects: boxes.map(([left, top, right, bottom]) => ({ box: { left, top, right, bottom }, areaPx: (right - left) * (bottom - top), confidence: 0.9 })),
  located: boxes.length > 0,
});

test("draws the regions and a legend under the photo; two lines on one bed share a label", async () => {
  const bed = [0, 564, 494, 696];
  const regions = [
    region(0, "Mulch installed", 3, "cubic yard", 28500, [bed]),
    region(1, "Bed edging", 40, "linear foot", 10000, [bed]),
    region(2, "Hedge trimming", 150, "cubic foot", 37500, [[0, 494, 444, 645]]),
    region(3, "Sprinkler head replacement", 2, "head", 7000, []),
  ];
  const { png, width, height } = await renderOverlay({ bytes: new Uint8Array(YARD), width: 1024, height: 1024 }, regions, new Map(), 53000, "en");
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, 1024);
  assert.equal(width, 1024);
  assert.equal(meta.height, height);
  assert.ok(height > 1024, "the legend sits under the photo");
  assert.ok(png.byteLength > 50_000);
  if (process.env.PRICED_PHOTO_OUT) writeFileSync(process.env.PRICED_PHOTO_OUT, png);
});

test("a label carries the line's price, or only its scope when line prices are hidden", () => {
  const hedges = region(2, "Hedge trimming", 150, "cubic foot", 37500, []);
  assert.equal(lineLabel(hedges, "en"), "Hedge trimming · 150 cubic feet · $375.00");
  assert.equal(lineLabel(hedges, "en", false), "Hedge trimming · 150 cubic feet");
});

test("the embedded label font is the bundled font file", () => {
  const font = readFileSync(new URL("./fonts/NotoSans-Bold.ttf", import.meta.url));
  assert.ok(Buffer.from(NOTO_SANS_BOLD_BASE64, "base64").equals(font), "run scripts/embed-font.ts");
});

const post: Poster = async () => ({ posted: true });

async function seed() {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const owner: Caller = { orgId: TEST_ORG, memberId: member.id, name: "Pat", role: "owner", language: "en", phoneE164: null };
  const items = new Map((await saveItems(TEST_ORG, landscaping.items, owner.memberId)).map((item) => [item.name, item]));
  return { owner, items };
}

async function quoteWith(owner: Caller, lines: Array<{ itemId: string; quantity: number }>, photo?: { url: string; mimeType: string }) {
  const quote = await createQuote({ title: "412 Oak St front yard", lines }, owner, { post });
  if (photo) {
    await db()
      .insert(quoteAttachments)
      .values({ id: newId("att"), orgId: TEST_ORG, quoteId: quote.quoteId, uploadedByMemberId: owner.memberId, url: photo.url, name: "yard.jpg", mimeType: photo.mimeType });
  }
  return quote;
}

withTestDb("priced photo: no photo, an unreadable one, or no such quote is a reason, not an error", async () => {
  const { owner, items } = await seed();
  const lines = [{ itemId: items.get("Lawn mowing")!.id, quantity: 1 }];
  const bare = await quoteWith(owner, lines);
  assert.deepEqual(await createPricedPhoto(owner, { quoteId: bare.quoteId }), { pricedPhotoId: null, reason: "no_photo" });
  const faked = await quoteWith(owner, lines, { url: "fake://inbound/yard.jpg", mimeType: "image/jpeg" });
  assert.deepEqual(await createPricedPhoto(owner, { quoteId: faked.quoteId }), { pricedPhotoId: null, reason: "unreadable_photo" });
  assert.deepEqual(await createPricedPhoto(owner, { quoteId: "quo_missing" }), { pricedPhotoId: null, reason: "quote_not_found" });
});

test("a priced photo isn't rendered again within ten seconds of the last render of the same revision", () => {
  const now = new Date("2026-10-27T12:00:10Z");
  const previous = { revisionNumber: 2, createdAt: new Date("2026-10-27T12:00:01Z") };
  assert.equal(rerenderTooSoon(previous, 2, now), true);
  assert.equal(rerenderTooSoon(previous, 3, now), false);
  assert.equal(rerenderTooSoon({ ...previous, createdAt: new Date("2026-10-27T12:00:00Z") }, 2, now), false);
});

withTestDb("priced photo: making it again replaces the one for that photo", async () => {
  const { owner, items } = await seed();
  // Cleanup labor has no photo prompt, so nothing is sent to SAM and the line is listed as not located.
  const url = await storeInboundAttachment("yard.jpg", "image/jpeg", new Uint8Array(YARD));
  const quote = await quoteWith(owner, [{ itemId: items.get("Cleanup labor")!.id, quantity: 2 }], { url, mimeType: "image/jpeg" });
  const first = await createPricedPhoto(owner, { quoteId: quote.quoteId });
  assert.ok(first.pricedPhotoId);
  assert.deepEqual([first.located, first.notLocated], [0, ["Cleanup labor"]]);
  assert.equal((await pricedPhotosFor(TEST_ORG, quote.quoteId))[0].customerUrl, null, "prices shown: no quantity-only copy");
  // Past the re-render window, so this one renders again; with line prices hidden, a quantity-only copy beside it.
  await db().update(pricedPhotos).set({ createdAt: new Date(Date.now() - RERENDER_MS - 1) });
  await updateProfile(TEST_ORG, { customerLinePrices: false }, owner.memberId);
  const again = await createPricedPhoto(owner, { quoteId: quote.quoteId });
  assert.equal(again.pricedPhotoId, first.pricedPhotoId);
  const rows = await pricedPhotosFor(TEST_ORG, quote.quoteId);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].url, rows[0].sourceUrl], [again.pricedPhotoId && again.url, url]);
  assert.ok(rows[0].customerUrl && rows[0].customerUrl !== rows[0].url);
});

withTestDb("price_photo: a quote without photos comes back with a reason and a note, not an error", async () => {
  const { owner, items } = await seed();
  const phone = await addPhone(TEST_ORG, owner.memberId, "+15555550142");
  const member = await findMemberById(TEST_ORG, owner.memberId);
  const auth = memberAuth(member!, phone);
  const bare = await quoteWith(owner, [{ itemId: items.get("Lawn mowing")!.id, quantity: 1 }]);
  const { default: pricePhoto } = await import("../agents/assistant/agent/tools/price_photo");
  const tool = pricePhoto as unknown as { inputSchema: z.ZodType; execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> };
  const call = (input: unknown) => tool.execute(tool.inputSchema.parse(input), { session: { id: "ses_x", auth: { current: auth } } });

  const named = await call({ quoteId: bare.quoteId });
  assert.deepEqual([named.pricedPhotoId, named.reason, named.quoteId], [null, "no_photo", bare.quoteId]);
  assert.match(String(named.note), /no photo/);
  // With no quoteId, the quote the member just made.
  const latest = await call({});
  assert.deepEqual([latest.reason, latest.quoteId], ["no_photo", bare.quoteId]);
});

// Calls SAM: runs only with a key, and leaves the render at /tmp/priced-photo.png for a look.
const live = process.env.META_MODEL_API_KEY ? withTestDb : (name: string) => test(name, { skip: "META_MODEL_API_KEY is not set" }, () => {});
live("priced photo: the yard fixture with mulch, edging, hedge and mowing (live)", async () => {
  const { owner, items } = await seed();
  const url = await storeInboundAttachment("yard.jpg", "image/jpeg", new Uint8Array(YARD));
  const quote = await quoteWith(
    owner,
    [
      { itemId: items.get("Mulch installed")!.id, quantity: 3 },
      { itemId: items.get("Hedge trimming")!.id, quantity: 150 },
      { itemId: items.get("Lawn mowing")!.id, quantity: 1 },
      { itemId: items.get("Bed edging")!.id, quantity: 40 },
    ],
    { url, mimeType: "image/jpeg" },
  );
  const result = await createPricedPhoto(owner, { quoteId: quote.quoteId });
  assert.ok(result.pricedPhotoId);
  assert.ok(result.located >= 3, JSON.stringify(result.regions));
  writeFileSync("/tmp/priced-photo.png", readFileSync(fileURLToPath(result.url)));
});
