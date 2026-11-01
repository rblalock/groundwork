// The priced photo: a quote's photo with each quoted thing outlined by SAM and labeled with its line's
// quantity and price, and a legend of its lines under it. Nothing here measures anything: quantities
// and prices come from the quote. A quote with several photos has one per photo, numbered in attachment
// order: each legend lists the lines its photo shows and the other photos that show them too, and the
// lines no photo shows are listed once, on the last, so no line reads as counted twice. Making one again
// replaces it, except within `RERENDER_MS` of the last render of the same revision, which comes back
// instead. When the business hides line prices from customers, the quote's link shows a second copy
// labeled with quantities only, drawn beside the first from the same masks. Every object SAM found is
// kept as a candidate with its outline (once, when two phrases found the same object), so a member can
// move objects between lines and both copies are drawn again without SAM. A member can outline by hand
// what SAM never finds; that outline is kept as a candidate like the rest.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import sharp, { type OverlayOptions } from "sharp";
import { members, pricedPhotos, quoteAttachments, quoteRevisions, quotes, serviceJobs, workPhotos } from "../schema/schema";
import type { PricedBox, PricedCandidate, PricedRegion } from "../schema/types";
import { deleteBlob, readStoredFile, storeInboundAttachment } from "./blob";
import { db, newId } from "./db";
import { MAX_PIXELS } from "./images";
import type { Language } from "./language";
import type { Caller } from "./members";
import { NOTO_SANS_BOLD_BASE64 } from "./fonts/noto-sans-bold";
import { formatCents } from "./money";
import { listItems } from "./pricebook";
import {
  addToLine,
  applyAssignments,
  candidatesFrom,
  centeredIn,
  distinctCandidates,
  DRAWN_PHRASE,
  drawnCandidate,
  MAX_PROMPT_POINTS,
  newCandidates,
  offLines,
  sameBox,
  selectRegions,
  SELECTED_PHRASE,
  withKept,
  type Assignment,
  type PhotoLine,
} from "./priced-photo-select";
import { getQuote } from "./quotes";
import { SAM_MODEL, segment, segmentMany, segmentObjects, type SamObject, type SamPrompt } from "./sam";
import { pluralUnit } from "./units";
import { recordModelCall } from "./usage";

export type PricedPhoto = typeof pricedPhotos.$inferSelect;
export type PricedPhotoSource = { kind: "quote_attachment" | "work_photo"; id: string };

export type PricedPhotoResult =
  | { pricedPhotoId: string; url: string; regions: PricedRegion[]; located: number; notLocated: string[] }
  | { pricedPhotoId: null; reason: "no_photo" | "unreadable_photo" | "photo_too_small" | "quote_not_found" | "no_lines" };

/** The photo is scaled down to this long side before SAM sees it and before drawing. */
const MAX_SIDE = 1600;
/** A photo narrower than this has no room for readable labels. */
const MIN_WIDTH = 320;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png"]);
const PHOTO_NAME = /\.(jpe?g|png)$/i;
/** A render of the same quote revision and photo this recent is returned instead of made again. */
export const RERENDER_MS = 10_000;

/** Whether `previous` is recent enough, for the same revision, that rendering again would only repeat it. */
export function rerenderTooSoon(previous: { revisionNumber: number; createdAt: Date }, revisionNumber: number, now: Date): boolean {
  return previous.revisionNumber === revisionNumber && now.getTime() - previous.createdAt.getTime() < RERENDER_MS;
}

/**
 * Makes (or makes again) the priced photo for a quote: from the photo given, or else the quote's most
 * recent JPEG or PNG. Every active item's photo prompt is looked for, so a member can later put what SAM
 * found on a line it missed, but each line starts with only its own prompt's objects; the rest, and any
 * SAM can't find, stay on the legend as not located. Made again for the same photo, a phrase already found
 * there isn't sent to SAM again. A photo of the quote's own is drawn with its place among the quote's
 * other priced photos (`PhotoPlace`), and those whose legends that changes are drawn again, without SAM.
 * Throws when every SAM call fails.
 */
export async function createPricedPhoto(caller: Caller, input: { quoteId: string; source?: PricedPhotoSource }): Promise<PricedPhotoResult> {
  const { orgId } = caller;
  const quote = await getQuote(orgId, input.quoteId);
  if (!quote) return { pricedPhotoId: null, reason: "quote_not_found" };
  if (quote.lines.length === 0) return { pricedPhotoId: null, reason: "no_lines" };
  const source = await findSource(orgId, quote.quoteId, input.source);
  if (!source) return { pricedPhotoId: null, reason: "no_photo" };
  const looked = await lookAt(caller, quote, source);
  if ("reason" in looked) return { pricedPhotoId: null, reason: looked.reason };
  if ("kept" in looked) return resultOf(looked.kept.id, looked.kept.url, looked.kept.regions);
  if (source.kind === "work_photo") return save(caller, quote, looked.looked, undefined);
  const [result] = await saveSet(caller, quote, await photoSet(orgId, quote.quoteId), [looked.looked]);
  return result;
}

/** How one of the quote's photos went when they were all priced: its number among the priced ones and the lines it shows, or why it was left out. */
export type PhotoPricing =
  | { attachmentId: string; number: number; pricedPhotoId: string; url: string; located: string[] }
  | { attachmentId: string; number: null; pricedPhotoId: null; reason: "unreadable_photo" | "photo_too_small" | "failed" };

export type PricedPhotosResult =
  | {
      /** Every photo on the quote, in attachment order. */
      photos: PhotoPricing[];
      /** Each line, and the numbers of the priced photos it was located in. */
      lines: Array<{ name: string; photos: number[] }>;
      /** The lines located in none of them. */
      notLocated: string[];
    }
  | { photos: null; reason: Exclude<PricedPhotoResult, { pricedPhotoId: string }>["reason"] };

/**
 * Prices every photo attached to the quote, in attachment order, one SAM look at a time, then draws
 * them as one set: each legend lists the lines its photo shows and notes the other photos that show them
 * too, and the lines no photo shows are listed on the last. A photo that can't be read or priced is left
 * out and the rest go on; when none could be, its reason comes back, or the error when SAM failed.
 * Nothing is measured: every line keeps the quote's quantity, once.
 */
export async function pricePhotos(caller: Caller, input: { quoteId: string }): Promise<PricedPhotosResult> {
  const { orgId } = caller;
  const quote = await getQuote(orgId, input.quoteId);
  if (!quote) return { photos: null, reason: "quote_not_found" };
  if (quote.lines.length === 0) return { photos: null, reason: "no_lines" };
  const sources = await quoteSources(orgId, quote.quoteId);
  if (sources.length === 0) return { photos: null, reason: "no_photo" };
  const set = await photoSet(orgId, quote.quoteId);
  const looked: Looked[] = [];
  const skipped = new Map<string, { reason: "unreadable_photo" | "photo_too_small" | "failed"; error?: unknown }>();
  for (const source of sources) {
    const result = await lookAt(caller, quote, source).catch((error: unknown) => ({ reason: "failed" as const, error }));
    if ("reason" in result) skipped.set(source.id, result);
    else if ("looked" in result) looked.push(result.looked);
  }
  if (looked.length) await saveSet(caller, quote, set, looked);
  const final = await photoSet(orgId, quote.quoteId);
  const priced = new Map(final.map((entry, i) => [entry.row.sourceId, { row: entry.row, number: i + 1 }]));
  const photos = sources.map((source): PhotoPricing => {
    const skip = skipped.get(source.id);
    const entry = priced.get(source.id);
    if (skip || !entry) return { attachmentId: source.id, number: null, pricedPhotoId: null, reason: skip?.reason ?? "failed" };
    return { attachmentId: source.id, number: entry.number, pricedPhotoId: entry.row.id, url: entry.row.url, located: entry.row.regions.filter((r) => r.located).map((r) => r.name) };
  });
  if (!photos.some((photo) => photo.pricedPhotoId)) {
    const failed = [...skipped.values()].find((skip) => skip.reason === "failed");
    if (failed) throw failed.error;
    return { photos: null, reason: [...skipped.values()][0]?.reason === "photo_too_small" ? "photo_too_small" : "unreadable_photo" };
  }
  const lines = quote.lines.map((line, lineIndex) => ({
    name: line.name,
    photos: final.flatMap((entry, i) => (entry.row.regions.some((r) => r.lineIndex === lineIndex && r.located) ? [i + 1] : [])),
  }));
  return { photos, lines, notLocated: lines.filter((line) => line.photos.length === 0).map((line) => line.name) };
}

type Quote = NonNullable<Awaited<ReturnType<typeof getQuote>>>;

/** A photo SAM has looked at for the quote's lines, ready to draw and save. */
type Looked = { source: Source; before: PricedPhoto | undefined; photo: Photo; regions: PricedRegion[]; candidates: PricedCandidate[] };

/**
 * Looks for the quote's lines on one photo (`createPricedPhoto`). A render of the same revision made
 * moments ago comes back `kept` instead (`rerenderTooSoon`). Throws when every SAM call fails.
 */
async function lookAt(
  caller: Caller,
  quote: Quote,
  source: Source,
): Promise<{ looked: Looked } | { kept: PricedPhoto } | { reason: "unreadable_photo" | "photo_too_small" }> {
  const { orgId } = caller;
  const [before] = await db()
    .select()
    .from(pricedPhotos)
    .where(and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quote.quoteId), eq(pricedPhotos.sourceUrl, source.url)));
  if (before && rerenderTooSoon(before, quote.revisionNumber, new Date())) return { kept: before };
  const photo = await preparePhoto(source.url);
  if (!photo) return { reason: "unreadable_photo" };
  if (photo.width < MIN_WIDTH) return { reason: "photo_too_small" };

  const priceBook = await listItems(orgId, { includeRetired: true });
  const items = new Map(priceBook.map((item) => [item.id, item]));
  const lines: PhotoLine[] = quote.lines.map((line, index) => {
    const item = line.itemId ? items.get(line.itemId) : undefined;
    return {
      index,
      itemId: line.itemId,
      name: line.name,
      quantity: line.quantity,
      unitKind: item?.unitKind ?? null,
      unitLabel: line.unitLabel,
      totalCents: line.totalCents,
      phrase: item?.photoPrompt?.trim() || null,
    };
  });
  const kept = before?.candidates ?? [];
  const prompts = [
    ...lines.flatMap((line) => (line.phrase ? [line.phrase] : [])),
    ...priceBook.flatMap((item) => (item.status === "active" && item.photoPrompt?.trim() ? [item.photoPrompt.trim()] : [])),
  ];
  // An outline drawn by hand under a line's name doesn't stand for SAM's look for a phrase.
  const phrases = [...new Set(prompts)].filter((phrase) => !kept.some((c) => c.source !== "hand" && c.phrase === phrase));
  const calls: Array<{ phrase: string; images: number }> = [];
  const found =
    phrases.length > 0
      ? await segmentMany({ bytes: photo.bytes, mimeType: "image/jpeg" }, phrases, { size: photo, onCall: (call) => calls.push(call) })
      : new Map<string, SamObject[]>();
  await recordSamCalls(caller, quote.quoteId, calls);
  const all = [...kept, ...[...found].flatMap(([phrase, objects]) => candidatesFrom(phrase, objects, () => newId("cand")))];
  // One candidate per object; a phrase whose object went to another phrase's candidate still finds it there.
  const { kept: candidates, same } = distinctCandidates(all);
  const byPhrase = new Map<string, PricedCandidate[]>();
  for (const candidate of all) {
    const object = same.get(candidate.id) ?? candidate;
    const listed = byPhrase.get(candidate.phrase) ?? [];
    if (!listed.includes(object)) byPhrase.set(candidate.phrase, [...listed, object]);
  }
  return { looked: { source, before, photo, regions: selectRegions(lines, byPhrase, photo), candidates } };
}

/** Draws a looked-at photo with its place, if it has one, and saves it in place of the one before it. */
async function save(caller: Caller, quote: Quote, looked: Looked, place: PhotoPlace | undefined): Promise<PricedPhotoResult> {
  const { source, before, photo, regions, candidates } = looked;
  const rendered = await renderBoth(photo, regions, candidates, { quoteId: quote.quoteId, totalCents: quote.totalCents, language: quote.customerLanguage }, place);
  const values = {
    revisionNumber: quote.revisionNumber,
    sourceKind: source.kind,
    sourceId: source.id,
    ...rendered,
    photoHeight: photo.height,
    regions,
    candidates,
    memberId: caller.memberId,
    createdAt: new Date(),
    editedBy: null,
    editedAt: null,
  };
  const [row] = await db()
    .insert(pricedPhotos)
    .values({ id: newId("ppho"), orgId: caller.orgId, quoteId: quote.quoteId, sourceUrl: source.url, ...values })
    .onConflictDoUpdate({ target: [pricedPhotos.orgId, pricedPhotos.quoteId, pricedPhotos.sourceUrl], set: values })
    .returning({ id: pricedPhotos.id });
  if (before) await deleteRenders(before, rendered);
  return resultOf(row.id, rendered.url, regions);
}

/**
 * Saves `looked` (photos of the quote's own) into the quote's set of priced photos: each drawn with its
 * place in the set as it will be, and each other photo of the set whose legend that changes drawn again
 * from its kept outlines. Results in the order of `looked`.
 */
async function saveSet(caller: Caller, quote: Quote, set: SetEntry[], looked: Looked[]): Promise<PricedPhotoResult[]> {
  const { before, after } = replan(
    set,
    looked.map((l) => ({ sourceId: l.source.id, attachedAt: l.source.attachedAt ?? new Date(), regions: l.regions })),
  );
  const results: PricedPhotoResult[] = [];
  for (const l of looked) results.push(await save(caller, quote, l, after.get(l.source.id)));
  await redrawStale(set, new Set(looked.map((l) => l.source.id)), before, after);
  return results;
}

type Renders = { url: string; customerUrl: string | null };

/**
 * Draws the priced copy and the quantity-only copy of `regions` on the photo, each object by its
 * candidate's outline, and stores both. The quantity-only copy is drawn every time so the business can
 * hide line prices later and the link still has a photo to show. `place` is the photo's among the
 * quote's priced photos, for its legend.
 */
async function renderBoth(
  photo: Photo,
  regions: PricedRegion[],
  candidates: PricedCandidate[],
  quote: { quoteId: string; totalCents: number; language: Language },
  place: PhotoPlace | undefined,
): Promise<{ url: string; customerUrl: string; width: number; height: number }> {
  const paths = maskPaths(regions, candidates);
  const png = await renderOverlay(photo, regions, paths, quote.totalCents, quote.language, { place });
  const url = await storeInboundAttachment(`priced-${quote.quoteId}.png`, "image/png", png.png);
  const customerUrl = await storeInboundAttachment(
    `priced-${quote.quoteId}-customer.png`,
    "image/png",
    (await renderOverlay(photo, regions, paths, quote.totalCents, quote.language, { linePrices: false, place })).png,
  );
  return { url, customerUrl, width: png.width, height: png.height };
}

/**
 * The priced photo as the crew get it: each line labeled with its quantity, and no prices or total.
 * Drawn from the kept outlines, without SAM, in the reader's language, with its `place` among the quote's
 * priced photos when it has one. Null when the photo can't be read.
 */
export async function crewCopy(row: PricedPhoto, language: Language, place?: PhotoPlace): Promise<Uint8Array | null> {
  const photo = await preparePhoto(row.sourceUrl);
  if (!photo) return null;
  const drawn = await renderOverlay(photo, row.regions, maskPaths(row.regions, row.candidates), 0, language, { linePrices: false, total: false, place });
  return drawn.png;
}

/** Deletes the renders `old` had that `kept` doesn't. A failure only logs. */
async function deleteRenders(old: Renders, kept: Renders): Promise<void> {
  for (const url of [old.url, old.customerUrl]) {
    if (url && url !== kept.url && url !== kept.customerUrl) await deleteBlob(url).catch((error) => console.error("priced photo: deleting the old render failed", error));
  }
}

function resultOf(pricedPhotoId: string, url: string, regions: PricedRegion[]): PricedPhotoResult {
  return {
    pricedPhotoId,
    url,
    regions,
    located: regions.filter((region) => region.located).length,
    notLocated: regions.filter((region) => !region.located).map((region) => region.name),
  };
}

/** One usage receipt per answered SAM call, billed by the image, for the quote it priced. A failure only logs. */
async function recordSamCalls(caller: Caller, quoteId: string, calls: Array<{ phrase: string; images: number }>): Promise<void> {
  const usage = { kind: "sam", inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: null, responseId: null, responseModel: null } as const;
  await Promise.all(
    calls.map((call) =>
      recordModelCall(
        { orgId: caller.orgId, memberId: caller.memberId, conversationId: null, reservationId: null, channel: "other", callId: `${quoteId}:${crypto.randomUUID()}` },
        { ...usage, images: call.images },
        { deployment: SAM_MODEL },
      ),
    ),
  ).catch((error) => console.error("priced photo: SAM usage was not recorded", { quoteId, error }));
}

/** A short tag of a render's stored address, which changes each time the photo is drawn: for addresses that must change with it. */
export const renderTag = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 8);

/** The quote's priced photos, newest first. */
export function pricedPhotosFor(orgId: string, quoteId: string): Promise<PricedPhoto[]> {
  return db()
    .select()
    .from(pricedPhotos)
    .where(and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quoteId)))
    .orderBy(desc(pricedPhotos.createdAt), desc(pricedPhotos.id));
}

// ---------------------------------------------------------------------------------------------
// The quote's own photos as a set: numbered in attachment order, each legend listing what its photo
// shows, and the lines no photo shows listed once, on the last

/**
 * A photo's place among the quote's priced photos of its own: its number (in attachment order), how
 * many there are, and for each line the numbers of the photos that locate it.
 */
export type PhotoPlace = { number: number; count: number; locatedIn: Map<number, number[]> };

/** Each photo's place, for photos given in attachment order. Pure. */
export function photoPlaces(photos: Array<{ regions: Array<Pick<PricedRegion, "lineIndex" | "located">> }>): PhotoPlace[] {
  const locatedIn = new Map<number, number[]>();
  photos.forEach((photo, i) => {
    for (const region of photo.regions) {
      const numbers = locatedIn.get(region.lineIndex) ?? [];
      if (region.located && !numbers.includes(i + 1)) locatedIn.set(region.lineIndex, [...numbers, i + 1]);
    }
  });
  return photos.map((_, i) => ({ number: i + 1, count: photos.length, locatedIn }));
}

/** One line of a photo's legend: the other photos that show it too, or that no photo shows it. */
export type LegendLine = { region: PricedRegion; alsoIn: number[]; notLocated: boolean };

/**
 * The lines a photo's legend lists. With no place (a photo alone, or a work photo), every line, located
 * or not. Among the quote's photos, the lines this one locates, each with the other photos that locate
 * it too; a line no photo locates is listed on the last photo only. Pure.
 */
export function legendLines(regions: PricedRegion[], place?: PhotoPlace): LegendLine[] {
  return regions.flatMap((region): LegendLine[] => {
    const numbers = place?.locatedIn.get(region.lineIndex) ?? [];
    if (region.located) return [{ region, alsoIn: numbers.filter((n) => n !== place?.number), notLocated: false }];
    return !place || (numbers.length === 0 && place.number === place.count) ? [{ region, alsoIn: [], notLocated: true }] : [];
  });
}

/** What a photo's legend says, as a key: a photo whose key changed is drawn again. */
const legendKey = (regions: PricedRegion[], place: PhotoPlace | undefined) =>
  JSON.stringify([
    place && place.count > 1 ? [place.number, place.count] : null,
    legendLines(regions, place).map((line) => [line.region.lineIndex, line.alsoIn, line.notLocated]),
  ]);

/** "2", "1 and 3", "1, 2 and 3"; "1 y 3" in Spanish. */
export function numberList(numbers: number[], language: Language): string {
  if (numbers.length < 2) return numbers.join("");
  return `${numbers.slice(0, -1).join(", ")}${language === "es" ? " y " : " and "}${numbers.at(-1)}`;
}

type SetEntry = { row: PricedPhoto; attachedAt: Date };
type SetPhoto = { sourceId: string; attachedAt: Date; regions: PricedRegion[] };

/**
 * The quote's priced photos of its own photos, in the order the photos were attached, with when each
 * was; none of a photo taken off the quote.
 */
async function photoSet(orgId: string, quoteId: string): Promise<SetEntry[]> {
  const attachedAt = sql<Date>`coalesce(${quoteAttachments.createdAt}, ${pricedPhotos.createdAt})`;
  const rows = await db()
    .select({ row: pricedPhotos, attachedAt: quoteAttachments.createdAt })
    .from(pricedPhotos)
    .leftJoin(
      quoteAttachments,
      and(eq(quoteAttachments.orgId, orgId), eq(quoteAttachments.quoteId, quoteId), eq(quoteAttachments.id, pricedPhotos.sourceId)),
    )
    .where(
      and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quoteId), eq(pricedPhotos.sourceKind, "quote_attachment"), isNull(quoteAttachments.removedAt)),
    )
    .orderBy(asc(attachedAt), asc(pricedPhotos.sourceId));
  return rows.map(({ row, attachedAt }) => ({ row, attachedAt: attachedAt ?? row.createdAt }));
}

/** The quote's priced photos of its own photos, in attachment order, each with its place among them. */
export async function quotePricedPhotos(orgId: string, quoteId: string): Promise<Array<PricedPhoto & { place: PhotoPlace }>> {
  const rows = (await photoSet(orgId, quoteId)).map((entry) => entry.row);
  const places = photoPlaces(rows);
  return rows.map((row, i) => ({ ...row, place: places[i] }));
}

/** Places by source, for photos in any order: sorted by when each was attached. */
function placesBySource(photos: SetPhoto[]): Map<string, PhotoPlace> {
  const sorted = [...photos].sort((a, b) => a.attachedAt.getTime() - b.attachedAt.getTime() || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  const places = photoPlaces(sorted);
  return new Map(sorted.map((photo, i) => [photo.sourceId, places[i]]));
}

/** The set's places as it is, and as it will be with `changed` in place of (or beside) its photos. */
function replan(set: SetEntry[], changed: SetPhoto[]): { before: Map<string, PhotoPlace>; after: Map<string, PhotoPlace> } {
  const now = set.map((entry) => ({ sourceId: entry.row.sourceId, attachedAt: entry.attachedAt, regions: entry.row.regions }));
  const ids = new Set(changed.map((photo) => photo.sourceId));
  return { before: placesBySource(now), after: placesBySource([...now.filter((photo) => !ids.has(photo.sourceId)), ...changed]) };
}

/** Draws again each photo of the set, other than `changed`, whose legend the new places change. */
async function redrawStale(set: SetEntry[], changed: Set<string>, before: Map<string, PhotoPlace>, after: Map<string, PhotoPlace>): Promise<void> {
  for (const { row } of set) {
    if (changed.has(row.sourceId)) continue;
    if (legendKey(row.regions, before.get(row.sourceId)) !== legendKey(row.regions, after.get(row.sourceId))) await redraw(row, after.get(row.sourceId));
  }
}

/**
 * Draws a priced photo again from its kept outlines, with no SAM call, for a change on another photo of
 * the quote: not an edit of this one, so who edited it and when stay. Lands only on the row as it was
 * read. A failure only logs.
 */
async function redraw(row: PricedPhoto, place: PhotoPlace | undefined): Promise<void> {
  try {
    const photo = await readPhoto(row);
    const rendered = await renderBoth(photo, row.regions, row.candidates, { quoteId: row.quoteId, ...(await revisionOf(row)) }, place);
    const [saved] = await db()
      .update(pricedPhotos)
      .set(rendered)
      .where(and(eq(pricedPhotos.orgId, row.orgId), eq(pricedPhotos.id, row.id), eq(pricedPhotos.url, row.url)))
      .returning({ id: pricedPhotos.id });
    await deleteRenders(saved ? row : rendered, saved ? rendered : { url: "", customerUrl: null });
  } catch (error) {
    console.error("priced photo: drawing another photo of the quote again failed", { pricedId: row.id, error });
  }
}

/** The priced photos on a customer's quotes, newest first: their price guide. */
export async function pricedPhotosForCustomer(orgId: string, customerId: string, limit = 24): Promise<Array<PricedPhoto & { quoteTitle: string }>> {
  const rows = await db()
    .select({ photo: pricedPhotos, quoteTitle: quotes.title })
    .from(pricedPhotos)
    .innerJoin(quotes, and(eq(quotes.orgId, orgId), eq(quotes.id, pricedPhotos.quoteId)))
    .where(and(eq(pricedPhotos.orgId, orgId), eq(quotes.customerId, customerId)))
    .orderBy(desc(pricedPhotos.createdAt), desc(pricedPhotos.id))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map(({ photo, quoteTitle }) => ({ ...photo, quoteTitle }));
}

// ---------------------------------------------------------------------------------------------
// Editing: moving the kept candidates between lines, asking SAM for one more phrase or one boxed
// object, and outlining by hand

/** A priced photo on the quote, with the name of the member who last edited it; null when the quote has no such photo. */
export async function pricedPhotoOnQuote(orgId: string, quoteId: string, pricedId: string): Promise<(PricedPhoto & { editedByName: string | null }) | null> {
  const [row] = await db()
    .select({ photo: pricedPhotos, editedByName: members.name })
    .from(pricedPhotos)
    .leftJoin(members, and(eq(members.orgId, orgId), eq(members.id, pricedPhotos.editedBy)))
    .where(and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quoteId), eq(pricedPhotos.id, pricedId)));
  return row ? { ...row.photo, editedByName: row.editedByName } : null;
}

/** The photo's own size, which its candidates are in; read from the photo for one made before that was kept. Null when it can't be read. */
export async function pricedPhotoSize(photo: PricedPhoto): Promise<{ width: number; height: number } | null> {
  if (photo.photoHeight !== null) return { width: photo.width, height: photo.photoHeight };
  const read = await preparePhoto(photo.sourceUrl);
  return read && { width: read.width, height: read.height };
}

/** The longest phrase a member may ask SAM to look for. */
export const MAX_FIND_PHRASE = 60;

/**
 * Puts each candidate on the lines a member assigned it to, and on no other line, then draws both copies
 * again from the kept outlines, with no SAM call. Throws `UNKNOWN_CANDIDATE` or `UNKNOWN_LINE` for an
 * assignment the photo can't take, `PRICED_PHOTO_NOT_FOUND`, `UNREADABLE_PHOTO`, or
 * `PRICED_PHOTO_CHANGED` when another change landed while this one was drawn.
 */
export async function assignPricedPhoto(caller: Caller, quoteId: string, pricedId: string, assignments: Assignment[]): Promise<PricedPhoto> {
  const row = await editable(caller.orgId, quoteId, pricedId);
  const regions = applyAssignments(row.candidates, row.regions, assignments);
  return saveEdit(caller, row, await readPhoto(row), regions, row.candidates);
}

/**
 * What a member asks SAM for on a priced photo: a phrase, kept inside `box` when one is given; or, with
 * no phrase, the one object `box` and `points` name, in place of the candidate `replace` when an earlier
 * ask of the same box found the wrong thing.
 */
export type FindAsk = { phrase?: string; box?: PricedBox; points?: SamPrompt["points"]; lineIndex?: number; replace?: string };

/**
 * Asks SAM once on the photo (`FindAsk`), keeps what it finds as new candidates, and puts them on the
 * line at `lineIndex` when one is given; then draws both copies again. A boxed object is kept under the
 * line's name, or `SELECTED_PHRASE` with no line. `found` counts the candidates added: an object already
 * kept for the phrase isn't added twice, one kept under another phrase is added only in place of it when
 * SAM is surer of it now (`distinctCandidates`), and with none added (and none replaced) nothing is
 * drawn. `candidateIds` is what SAM found as it's kept: each new candidate, or the one kept already in its
 * place. Throws `BAD_PHRASE`, `BAD_PROMPT`, `UNKNOWN_LINE`, `UNKNOWN_CANDIDATE` (`replace` isn't an
 * object SAM found on the photo), `SAM_FAILED`, and what `assignPricedPhoto` throws.
 */
export async function findInPricedPhoto(
  caller: Caller,
  quoteId: string,
  pricedId: string,
  ask: FindAsk,
): Promise<{ photo: PricedPhoto; found: number; candidateIds: string[] }> {
  const phrase = ask.phrase?.trim() ?? "";
  const boxed = phrase.length === 0 && ask.box !== undefined;
  if (!boxed && (phrase.length === 0 || phrase.length > MAX_FIND_PHRASE)) throw new Error("BAD_PHRASE");
  // SAM takes a phrase or an object prompt, never both.
  if (!boxed && (ask.points?.length || ask.replace !== undefined)) throw new Error("BAD_PROMPT: points with a phrase");
  if ((ask.points?.length ?? 0) > MAX_PROMPT_POINTS) throw new Error("BAD_PROMPT: too many points");
  const row = await editable(caller.orgId, quoteId, pricedId);
  const region = ask.lineIndex === undefined ? undefined : row.regions.find((r) => r.lineIndex === ask.lineIndex);
  if (ask.lineIndex !== undefined && !region) throw new Error(`UNKNOWN_LINE: ${ask.lineIndex}`);
  const replaced = ask.replace === undefined ? undefined : row.candidates.find((c) => c.id === ask.replace);
  if (ask.replace !== undefined && (!replaced || replaced.source === "hand")) throw new Error(`UNKNOWN_CANDIDATE: ${ask.replace}`);
  const before = replaced ? row.candidates.filter((c) => c !== replaced) : row.candidates;
  const photo = await readPhoto(row);
  const image = { bytes: photo.bytes, mimeType: "image/jpeg" };
  const name = boxed ? (region?.name ?? SELECTED_PHRASE) : phrase;
  const call = boxed ? await segmentObjects(image, { box: ask.box, points: ask.points }, { size: photo }) : await segment(image, phrase, { size: photo });
  await recordSamCalls(caller, quoteId, [{ phrase: name, images: call.images }]);
  const objects = !boxed && ask.box ? call.objects.filter((o) => centeredIn(ask.box!, o.box)) : call.objects;
  const answered = candidatesFrom(name, objects, () => newId("cand"));
  const fresh = newCandidates(before, answered);
  // An object already kept under another phrase stays one candidate: the one SAM was surer of.
  const { kept: candidates, same } = distinctCandidates([...before, ...fresh]);
  const added = fresh.filter((candidate) => candidates.includes(candidate));
  const keptAs = (c: PricedCandidate) => before.find((e) => e.phrase === c.phrase && sameBox(e.box, c.box)) ?? same.get(c.id) ?? c;
  const candidateIds = [...new Set(answered.map((c) => keptAs(c).id))];
  if (added.length === 0 && !replaced) return { photo: row, found: 0, candidateIds };
  const onKept = withKept(replaced ? offLines(row.regions, replaced.id) : row.regions, same);
  const regions = ask.lineIndex === undefined ? onKept : addToLine(onKept, ask.lineIndex, added);
  return { photo: await saveEdit(caller, row, photo, regions, candidates), found: added.length, candidateIds };
}

/**
 * Keeps a polygon a member drew on the photo as a candidate (`drawnCandidate`), under the name of the
 * line at `lineIndex` and on that line when one is given, and draws both copies again with no SAM call.
 * An outline over an object already kept gives way to it (`distinctCandidates`): that one goes on the
 * line instead, and `added` is false. Throws `BAD_OUTLINE`, `UNKNOWN_LINE`, and what `assignPricedPhoto`
 * throws.
 */
export async function drawInPricedPhoto(
  caller: Caller,
  quoteId: string,
  pricedId: string,
  ask: { points: Array<{ x: number; y: number }>; lineIndex?: number },
): Promise<{ photo: PricedPhoto; candidateId: string; added: boolean }> {
  const row = await editable(caller.orgId, quoteId, pricedId);
  const region = ask.lineIndex === undefined ? undefined : row.regions.find((r) => r.lineIndex === ask.lineIndex);
  if (ask.lineIndex !== undefined && !region) throw new Error(`UNKNOWN_LINE: ${ask.lineIndex}`);
  const photo = await readPhoto(row);
  const drawn = drawnCandidate(ask.points, photo, newId("cand"), region?.name ?? DRAWN_PHRASE);
  const { kept: candidates, same } = distinctCandidates([...row.candidates, drawn]);
  const candidate = same.get(drawn.id) ?? drawn;
  const added = candidate === drawn;
  if (!added && (!region || region.objects.some((o) => o.candidateId === candidate.id))) return { photo: row, candidateId: candidate.id, added };
  const regions = region ? addToLine(row.regions, region.lineIndex, [candidate]) : row.regions;
  return { photo: await saveEdit(caller, row, photo, regions, candidates), candidateId: candidate.id, added };
}

/**
 * Takes an outline a member drew off the photo. Nothing is drawn again: an outline on no line isn't on
 * either copy. Throws `UNKNOWN_CANDIDATE`, `NOT_DRAWN` for one SAM found, `ON_A_LINE` for one a line
 * still uses, `PRICED_PHOTO_NOT_FOUND`, or `PRICED_PHOTO_CHANGED`.
 */
export async function removeDrawnFromPricedPhoto(caller: Caller, quoteId: string, pricedId: string, candidateId: string): Promise<PricedPhoto> {
  const row = await editable(caller.orgId, quoteId, pricedId);
  const candidate = row.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw new Error(`UNKNOWN_CANDIDATE: ${candidateId}`);
  if (candidate.source !== "hand") throw new Error("NOT_DRAWN");
  if (row.regions.some((region) => region.objects.some((o) => o.candidateId === candidateId))) throw new Error("ON_A_LINE");
  const [saved] = await db()
    .update(pricedPhotos)
    .set({ candidates: row.candidates.filter((c) => c.id !== candidateId), editedBy: caller.memberId, editedAt: new Date() })
    .where(
      and(
        eq(pricedPhotos.orgId, row.orgId),
        eq(pricedPhotos.id, row.id),
        eq(pricedPhotos.url, row.url),
        // Another removal draws nothing either, so its edit time is what tells it landed first.
        row.editedAt ? eq(pricedPhotos.editedAt, row.editedAt) : isNull(pricedPhotos.editedAt),
      ),
    )
    .returning();
  if (!saved) throw new Error("PRICED_PHOTO_CHANGED");
  return saved;
}

async function editable(orgId: string, quoteId: string, pricedId: string): Promise<PricedPhoto> {
  const row = await pricedPhotoOnQuote(orgId, quoteId, pricedId);
  if (!row) throw new Error("PRICED_PHOTO_NOT_FOUND");
  return row;
}

async function readPhoto(row: PricedPhoto): Promise<Photo> {
  const photo = await preparePhoto(row.sourceUrl);
  if (!photo) throw new Error("UNREADABLE_PHOTO");
  return photo;
}

/**
 * Draws both copies of an edited photo, labeled with the revision it was made for, and stores them in
 * place of the old ones. Only lands on the row as it was read: when another change replaced its render
 * first, the new copies are deleted and `PRICED_PHOTO_CHANGED` is thrown.
 */
async function saveEdit(caller: Caller, row: PricedPhoto, photo: Photo, regions: PricedRegion[], candidates: PricedCandidate[]): Promise<PricedPhoto> {
  const revision = await revisionOf(row);
  // A photo of the quote's own is drawn with its place among the others, and they follow its change.
  const set = row.sourceKind === "quote_attachment" ? await photoSet(row.orgId, row.quoteId) : [];
  const own = set.find((entry) => entry.row.id === row.id);
  const plans = own ? replan(set, [{ sourceId: row.sourceId, attachedAt: own.attachedAt, regions }]) : null;
  const rendered = await renderBoth(photo, regions, candidates, { quoteId: row.quoteId, ...revision }, plans?.after.get(row.sourceId));
  const [saved] = await db()
    .update(pricedPhotos)
    .set({ ...rendered, photoHeight: photo.height, regions, candidates, editedBy: caller.memberId, editedAt: new Date() })
    .where(and(eq(pricedPhotos.orgId, row.orgId), eq(pricedPhotos.id, row.id), eq(pricedPhotos.url, row.url)))
    .returning();
  if (!saved) {
    await deleteRenders(rendered, { url: "", customerUrl: null });
    throw new Error("PRICED_PHOTO_CHANGED");
  }
  await deleteRenders(row, rendered);
  if (plans) await redrawStale(set, new Set([row.sourceId]), plans.before, plans.after);
  return saved;
}

/** The total and language of the revision a priced photo was drawn for. */
async function revisionOf(row: PricedPhoto): Promise<{ totalCents: number; language: Language }> {
  const [revision] = await db()
    .select({ totalCents: quoteRevisions.totalCents, language: quoteRevisions.customerLanguage })
    .from(quoteRevisions)
    .where(and(eq(quoteRevisions.orgId, row.orgId), eq(quoteRevisions.quoteId, row.quoteId), eq(quoteRevisions.number, row.revisionNumber)));
  if (!revision) throw new Error("PRICED_PHOTO_NOT_FOUND");
  return revision;
}

/** A photo to price, with when it was attached when it's one of the quote's own. */
type Source = PricedPhotoSource & { url: string; attachedAt?: Date };

const isPhoto = (mimeType: string | null, name: string | null, url: string) =>
  mimeType ? PHOTO_TYPES.has(mimeType.toLowerCase()) : PHOTO_NAME.test(name ?? "") || PHOTO_NAME.test(new URL(url).pathname);

/** The photo asked for, on this quote (a work photo: on this quote's work), or the quote's most recent photo. */
async function findSource(orgId: string, quoteId: string, asked: PricedPhotoSource | undefined): Promise<Source | null> {
  if (asked?.kind === "work_photo") {
    const [photo] = await db()
      .select({ id: workPhotos.id, url: workPhotos.url })
      .from(workPhotos)
      .innerJoin(serviceJobs, and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, workPhotos.jobId)))
      .where(and(eq(workPhotos.orgId, orgId), eq(workPhotos.id, asked.id), eq(serviceJobs.quoteId, quoteId), isNull(workPhotos.removedAt)));
    return photo ? { kind: "work_photo", ...photo } : null;
  }
  return (await quoteSources(orgId, quoteId, asked?.id)).at(-1) ?? null;
}

/** The quote's photos (JPEG or PNG attachments still on it), in the order they were attached; only `id` when one is given. */
async function quoteSources(orgId: string, quoteId: string, id?: string): Promise<Source[]> {
  const attachments = await db()
    .select({ id: quoteAttachments.id, url: quoteAttachments.url, name: quoteAttachments.name, mimeType: quoteAttachments.mimeType, createdAt: quoteAttachments.createdAt })
    .from(quoteAttachments)
    .where(
      and(eq(quoteAttachments.orgId, orgId), eq(quoteAttachments.quoteId, quoteId), isNull(quoteAttachments.removedAt), id ? eq(quoteAttachments.id, id) : undefined),
    )
    .orderBy(asc(quoteAttachments.createdAt), asc(quoteAttachments.id));
  return attachments
    .filter((a) => isPhoto(a.mimeType, a.name, a.url))
    .map((a) => ({ kind: "quote_attachment" as const, id: a.id, url: a.url, attachedAt: a.createdAt }));
}

export type Photo = { bytes: Uint8Array; width: number; height: number };

/** The stored photo upright, scaled down to `MAX_SIDE`, as a JPEG; null when it has no bytes (fake://) or isn't an image. */
export async function preparePhoto(url: string): Promise<Photo | null> {
  try {
    const stored = await readStoredFile(url);
    if (!stored) return null;
    const { data, info } = await sharp(stored, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    return null;
  }
}

const boxKey = (box: PricedBox) => `${box.left},${box.top},${box.right},${box.bottom}`;

/**
 * Each region's mask outlines, keyed by line index, in the order of its objects: by the object's
 * candidate, or (on a photo made before candidates were kept) by a candidate of the line's phrase with
 * the same box. An object with neither is drawn as its box.
 */
export function maskPaths(regions: PricedRegion[], candidates: PricedCandidate[]): Map<string, string[]> {
  const byId = new Map(candidates.map((c) => [c.id, c.svgPath]));
  const paths = new Map<string, string[]>();
  for (const region of regions) {
    const byBox = new Map(candidates.filter((c) => c.phrase === region.phrase).map((c) => [boxKey(c.box), c.svgPath]));
    paths.set(String(region.lineIndex), region.objects.map((o) => (o.candidateId ? byId.get(o.candidateId) : byBox.get(boxKey(o.box))) ?? ""));
  }
  return paths;
}

// ---------------------------------------------------------------------------------------------
// Drawing

/** One color per line, in line order. Picked to read on grass, mulch, and sky. */
const PALETTE = ["#ff9f0a", "#0a84ff", "#ff375f", "#bf5af2", "#ffd60a", "#64d2ff", "#ff3b30", "#30d158"];
const FILL_OPACITY = 0.35;
/** A mask over more than this share of the photo is filled at `LARGE_FILL_OPACITY` instead. */
const LARGE_SHARE = 0.2;
const LARGE_FILL_OPACITY = 0.15;
const OUTLINE_PX = 3;
export const PILL = "#111111";
const lineColor = (region: PricedRegion) => PALETTE[region.lineIndex % PALETTE.length];

const COPY: Record<Language, { notLocated: string; total: string; alsoIn: (numbers: number[]) => string; photo: (number: number, count: number) => string }> = {
  en: {
    notLocated: "not located",
    total: "Total",
    alsoIn: (numbers) => `also in ${numbers.length > 1 ? "photos" : "photo"} ${numberList(numbers, "en")}`,
    photo: (number, count) => `Photo ${number} of ${count}`,
  },
  es: {
    notLocated: "no ubicado",
    total: "Total",
    alsoIn: (numbers) => `también en ${numbers.length > 1 ? "las fotos" : "la foto"} ${numberList(numbers, "es")}`,
    photo: (number, count) => `Foto ${number} de ${count}`,
  },
};

// Labels are drawn with this font, so they look the same wherever the app runs, fonts installed or not:
// Noto Sans Bold, Latin only (core/fonts/OFL.txt). Its bytes come in a module, since no bundle carries a
// file beside the source, and are written for sharp to load into a folder this process made for itself,
// never to a shared path someone else could have put a file at. Written again if a temp cleaner took it.
const FONT_FAMILY = "Noto Sans Bold";
let fontFile: Promise<string> | null = null;

async function labelFont(): Promise<string> {
  fontFile ??= (async () => {
    const file = join(await mkdtemp(join(tmpdir(), "groundwork-font-")), "NotoSans-Bold.ttf");
    await writeFile(file, Buffer.from(NOTO_SANS_BOLD_BASE64, "base64"), { mode: 0o600 });
    return file;
  })();
  const file = await fontFile.catch((error: unknown) => {
    fontFile = null;
    throw error;
  });
  if (existsSync(file)) return file;
  fontFile = null;
  return labelFont();
}

const escapeMarkup = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quantityText = (quantity: number) => String(Number(quantity.toFixed(2)));

export type Text = { input: Buffer; width: number; height: number };

/** White (or `color`) text on clear, wrapped at `maxWidth`. */
export async function textImage(text: string, px: number, maxWidth: number, color = "#ffffff"): Promise<Text> {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
      font: `${FONT_FAMILY} ${px}`,
      width: Math.max(1, Math.floor(maxWidth)),
      fontfile: await labelFont(),
      rgba: true,
      dpi: 72,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

/** "Mulch installed · 3 cubic yards · $285.00", as the customer page writes a line; without its price when `linePrices` is false. */
export function lineLabel(region: PricedRegion, language: Language, linePrices = true): string {
  const amount = `${quantityText(region.quantity)}${region.unitLabel ? ` ${pluralUnit(region.quantity, region.unitLabel, language)}` : ""}`;
  return [region.name, amount, ...(region.totalCents === null || !linePrices ? [] : [formatCents(region.totalCents, language)])].join(" · ");
}

type Rect = { x: number; y: number; width: number; height: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Each kept object once, as SVG, filled and outlined in the first line's color that kept it; each other
 * line that kept it adds a dashed outline in its own color. A mask over a large share of the photo (a
 * whole lawn) is filled lighter, so the yard still looks like itself. `svgPaths` as `renderOverlay` takes it.
 */
export function maskShapes(regions: PricedRegion[], svgPaths: Map<string, string[]>, width: number, height: number): string[] {
  const objects = new Map<string, { d: string; areaPx: number; colors: string[] }>();
  for (const region of regions) {
    const paths = svgPaths.get(String(region.lineIndex)) ?? [];
    region.objects.forEach((object, i) => {
      const key = boxKey(object.box);
      const { left, top, right, bottom } = object.box;
      const drawn = objects.get(key) ?? {
        d: paths[i] || `M${left} ${top}L${right} ${top}L${right} ${bottom}L${left} ${bottom}Z`,
        areaPx: object.areaPx,
        colors: [],
      };
      drawn.colors.push(lineColor(region));
      objects.set(key, drawn);
    });
  }
  const shapes: string[] = [];
  for (const { d, areaPx, colors } of objects.values()) {
    const fill = areaPx > width * height * LARGE_SHARE ? LARGE_FILL_OPACITY : FILL_OPACITY;
    shapes.push(
      `<path d="${d}" fill="${colors[0]}" fill-opacity="${fill}" fill-rule="evenodd" stroke="${colors[0]}" stroke-width="${OUTLINE_PX}" stroke-linejoin="round"/>`,
      ...colors
        .slice(1)
        .map(
          (other, i) =>
            `<path d="${d}" fill="none" stroke="${other}" stroke-width="${OUTLINE_PX}" stroke-dasharray="${OUTLINE_PX * 4} ${OUTLINE_PX * 4}" stroke-dashoffset="${i * OUTLINE_PX * 2}" stroke-linejoin="round"/>`,
        ),
    );
  }
  return shapes;
}

/**
 * Draws the regions on the photo and a legend under it. Each object a line kept is filled and
 * outlined in the line's color (dashed for a second line on the same object); each line is labeled
 * once, centered on its largest object, and lines that kept the same object share one label of stacked rows. `svgPaths` holds each region's mask outlines
 * (keyed by line index, in the order of its objects); a missing one is drawn as its box. Labels that
 * would overlap move down. With `linePrices` false, labels carry quantities only; the total stays unless `total` is
 * false too. The legend lists every line, or with `place` (the photo's among the quote's priced photos)
 * only those `legendLines` gives, under the photo's number when there are several. Pure given its inputs.
 */
export async function renderOverlay(
  image: { bytes: Uint8Array; width: number; height: number },
  regions: PricedRegion[],
  svgPaths: Map<string, string[]>,
  totalCents: number,
  language: Language,
  options: { linePrices?: boolean; total?: boolean; place?: PhotoPlace } = {},
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const label = (region: PricedRegion) => lineLabel(region, language, options.linePrices ?? true);
  const { width, height } = image;
  const copy = COPY[language];
  // 20 px on a 1024 px photo, kept in proportion for larger and smaller ones.
  const px = Math.round(Math.min(30, Math.max(16, (20 * width) / 1024)));
  const pad = Math.round(px * 0.5);
  const rowHeight = Math.round(px * 1.5);

  const shapes = maskShapes(regions, svgPaths, width, height);

  // Labels: one per line on its largest object, stacked where lines share it, placed top down.
  const groups = new Map<string, { box: PricedRegion["objects"][number]["box"]; area: number; regions: PricedRegion[] }>();
  for (const region of regions) {
    const largest = region.objects[0];
    if (!largest) continue;
    const key = boxKey(largest.box);
    const group = groups.get(key) ?? { box: largest.box, area: largest.areaPx, regions: [] };
    group.regions.push(region);
    groups.set(key, group);
  }
  const placed: Rect[] = [];
  const texts: OverlayOptions[] = [];
  const dot = Math.round(px * 0.6);
  const maxText = width - pad * 4 - dot;
  // A label that wraps takes a row per line: one line's height is measured, the rest counted from it.
  const lineHeight = (await textImage("Ag", px, maxText)).height;
  const rowSpan = (text: Text) => rowHeight + (Math.max(1, Math.round(text.height / lineHeight)) - 1) * lineHeight;
  const rowTops = (spans: number[]) => spans.map((_, i) => spans.slice(0, i).reduce((sum, span) => sum + span, 0));
  for (const group of [...groups.values()].sort((a, b) => a.box.top - b.box.top || b.area - a.area)) {
    const rows = await Promise.all(group.regions.map((region) => textImage(label(region), px, maxText)));
    const spans = rows.map(rowSpan);
    const tops = rowTops(spans);
    const pill = {
      width: pad * 2 + dot + pad + Math.max(...rows.map((row) => row.width)),
      height: pad * 2 + spans.reduce((sum, span) => sum + span, 0) - (rowHeight - px) + Math.round(px * 0.2),
    };
    const rect: Rect = {
      // Centered on the object, so labels of objects side by side don't pile up at their left edges.
      x: Math.max(0, Math.min(width - pill.width, Math.round((group.box.left + group.box.right - pill.width) / 2))),
      y: Math.max(0, Math.min(height - pill.height, group.box.top + pad)),
      ...pill,
    };
    for (let clash = placed.find((p) => overlaps(p, rect)); clash; clash = placed.find((p) => overlaps(p, rect))) {
      rect.y = clash.y + clash.height + Math.round(pad / 2);
    }
    rect.y = Math.min(rect.y, height - rect.height);
    placed.push(rect);
    shapes.push(`<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${Math.round(px * 0.6)}" fill="${PILL}" fill-opacity="0.85"/>`);
    rows.forEach((row, i) => {
      const top = rect.y + pad + tops[i];
      const middle = top + Math.round(lineHeight / 2);
      shapes.push(`<circle cx="${rect.x + pad + dot / 2}" cy="${middle}" r="${dot / 2}" fill="${lineColor(group.regions[i])}"/>`);
      texts.push({ input: row.input, left: rect.x + pad + dot + pad, top });
    });
  }

  // Legend: the photo's number among several, its lines (`legendLines`), then the quote's total (unless
  // left off). A note that doesn't fit beside its line goes under it.
  const swatch = Math.round(px * 0.8);
  const textLeft = pad * 2 + swatch + pad;
  const { place } = options;
  const header = place && place.count > 1 ? await textImage(copy.photo(place.number, place.count), px, maxText, "#a1a1aa") : null;
  const headerSpan = header ? rowSpan(header) : 0;
  const legendRows = await Promise.all(
    legendLines(regions, place).map(async ({ region, alsoIn, notLocated }) => {
      const text = await textImage(label(region), px, maxText);
      const words = notLocated ? copy.notLocated : alsoIn.length ? copy.alsoIn(alsoIn) : null;
      const note = words ? await textImage(`(${words})`, px, maxText, "#a1a1aa") : null;
      const beside = !note || textLeft + text.width + pad + note.width <= width - pad;
      return { region, label: text, note, beside, span: rowSpan(text) + (beside || !note ? 0 : rowSpan(note) - (rowHeight - lineHeight)) };
    }),
  );
  const legendTops = rowTops(legendRows.map((row) => row.span));
  const legendSpan = legendRows.reduce((sum, row) => sum + row.span, 0);
  const total = options.total === false ? null : await textImage(`${copy.total} ${formatCents(totalCents, language)}`, Math.round(px * 1.1), maxText);
  const legendHeight = pad * 2 + headerSpan + legendSpan + (total ? Math.round(px * 0.5) + total.height : 0) + pad * 2;
  shapes.push(`<rect x="0" y="${height}" width="${width}" height="${legendHeight}" fill="${PILL}"/>`);
  if (header) texts.push({ input: header.input, left: pad * 2, top: height + pad * 2 });
  legendRows.forEach(({ region, label, note, beside }, i) => {
    const top = height + pad * 2 + headerSpan + legendTops[i];
    const middle = top + Math.round(lineHeight / 2);
    const x = pad * 2;
    shapes.push(
      `<rect x="${x}" y="${middle - swatch / 2}" width="${swatch}" height="${swatch}" rx="3" fill="${lineColor(region)}" fill-opacity="${region.located ? 1 : 0.35}"/>`,
    );
    texts.push({ input: label.input, left: textLeft, top });
    if (note && beside) texts.push({ input: note.input, left: textLeft + label.width + pad, top });
    else if (note) texts.push({ input: note.input, left: textLeft, top: top + label.height });
  });
  if (total) {
    const totalTop = height + pad * 2 + headerSpan + legendSpan + Math.round(px * 0.5);
    shapes.push(`<line x1="${pad * 2}" y1="${totalTop - Math.round(px * 0.35)}" x2="${width - pad * 2}" y2="${totalTop - Math.round(px * 0.35)}" stroke="#3f3f46" stroke-width="1"/>`);
    texts.push({ input: total.input, left: pad * 2, top: totalTop });
  }

  const fullHeight = height + legendHeight;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fullHeight}">${shapes.join("")}</svg>`;
  const png = await sharp(image.bytes)
    .extend({ bottom: legendHeight, background: PILL })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }, ...texts])
    .png()
    .toBuffer();
  return { png: new Uint8Array(png), width, height: fullHeight };
}
