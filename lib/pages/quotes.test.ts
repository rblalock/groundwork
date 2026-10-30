import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// PDFs and photos go to a temp folder, so the file routes have real bytes to serve.
const blobDir = mkdtempSync(join(tmpdir(), "gw-pages-"));
process.env.BLOB_LOCAL_DIR = blobDir;

import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { messages, pricedPhotos, quotes as quotesTable } from "../../schema/schema";
import { storeInboundAttachment } from "../../core/blob";
import { saveCustomer } from "../../core/customers";
import { db, newId } from "../../core/db";
import { saveItems } from "../../core/pricebook";
import { createQuote, linkRecentAttachments, quoteCursor, type Poster } from "../../core/quotes";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { POST as approveRoute } from "../../app/api/quotes/[id]/approve/route";
import { POST as outcomeRoute } from "../../app/api/quotes/[id]/outcome/route";
import { GET as pdfRoute } from "../../app/api/quotes/[id]/pdf/route";
import { GET as photoRoute } from "../../app/api/quotes/[id]/photos/[photoId]/route";
import { GET as postRoute } from "../../app/api/quotes/[id]/post/route";
import { beforeAfterHref, beforeAfterQuery, socialPostHref, socialPostQuery, formatQuoteCursor, parseQuoteCursor, QUOTE_PAGE_SIZE, quoteFor, quotesFor } from "./quotes";
import { appCaller, BASE as BASE_URL, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

const quiet: Poster = async () => ({ posted: true });

/** One business with an owner and two crew, each with a quote, and another business with its own. */
async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crewA = await person("Sam Crew", "member", "+15555550102");
  const crewB = await person("Lee Crew", "member", "+15555550103");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const customer = (name: string) => saveCustomer(TEST_ORG, { name, address: `${name.length} Sample St` }, owner.memberId);
  const ownerQuote = await createQuote(
    { title: "1 Sample St", customerId: (await customer("Ada Sample")).id, lines: [{ itemId: item.id, quantity: 10 }] },
    owner,
    { post: quiet },
  );
  const crewAQuote = await createQuote(
    { title: "2 Sample St", customerId: (await customer("Bo Sample")).id, lines: [{ itemId: item.id, quantity: 5 }] },
    crewA,
    { post: quiet },
  );
  const crewBQuote = await createQuote({ title: "3 Sample St", lines: [{ itemId: item.id, quantity: 2 }] }, crewB, { post: quiet });
  const unready = await createQuote(
    { title: "4 Sample St", lines: [{ name: "odd job", unitLabel: "visit", quantity: 1 }] },
    owner,
    { post: quiet },
  );

  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const [otherItem] = await saveItems(other, [{ name: "gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 500 }], otherOwner.memberId);
  const otherQuote = await createQuote({ title: "9 Other Rd", lines: [{ itemId: otherItem.id, quantity: 1 }] }, otherOwner, { post: quiet });
  return { owner, crewA, crewB, ownerQuote, crewAQuote, crewBQuote, unready, otherQuote };
}

withTestDb("quotes: everyone on the team sees every quote; another business's are 404", async () => {
  const s = await seed();
  const crew = await appCaller(await signIn("+15555550102"));
  const owner = await appCaller(await signIn("+15555550101"));

  const forCrew = await quotesFor(crew, {});
  assert.equal(forCrew.quotes.length, 4);
  assert.deepEqual(forCrew.counts, { draft: 3, needs_owner: 1 });
  assert.equal((await quoteFor(crew, s.ownerQuote.quoteId)).quote.title, "1 Sample St");
  assert.equal((await quoteFor(crew, s.crewBQuote.quoteId)).quote.title, "3 Sample St");
  assert.equal((await quoteFor(crew, s.crewAQuote.quoteId)).quote.title, "2 Sample St");
  await assert.rejects(quoteFor(crew, s.otherQuote.quoteId), { status: 404 });

  const all = await quotesFor(owner, {});
  assert.equal(all.quotes.length, 4);
  assert.deepEqual(all.counts, { draft: 3, needs_owner: 1 });
  assert.deepEqual((await quotesFor(owner, { query: "Bo" })).quotes.map((q) => q.quoteId), [s.crewAQuote.quoteId]);
  assert.equal((await quotesFor(owner, { status: "approved" })).quotes.length, 0);
  await assert.rejects(quoteFor(owner, s.otherQuote.quoteId), { status: 404 });
});

withTestDb("quotes: the PDF and photos are served to anyone on the team, and no one else", async () => {
  const s = await seed();
  const crewHeaders = await signIn("+15555550102");
  const ownerHeaders = await signIn("+15555550101");

  // A photo the crew member texted, linked to their quote.
  const photoFile = join(blobDir, "photo.jpg");
  writeFileSync(photoFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const since = new Date(Date.now() - 60_000);
  await db().insert(messages).values({
    id: newId("msg"),
    orgId: TEST_ORG,
    memberId: s.crewA.memberId,
    phoneE164: "+15555550102",
    direction: "inbound",
    kind: "user",
    body: "",
    attachments: [{ type: "image", url: pathToFileURL(photoFile).href, name: "photo.jpg", mimeType: "image/jpeg" }],
  });
  assert.equal(await linkRecentAttachments(TEST_ORG, s.crewAQuote.quoteId, s.crewA.memberId, since), 1);
  const { quote } = await quoteFor(await appCaller(ownerHeaders), s.crewAQuote.quoteId);
  const photoId = quote.attachments[0].id;

  const pdf = await call(pdfRoute, crewHeaders, { params: { id: s.crewAQuote.quoteId } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.response.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await pdf.response.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
  const photo = await call(photoRoute, crewHeaders, { params: { id: s.crewAQuote.quoteId, photoId } });
  assert.equal(photo.status, 200);
  assert.equal(photo.response.headers.get("content-type"), "image/jpeg");

  assert.equal((await call(pdfRoute, crewHeaders, { params: { id: s.ownerQuote.quoteId } })).status, 200, "crew open anyone's quote PDF");
  // A photo asked for under a quote it isn't on is missing.
  refused(await call(photoRoute, crewHeaders, { params: { id: s.ownerQuote.quoteId, photoId } }), 404, "NOT_FOUND");
  refused(await call(pdfRoute, ownerHeaders, { params: { id: s.otherQuote.quoteId } }), 404);
  refused(await call(pdfRoute, ownerHeaders, { params: { id: s.unready.quoteId } }), 404);
  refused(await call(pdfRoute, new Headers(), { params: { id: s.crewAQuote.quoteId } }), 401);
});

withTestDb("quotes: only owners and admins approve or close, through the library's own rules", async () => {
  const s = await seed();
  const crewHeaders = await signIn("+15555550102");
  const ownerHeaders = await signIn("+15555550101");
  const id = s.crewAQuote.quoteId;

  refused(await call(approveRoute, crewHeaders, { params: { id }, body: { revision: 1 } }), 403, "NOT_PRIVILEGED");
  refused(await call(outcomeRoute, crewHeaders, { params: { id }, body: { outcome: "sent" } }), 403, "NOT_PRIVILEGED");
  refused(await call(approveRoute, ownerHeaders, { params: { id: s.otherQuote.quoteId }, body: { revision: 1 } }), 404);
  refused(await call(outcomeRoute, ownerHeaders, { params: { id: s.otherQuote.quoteId }, body: { outcome: "void" } }), 404);
  refused(await call(approveRoute, ownerHeaders, { params: { id }, body: { revision: 2 } }), 409, "REVISION_CHANGED");
  refused(await call(approveRoute, ownerHeaders, { params: { id: s.unready.quoteId }, body: { revision: 1 } }), 409, "NOT_READY");
  refused(await call(outcomeRoute, ownerHeaders, { params: { id }, body: { outcome: "bogus" } }), 400, "INVALID_INPUT");

  const approved = await call(approveRoute, ownerHeaders, { params: { id }, body: { revision: 1 } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((approved.body?.quote as { status: string }).status, "approved");
  const sent = await call(outcomeRoute, ownerHeaders, { params: { id }, body: { outcome: "sent" } });
  assert.equal((sent.body?.quote as { status: string }).status, "sent");
  assert.equal((await call(outcomeRoute, ownerHeaders, { params: { id }, body: { outcome: "void" } })).status, 200);
  refused(await call(outcomeRoute, ownerHeaders, { params: { id }, body: { outcome: "won" } }), 409, "QUOTE_CLOSED");

  const { timeline } = await quoteFor(await appCaller(ownerHeaders), id);
  assert.deepEqual(
    timeline.map((e) => [e.kind, e.by]),
    [
      ["created", "Sam Crew"],
      ["approved", "Pat Owner"],
      ["sent", "Pat Owner"],
      ["void", "Pat Owner"],
    ],
  );
  // Another business's quote never moved.
  const [other] = await db().select().from(quotesTable).where(eq(quotesTable.id, s.otherQuote.quoteId));
  assert.equal(other.status, "draft");
});

withTestDb("quotes: a super admin looking at a business sees every quote and can change none", async () => {
  const s = await seed();
  const headers = await superAdminViewing(TEST_ORG);
  const viewer = await appCaller(headers);
  assert.equal(viewer.memberId, null);
  assert.equal((await quotesFor(viewer, {})).quotes.length, 4);
  refused(await call(approveRoute, headers, { params: { id: s.ownerQuote.quoteId }, body: { revision: 1 } }), 403, "NOT_A_MEMBER");
  refused(await call(outcomeRoute, headers, { params: { id: s.ownerQuote.quoteId }, body: { outcome: "void" } }), 403, "NOT_A_MEMBER");
  const [row] = await db().select().from(quotesTable).where(eq(quotesTable.id, s.ownerQuote.quoteId));
  assert.equal(row.status, "draft");
});

withTestDb("quotes: the list pages through every quote, keeping tabs, search, and counts, the same for crew", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const ids: string[] = [];
  for (let i = 0; i < 58; i++) {
    const by = i < 3 ? crew : owner;
    const quote = await createQuote({ title: `${i + 1} Sample Ln`, lines: [{ itemId: item.id, quantity: 1 }] }, by, { post: quiet });
    ids.push(quote.quoteId);
  }
  // Newest last, a second apart, so the order is certain; 52 of the owner's are approved.
  for (const [i, id] of ids.entries()) {
    await db().update(quotesTable).set({ updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }).where(eq(quotesTable.id, id));
  }
  await db().update(quotesTable).set({ status: "approved" }).where(inArray(quotesTable.id, ids.slice(3, 55)));
  const newestFirst = [...ids].reverse();
  const ownerCaller = await appCaller(await signIn("+15555550101"));
  const crewCaller = await appCaller(await signIn("+15555550102"));
  const counts = { draft: 6, approved: 52 };

  const first = await quotesFor(ownerCaller, {});
  assert.equal(QUOTE_PAGE_SIZE, 50);
  assert.deepEqual(first.quotes.map((q) => q.quoteId), newestFirst.slice(0, 50));
  assert.deepEqual([first.from, first.hasOlder, first.hasNewer, first.matching], [1, true, false, 58]);
  assert.deepEqual(first.counts, counts);
  const second = await quotesFor(ownerCaller, { before: quoteCursor(first.quotes.at(-1)!) });
  assert.deepEqual(second.quotes.map((q) => q.quoteId), newestFirst.slice(50));
  assert.deepEqual([second.from, second.hasOlder, second.hasNewer, second.matching], [51, false, true, 58]);
  assert.deepEqual(second.counts, counts);
  const back = await quotesFor(ownerCaller, { after: quoteCursor(second.quotes[0]) });
  assert.deepEqual(back.quotes.map((q) => q.quoteId), newestFirst.slice(0, 50));
  assert.deepEqual([back.from, back.hasOlder, back.hasNewer], [1, true, false]);
  const past = await quotesFor(ownerCaller, { before: quoteCursor(second.quotes.at(-1)!) });
  assert.deepEqual([past.quotes.length, past.hasOlder], [0, false]);

  // A quote on the first page changes while someone is on it: the next page neither repeats nor skips one.
  await db().update(quotesTable).set({ updatedAt: new Date(Date.UTC(2026, 0, 2)) }).where(eq(quotesTable.id, newestFirst[10]));
  const afterChange = await quotesFor(ownerCaller, { before: quoteCursor(first.quotes.at(-1)!) });
  assert.deepEqual(afterChange.quotes.map((q) => q.quoteId), newestFirst.slice(50));
  await db().update(quotesTable).set({ updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 47)) }).where(eq(quotesTable.id, newestFirst[10]));

  // A status tab pages through its own quotes.
  const approved1 = await quotesFor(ownerCaller, { status: "approved" });
  const approved2 = await quotesFor(ownerCaller, { status: "approved", before: quoteCursor(approved1.quotes.at(-1)!) });
  assert.deepEqual([approved1.quotes.length, approved1.hasOlder, approved1.matching], [50, true, 52]);
  assert.deepEqual([approved2.quotes.length, approved2.hasOlder, approved2.from], [2, false, 51]);
  assert.ok([...approved1.quotes, ...approved2.quotes].every((q) => q.status === "approved"));
  assert.equal(new Set([...approved1.quotes, ...approved2.quotes].map((q) => q.quoteId)).size, 52);
  assert.deepEqual(approved2.counts, counts);

  // Search words page too; how many match isn't counted.
  const search1 = await quotesFor(ownerCaller, { query: "Sample" });
  const search2 = await quotesFor(ownerCaller, { query: "Sample", before: quoteCursor(search1.quotes.at(-1)!) });
  assert.deepEqual([search2.quotes.length, search2.hasOlder, search2.from, search2.matching], [8, false, 51, undefined]);
  const narrow = await quotesFor(ownerCaller, { query: "57 Sample" });
  assert.deepEqual(narrow.quotes.map((q) => q.title), ["57 Sample Ln"]);
  assert.equal(narrow.hasOlder, false);

  // Crew page through the same list.
  const crewFirst = await quotesFor(crewCaller, {});
  assert.deepEqual(crewFirst.quotes.map((q) => q.quoteId), newestFirst.slice(0, 50));
  assert.deepEqual([crewFirst.hasOlder, crewFirst.matching, crewFirst.counts], [true, 58, counts]);
  assert.deepEqual((await quotesFor(crewCaller, { before: quoteCursor(crewFirst.quotes.at(-1)!) })).quotes.map((q) => q.quoteId), newestFirst.slice(50));
  const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(quotesTable);
  assert.equal(n, 58);
});

test("quotes: a page cursor is a quote's change time and id, anything else is the first page", () => {
  assert.deepEqual(parseQuoteCursor("2026-01-01T00:00:05.123Z~quo_abc"), { at: "2026-01-01T00:00:05.123Z", id: "quo_abc" });
  const cursor = { at: "2026-01-01T00:00:05.123Z", id: "quo_abc" };
  assert.deepEqual(parseQuoteCursor(formatQuoteCursor(cursor)), cursor);
  for (const bad of [undefined, "", "2", "2026-01-01~quo_a", "2026-01-01T00:00:05.123Z~cus_a", "2026-13-45T00:00:05.123Z~quo_a", ["x"]]) {
    assert.equal(parseQuoteCursor(bad), undefined, String(bad));
  }
});

test("quotes: the before-and-after is plain unless outlines=1, and each has its own address", () => {
  const pair = { quoteId: "quo_a", version: 42 };
  assert.equal(beforeAfterHref(pair), "/api/quotes/quo_a/before-after?v=42");
  assert.equal(beforeAfterHref(pair, { outlines: true }), "/api/quotes/quo_a/before-after?v=42&outlines=1");
  assert.deepEqual(beforeAfterQuery.parse({ v: "42" }), { v: "42" });
  assert.deepEqual(beforeAfterQuery.parse({ v: "42", outlines: "1" }), { v: "42", outlines: true });
  assert.deepEqual(beforeAfterQuery.parse({ outlines: "0" }), { outlines: false });
  assert.throws(() => beforeAfterQuery.parse({ outlines: "yes" }), { name: "ZodError" });
});

test("quotes: the social post is a square with the call to action unless asked otherwise", () => {
  assert.equal(socialPostHref({ quoteId: "quo_a", version: 42 }, { format: "story", cta: false }), "/api/quotes/quo_a/post?v=42&format=story&cta=0");
  assert.deepEqual(socialPostQuery.parse({}), { format: "square", cta: true });
  assert.deepEqual(socialPostQuery.parse({ v: "42", format: "story", cta: "0" }), { v: "42", format: "story", cta: false });
  for (const bad of [{ format: "tall" }, { cta: "yes" }, { format: "" }]) assert.throws(() => socialPostQuery.parse(bad), { name: "ZodError" }, JSON.stringify(bad));
});

withTestDb("quotes: the social post is served to anyone on the team once the quote has a before-and-after", async () => {
  const s = await seed();
  const crewHeaders = await signIn("+15555550102");
  const get = (quoteId: string, query: string, headers = crewHeaders) =>
    postRoute(new Request(`${BASE_URL}/api/quotes/${quoteId}/post${query}`, { headers }), { params: Promise.resolve({ id: quoteId }) });

  assert.equal((await get(s.ownerQuote.quoteId, "")).status, 404, "no before-and-after yet");
  const photo = async (sourceKind: "quote_attachment" | "work_photo", background: string) =>
    db()
      .insert(pricedPhotos)
      .values({
        id: newId("ppho"),
        orgId: TEST_ORG,
        quoteId: s.ownerQuote.quoteId,
        revisionNumber: 1,
        sourceKind,
        sourceId: newId("src"),
        sourceUrl: await storeInboundAttachment("yard.jpg", "image/jpeg", await sharp({ create: { width: 400, height: 300, channels: 3, background } }).jpeg().toBuffer()),
        url: "fake://priced.png",
        width: 400,
        height: 300,
        regions: [{ lineIndex: 0, itemId: null, name: "Widget service", quantity: 10, unitLabel: "widget", totalCents: 12000, phrase: "widget", objects: [], located: false }],
      })
      .returning()
      .then(([row]) => row);
  await photo("quote_attachment", "#777777");
  const after = await photo("work_photo", "#3c8c3c");

  const { socialPost } = await quoteFor(await appCaller(crewHeaders), s.ownerQuote.quoteId);
  assert.ok(socialPost);
  assert.match(socialPost.captions.withoutCta, /^Before and after: widget service\.$/);
  const version = after.createdAt.getTime();
  assert.equal(socialPost.images.story.withoutCta, `/api/quotes/${s.ownerQuote.quoteId}/post?v=${version}&format=story&cta=0`);

  const story = await get(s.ownerQuote.quoteId, `?v=${version}&format=story&cta=0`);
  assert.equal(story.status, 200);
  assert.equal(story.headers.get("content-type"), "image/png");
  assert.match(story.headers.get("cache-control") ?? "", /immutable/);
  const size = await sharp(Buffer.from(await story.arrayBuffer())).metadata();
  assert.deepEqual([size.width, size.height], [1080, 1920]);
  assert.equal((await get(s.ownerQuote.quoteId, "")).headers.get("cache-control"), "no-store", "a square, never cached without its version");

  const bad = await get(s.ownerQuote.quoteId, "?format=tall");
  assert.deepEqual([bad.status, ((await bad.json()) as { code: string }).code], [400, "INVALID_INPUT"]);
  assert.equal((await get(s.otherQuote.quoteId, "")).status, 404);
  assert.equal((await get(s.ownerQuote.quoteId, "", new Headers())).status, 401);
});
