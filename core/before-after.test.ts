// Stored photos go to a temp folder as file:// URLs, so they read back.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BLOB_LOCAL_DIR = mkdtempSync(join(tmpdir(), "before-after-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { organization, pricedPhotos } from "../schema/schema";
import type { PricedRegion } from "../schema/types";
import { beforeAfterCopy, beforeAfterFor, beforeAfterLayout, BEFORE_AFTER_MAX, renderBeforeAfter, type BeforeAfter } from "./before-after";
import { storeInboundAttachment } from "./blob";
import { db, newId } from "./db";
import { createMember, type Caller } from "./members";
import type { PricedPhoto } from "./priced-photo";
import { createQuote, type Poster } from "./quotes";
import { TEST_ORG, withTestDb } from "./test-db";

test("two landscape photos sit side by side at one height, the composite within its widest", () => {
  const big = beforeAfterLayout({ width: 1600, height: 1200 }, { width: 1600, height: 1200 });
  assert.equal(big.height, 765);
  assert.deepEqual([big.before.width, big.after.width, big.after.x], [1020, 1020, 1028]);
  assert.ok(big.width <= BEFORE_AFTER_MAX);
  // Never enlarged past the shorter photo.
  const small = beforeAfterLayout({ width: 400, height: 300 }, { width: 800, height: 400 });
  assert.equal(small.height, 300);
  assert.deepEqual([small.before.width, small.after.width, small.width], [400, 600, 1008]);
});

test("two portrait photos sit side by side too, at the shorter one's height", () => {
  const tall = beforeAfterLayout({ width: 300, height: 400 }, { width: 600, height: 800 });
  assert.equal(tall.height, 400);
  assert.deepEqual([tall.before.width, tall.after.x, tall.after.width, tall.width], [300, 308, 300, 608]);
  const huge = beforeAfterLayout({ width: 1200, height: 1600 }, { width: 1200, height: 1600 });
  assert.ok(huge.width <= BEFORE_AFTER_MAX);
  const mixed = beforeAfterLayout({ width: 300, height: 400 }, { width: 400, height: 300 });
  assert.equal(mixed.height, 300);
});

test("the labels say before and after in the viewer's language", () => {
  assert.deepEqual([beforeAfterCopy("en").before, beforeAfterCopy("en").after], ["Before", "After"]);
  assert.deepEqual([beforeAfterCopy("es").before, beforeAfterCopy("es").after], ["Antes", "Después"]);
});

const white = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer();

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

test("the composite labels each photo, outlines the kept masks when asked, and puts the caption under both", async () => {
  const beforeUrl = await storeInboundAttachment("before.png", "image/png", await white(400, 300));
  const afterUrl = await storeInboundAttachment("after.png", "image/png", await white(400, 300));
  const bed: PricedRegion = {
    lineIndex: 0,
    itemId: null,
    name: "Mulch installed",
    quantity: 3,
    unitLabel: "cubic yard",
    totalCents: 28500,
    phrase: "mulch bed",
    objects: [{ candidateId: "cand_bed", box: { left: 100, top: 100, right: 300, bottom: 200 }, areaPx: 20000, confidence: 0.9 }],
    located: true,
  };
  const pair: BeforeAfter = {
    quoteId: "quo_test",
    title: "412 Oak St front yard",
    totalCents: 28500,
    version: 1,
    // The before keeps its outline; the after was made before outlines were kept, so it's the plain photo.
    before: photoRow({
      sourceUrl: beforeUrl,
      photoHeight: 300,
      regions: [bed],
      candidates: [{ id: "cand_bed", phrase: "mulch bed", box: bed.objects[0].box, areaPx: 20000, confidence: 0.9, svgPath: "M100 100L300 100L300 200L100 200Z" }],
    }),
    after: photoRow({ sourceKind: "work_photo", sourceUrl: afterUrl }),
  };
  const { png, width, height } = await renderBeforeAfter(pair, "en", { linePrices: true, outlines: true });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [width, height]);
  assert.equal(width, 808);
  assert.ok(height > 300, "the caption sits under the photos");
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.ok(pixel(200, 150)[2] < 220, "the before's bed is filled in its line's color");
  // Without outlines (the default), the before is its plain photo.
  const plain = await sharp((await renderBeforeAfter(pair, "en", { linePrices: true })).png).raw().toBuffer();
  assert.ok([...plain.subarray((150 * info.width + 200) * 3, (150 * info.width + 200) * 3 + 3)].every((c) => c > 240), "no outline by default");
  assert.ok(pixel(608, 150).every((c) => c > 240), "the after has no outline of its own");
  for (const left of [0, 408]) assert.ok(pixel(left + 12, 24).every((c) => c < 90), "a dark label pill in each photo's top left corner");
  assert.ok(pixel(404, 150).every((c) => c < 40), "a gap between the photos");
  assert.ok(pixel(4, height - 4).every((c) => c < 40), "the caption band");
  // Spanish labels and a caption without the total draw too.
  assert.equal((await renderBeforeAfter(pair, "es", { linePrices: false })).width, 808);
  await assert.rejects(renderBeforeAfter({ ...pair, after: photoRow({ sourceUrl: "fake://inbound/after.jpg" }) }, "en", { linePrices: true }), /UNREADABLE_PHOTO/);
});

const post: Poster = async () => ({ posted: true });

withTestDb("before and after: pairs the newest of each kind on the quote, and only within its business", async () => {
  const member = await createMember({ orgId: TEST_ORG, name: "Pat", role: "owner" });
  const owner: Caller = { orgId: TEST_ORG, memberId: member.id, name: "Pat", role: "owner", language: "en", phoneE164: null };
  const quote = await createQuote({ title: "412 Oak St front yard", lines: [{ name: "Mulch", quantity: 3, unitLabel: "cubic yard", unitCents: 9500 }] }, owner, { post });
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 28, 12, minutes));
  const add = (orgId: string, sourceKind: "quote_attachment" | "work_photo", createdAt: Date, editedAt: Date | null = null) =>
    db()
      .insert(pricedPhotos)
      .values({
        id: newId("ppho"),
        orgId,
        quoteId: quote.quoteId,
        revisionNumber: 1,
        sourceKind,
        sourceId: newId("src"),
        sourceUrl: `fake://inbound/${newId("photo")}.jpg`,
        url: "fake://priced.png",
        width: 400,
        height: 500,
        photoHeight: 300,
        regions: [],
        createdAt,
        editedAt,
      })
      .returning()
      .then(([row]) => row);

  assert.equal(await beforeAfterFor(TEST_ORG, quote.quoteId), null, "no priced photo");
  await add(TEST_ORG, "quote_attachment", at(0));
  const before = await add(TEST_ORG, "quote_attachment", at(1), at(30));
  assert.equal(await beforeAfterFor(TEST_ORG, quote.quoteId), null, "only a before");
  // Another business's work photo on this quote's id never pairs, there or here.
  await db().insert(organization).values({ id: "org_other", name: "Other", slug: "other" });
  await add("org_other", "work_photo", at(40));
  assert.equal(await beforeAfterFor(TEST_ORG, quote.quoteId), null, "another business's after");
  assert.equal(await beforeAfterFor("org_other", quote.quoteId), null);

  await add(TEST_ORG, "work_photo", at(2));
  const after = await add(TEST_ORG, "work_photo", at(5));
  const pair = await beforeAfterFor(TEST_ORG, quote.quoteId);
  assert.ok(pair);
  assert.deepEqual([pair.before.id, pair.after.id], [before.id, after.id]);
  assert.equal(pair.title, "412 Oak St front yard");
  assert.equal(pair.totalCents, quote.totalCents);
  assert.equal(pair.version, at(30).getTime(), "the latest of the four times: the before's edit");
});
