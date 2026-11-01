import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Uploaded photos are stored here instead of Vercel Blob.
const blobDir = mkdtempSync(join(tmpdir(), "gw-work-photos-"));
process.env.BLOB_LOCAL_DIR = blobDir;

import assert from "node:assert/strict";
import { messages } from "../../schema/schema";
import { saveCustomer } from "../../core/customers";
import { db, newId } from "../../core/db";
import { updateProfile } from "../../core/profile";
import { approveQuote, createQuote, getQuote, linkRecentAttachments, setQuoteOutcome } from "../../core/quotes";
import { saveItems } from "../../core/pricebook";
import { bookVisit, getVisit } from "../../core/scheduling";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { attachTextedWorkPhotos, listWorkPhotos, resolveWorkTarget } from "../../core/work-photos";
import type { Caller } from "../../core/members";
import { PUT as checklistRoute } from "../../app/api/work/[id]/checklist/route";
import { POST as photosRoute } from "../../app/api/work/[id]/photos/route";
import { DELETE as removeRoute, GET as photoRoute } from "../../app/api/work/[id]/photos/[photoId]/route";
import { workFor } from "./work";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

/** Monday, Oct 19, 2026, 8 AM in New York. */
const MONDAY_8AM = new Date("2026-10-19T12:00:00Z");
const MONDAY_10AM = new Date("2026-10-19T14:00:00Z");
const quiet = async () => ({ posted: true });

// A 1×1 PNG, as the work page's "Add photos" sends one.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

/** An owner, two crew, a customer, and Carlos's visit there Monday at 9. */
async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const carlos = await person("Carlos Crew", "member", "+15555550102");
  const ana = await person("Ana Crew", "member", "+15555550103");
  await updateProfile(TEST_ORG, { timeZone: "America/New_York" }, owner.memberId);
  const customer = await saveCustomer(TEST_ORG, { name: "Ada Sample", address: "12 Oak St" }, owner.memberId);
  const booked = await bookVisit(
    owner,
    { title: "12 Oak St windows", customerId: customer.id, propertyId: customer.properties[0].id, memberIds: [carlos.memberId], day: "2026-10-19", time: "09:00", allowOutsideHours: true },
    { now: MONDAY_8AM, post: quiet },
  );
  return { owner, carlos, ana, customer, jobId: booked.visit.jobId, visitId: booked.visit.visitId };
}

/** A photo the member texted the line. */
async function texted(member: Caller, name: string, at = new Date()): Promise<void> {
  const file = join(blobDir, name);
  writeFileSync(file, Buffer.from(PNG));
  await db().insert(messages).values({
    id: newId("msg"),
    orgId: TEST_ORG,
    memberId: member.memberId,
    phoneE164: member.phoneE164!,
    direction: "inbound",
    kind: "user",
    body: "",
    attachments: [{ type: "image", url: pathToFileURL(file).href, name, mimeType: "image/png" }],
    createdAt: at,
  });
}

async function upload(headers: Headers, jobId: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([Buffer.from(PNG)], "after.png", { type: "image/png" }));
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  const request = new Request(`http://localhost:3000/api/work/${jobId}/photos`, { method: "POST", headers: { cookie: headers.get("cookie") ?? "" }, body: form });
  const response = await photosRoute(request, { params: Promise.resolve({ id: jobId }) });
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

withTestDb("photos texted after a visit go on its work, once, and never also on a quote", async () => {
  const s = await seed();
  const since = new Date(Date.now() - 60_000);
  await texted(s.carlos, "after-1.png");
  await texted(s.carlos, "after-2.png");

  // Carlos is on one visit today: that's where they go.
  const resolved = await resolveWorkTarget(s.carlos, {}, MONDAY_10AM);
  assert.deepEqual(resolved, { target: { jobId: s.jobId, visitId: s.visitId } });
  assert.equal(await attachTextedWorkPhotos(s.carlos, (resolved as { target: { jobId: string; visitId: string } }).target, since, "after"), 2);
  assert.equal(await attachTextedWorkPhotos(s.carlos, { jobId: s.jobId }, since), 0, "the same photos aren't added twice");
  const photos = await listWorkPhotos(TEST_ORG, { jobId: s.jobId });
  assert.deepEqual(photos.map((p) => [p.name, p.visitId, p.description, p.addedByName]), [
    ["after-1.png", s.visitId, "after", "Carlos Crew"],
    ["after-2.png", s.visitId, "after", "Carlos Crew"],
  ]);

  // A quote made right after doesn't take them.
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], s.owner.memberId);
  const quote = await createQuote({ title: "5 Elm Rd", lines: [{ itemId: item.id, quantity: 1 }] }, s.carlos, { post: quiet });
  assert.equal(await linkRecentAttachments(TEST_ORG, quote.quoteId, s.carlos.memberId, since), 0);
  assert.equal((await getQuote(TEST_ORG, quote.quoteId))!.attachments.length, 0);

  // Ana isn't on it, but stopped by and finished it: her photos go on it too, named by visit.
  await texted(s.ana, "porch.png");
  assert.equal(await attachTextedWorkPhotos(s.ana, { visitId: s.visitId }, since), 1);
  assert.equal((await listWorkPhotos(TEST_ORG, { customerId: s.customer.id }))[0].name, "porch.png", "the customer's newest first");
});

withTestDb("with no visit today, or several, the assistant asks which work; a visit must be on the work named", async () => {
  const s = await seed();
  assert.deepEqual(await resolveWorkTarget(s.ana, {}, MONDAY_10AM), { choose: [] });
  await bookVisit(s.owner, { jobId: s.jobId, memberIds: [s.carlos.memberId], day: "2026-10-19", time: "14:00", allowOutsideHours: true }, { now: MONDAY_8AM, post: quiet });
  // Two visits today, and at 8 neither is under way: ask.
  const early = await resolveWorkTarget(s.carlos, {}, MONDAY_8AM);
  assert.ok("choose" in early && early.choose.length === 2);
  // At 9:30 the first one is under way.
  assert.deepEqual(await resolveWorkTarget(s.carlos, {}, new Date("2026-10-19T13:30:00Z")), { target: { jobId: s.jobId, visitId: s.visitId } });

  const other = await bookVisit(s.owner, { title: "Shed", memberIds: [s.ana.memberId], day: "2026-10-19", time: "15:00", allowOutsideHours: true }, { now: MONDAY_8AM, post: quiet });
  await assert.rejects(resolveWorkTarget(s.carlos, { jobId: s.jobId, visitId: other.visit.visitId }), /VISIT_NOT_FOUND/);
  await assert.rejects(resolveWorkTarget(s.carlos, { jobId: "sj_nope" }), /SERVICE_JOB_NOT_FOUND/);
});

withTestDb("the work's page: anyone adds photos; whoever added one, or an owner, takes it off", async () => {
  const s = await seed();
  const carlosHeaders = await signIn(s.carlos.phoneE164!);
  const anaHeaders = await signIn(s.ana.phoneE164!);
  const ownerHeaders = await signIn(s.owner.phoneE164!);

  const added = await upload(anaHeaders, s.jobId, { visitId: s.visitId });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const photoId = String(added.body?.photoId);
  const page = await workFor(await appCaller(carlosHeaders), s.jobId);
  assert.equal(page.job.title, "12 Oak St windows");
  assert.deepEqual(page.photos.map((p) => [p.id, p.visitId, p.canRemove]), [[photoId, s.visitId, false]]);
  assert.equal(page.canAddPhotos, true);
  assert.equal((await workFor(await appCaller(anaHeaders), s.jobId)).photos[0].canRemove, true);

  const served = await call(photoRoute, carlosHeaders, { params: { id: s.jobId, photoId } });
  assert.equal(served.status, 200);
  assert.equal(served.response.headers.get("content-type"), "image/png");

  refused(await call(removeRoute, carlosHeaders, { method: "DELETE", params: { id: s.jobId, photoId } }), 403, "NOT_PRIVILEGED");
  assert.equal((await call(removeRoute, ownerHeaders, { method: "DELETE", params: { id: s.jobId, photoId } })).status, 200);
  assert.equal((await workFor(await appCaller(ownerHeaders), s.jobId)).photos.length, 0);
  refused(await call(photoRoute, carlosHeaders, { params: { id: s.jobId, photoId } }), 404);

  // Not a photo, a visit on other work, someone looking in, another business.
  const form = new FormData();
  form.append("file", new File([Buffer.from("not an image")], "notes.txt", { type: "text/plain" }));
  const junk = await photosRoute(
    new Request(`http://localhost:3000/api/work/${s.jobId}/photos`, { method: "POST", headers: { cookie: carlosHeaders.get("cookie") ?? "" }, body: form }),
    { params: Promise.resolve({ id: s.jobId }) },
  );
  assert.equal(junk.status, 415);
  const other = await bookVisit(s.owner, { title: "Shed", memberIds: [s.ana.memberId], day: "2026-10-19", time: "15:00", allowOutsideHours: true }, { now: MONDAY_8AM, post: quiet });
  refused(await upload(carlosHeaders, s.jobId, { visitId: other.visit.visitId }), 400, "VISIT_NOT_FOUND");
  refused(await upload(await superAdminViewing(TEST_ORG), s.jobId), 403, "NOT_A_MEMBER");
  const elsewhere = await otherBusiness();
  const outsider = await person("Lee Outsider", "owner", "+15555550109", elsewhere);
  refused(await upload(await signIn(outsider.phoneE164!), s.jobId), 404);
});

withTestDb("the work's page lists its checklist, and anyone on the team ticks it; the last tick marks the visit done", async () => {
  const s = await seed();
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], s.owner.memberId);
  const quote = await createQuote({ title: "5 Elm Rd", customerId: s.customer.id, lines: [{ itemId: item.id, quantity: 2 }] }, s.owner, { post: quiet });
  await approveQuote(quote.quoteId, s.owner, { post: quiet });
  await setQuoteOutcome(quote.quoteId, "won", s.owner, { post: quiet });
  const booked = await bookVisit(s.owner, { quoteId: quote.quoteId, memberIds: [s.carlos.memberId], day: "2026-10-19", time: "11:00", allowOutsideHours: true }, { now: MONDAY_8AM, post: quiet });
  const carlosHeaders = await signIn(s.carlos.phoneE164!);

  assert.equal((await workFor(await appCaller(carlosHeaders), s.jobId)).checklist, null, "work with no quote has no list");
  const page = await workFor(await appCaller(carlosHeaders), booked.visit.jobId);
  assert.deepEqual(page.checklist && { ...page.checklist, items: page.checklist.items.map((i) => i.text) }, {
    items: ["widget service, 2 widgets"],
    done: 0,
    total: 1,
    photoHrefs: [],
    canTick: true,
  });
  const itemId = page.checklist!.items[0].itemId;
  const params = { id: booked.visit.jobId };

  refused(await call(checklistRoute, carlosHeaders, { method: "PUT", params, body: { itemIds: ["chk_nope"] } }), 404, "CHECKLIST_ITEM_NOT_FOUND");
  refused(await call(checklistRoute, await superAdminViewing(TEST_ORG), { method: "PUT", params, body: { itemIds: [itemId] } }), 403, "NOT_A_MEMBER");
  const outsider = await person("Lee Outsider", "owner", "+15555550109", await otherBusiness());
  refused(await call(checklistRoute, await signIn(outsider.phoneE164!), { method: "PUT", params, body: { itemIds: [itemId] } }), 404);

  const ticked = await call(checklistRoute, carlosHeaders, { method: "PUT", params, body: { itemIds: [itemId] } });
  assert.equal(ticked.status, 200, JSON.stringify(ticked.body));
  assert.deepEqual(ticked.body, { allDone: true, visitCompleted: true });
  assert.equal((await getVisit(s.owner, booked.visit.visitId))?.status, "completed");
  const after = await workFor(await appCaller(carlosHeaders), booked.visit.jobId);
  assert.equal(after.checklist?.done, 1);
  assert.equal(after.checklist?.items[0].doneByName, "Carlos Crew");

  const unticked = await call(checklistRoute, carlosHeaders, { method: "PUT", params, body: { itemIds: [itemId], undo: true } });
  assert.deepEqual(unticked.body, { allDone: false, visitCompleted: false });
});
