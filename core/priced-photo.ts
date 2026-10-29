// The priced photo: a quote's photo with each quoted thing outlined by SAM and labeled with its line's
// quantity and price, and a legend of every line under it. Nothing here measures anything: quantities
// and prices come from the quote. One per quote per source photo; making it again replaces it, except
// within `RERENDER_MS` of the last render of the same revision, which comes back instead. When the
// business hides line prices from customers, the quote's link shows a second copy labeled with quantities
// only, drawn beside the first from the same masks. Every object SAM found is kept as a candidate with its
// outline (once, when two phrases found the same object), so a member can move objects between lines and
// both copies are drawn again without SAM.
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
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
  newCandidates,
  selectRegions,
  withKept,
  type Assignment,
  type PhotoLine,
} from "./priced-photo-select";
import { getQuote } from "./quotes";
import { SAM_MODEL, segment, segmentMany, type SamObject } from "./sam";
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
 * there isn't sent to SAM again. Throws when every SAM call fails.
 */
export async function createPricedPhoto(caller: Caller, input: { quoteId: string; source?: PricedPhotoSource }): Promise<PricedPhotoResult> {
  const { orgId } = caller;
  const quote = await getQuote(orgId, input.quoteId);
  if (!quote) return { pricedPhotoId: null, reason: "quote_not_found" };
  if (quote.lines.length === 0) return { pricedPhotoId: null, reason: "no_lines" };
  const source = await findSource(orgId, quote.quoteId, input.source);
  if (!source) return { pricedPhotoId: null, reason: "no_photo" };
  const [before] = await db()
    .select()
    .from(pricedPhotos)
    .where(and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quote.quoteId), eq(pricedPhotos.sourceUrl, source.url)));
  if (before && rerenderTooSoon(before, quote.revisionNumber, new Date())) return resultOf(before.id, before.url, before.regions);
  const photo = await preparePhoto(source.url);
  if (!photo) return { pricedPhotoId: null, reason: "unreadable_photo" };
  if (photo.width < MIN_WIDTH) return { pricedPhotoId: null, reason: "photo_too_small" };

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
  const phrases = [...new Set(prompts)].filter((phrase) => !kept.some((c) => c.phrase === phrase));
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
  const regions = selectRegions(lines, byPhrase, photo);
  const rendered = await renderBoth(photo, regions, candidates, { quoteId: quote.quoteId, totalCents: quote.totalCents, language: quote.customerLanguage });

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
    .values({ id: newId("ppho"), orgId, quoteId: quote.quoteId, sourceUrl: source.url, ...values })
    .onConflictDoUpdate({ target: [pricedPhotos.orgId, pricedPhotos.quoteId, pricedPhotos.sourceUrl], set: values })
    .returning({ id: pricedPhotos.id });
  if (before) await deleteRenders(before, rendered);
  return resultOf(row.id, rendered.url, regions);
}

type Renders = { url: string; customerUrl: string | null };

/**
 * Draws the priced copy and the quantity-only copy of `regions` on the photo, each object by its
 * candidate's outline, and stores both. The quantity-only copy is drawn every time so the business can
 * hide line prices later and the link still has a photo to show.
 */
async function renderBoth(
  photo: Photo,
  regions: PricedRegion[],
  candidates: PricedCandidate[],
  quote: { quoteId: string; totalCents: number; language: Language },
): Promise<{ url: string; customerUrl: string; width: number; height: number }> {
  const paths = maskPaths(regions, candidates);
  const png = await renderOverlay(photo, regions, paths, quote.totalCents, quote.language);
  const url = await storeInboundAttachment(`priced-${quote.quoteId}.png`, "image/png", png.png);
  const customerUrl = await storeInboundAttachment(
    `priced-${quote.quoteId}-customer.png`,
    "image/png",
    (await renderOverlay(photo, regions, paths, quote.totalCents, quote.language, { linePrices: false })).png,
  );
  return { url, customerUrl, width: png.width, height: png.height };
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

/** The quote's priced photos, newest first. */
export function pricedPhotosFor(orgId: string, quoteId: string): Promise<PricedPhoto[]> {
  return db()
    .select()
    .from(pricedPhotos)
    .where(and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quoteId)))
    .orderBy(desc(pricedPhotos.createdAt), desc(pricedPhotos.id));
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
// Editing: moving the kept candidates between lines, and looking for one more phrase

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
 * Asks SAM once for `phrase` on the photo, keeps what it finds (inside `box`, by each object's middle,
 * when one is given) as new candidates, and puts them on the line at `lineIndex` when one is given; then
 * draws both copies again. `found` counts the candidates added: an object already kept for the phrase
 * isn't added twice, one kept under another phrase is added only in place of it when SAM is surer of it
 * now (`distinctCandidates`), and with none added nothing is drawn. Throws `BAD_PHRASE`, `UNKNOWN_LINE`,
 * `SAM_FAILED`, and what `assignPricedPhoto` throws.
 */
export async function findInPricedPhoto(
  caller: Caller,
  quoteId: string,
  pricedId: string,
  ask: { phrase: string; box?: PricedBox; lineIndex?: number },
): Promise<{ photo: PricedPhoto; found: number }> {
  const phrase = ask.phrase.trim();
  if (phrase.length === 0 || phrase.length > MAX_FIND_PHRASE) throw new Error("BAD_PHRASE");
  const row = await editable(caller.orgId, quoteId, pricedId);
  if (ask.lineIndex !== undefined && !row.regions.some((region) => region.lineIndex === ask.lineIndex)) throw new Error(`UNKNOWN_LINE: ${ask.lineIndex}`);
  const photo = await readPhoto(row);
  const call = await segment({ bytes: photo.bytes, mimeType: "image/jpeg" }, phrase, { size: photo });
  await recordSamCalls(caller, quoteId, [{ phrase, images: call.images }]);
  const objects = ask.box ? call.objects.filter((o) => centeredIn(ask.box!, o.box)) : call.objects;
  const fresh = newCandidates(row.candidates, candidatesFrom(phrase, objects, () => newId("cand")));
  // An object already kept under another phrase stays one candidate: the one SAM was surer of.
  const { kept: candidates, same } = distinctCandidates([...row.candidates, ...fresh]);
  const added = fresh.filter((candidate) => candidates.includes(candidate));
  if (added.length === 0) return { photo: row, found: 0 };
  const onKept = withKept(row.regions, same);
  const regions = ask.lineIndex === undefined ? onKept : addToLine(onKept, ask.lineIndex, added);
  return { photo: await saveEdit(caller, row, photo, regions, candidates), found: added.length };
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
  const [revision] = await db()
    .select({ totalCents: quoteRevisions.totalCents, language: quoteRevisions.customerLanguage })
    .from(quoteRevisions)
    .where(and(eq(quoteRevisions.orgId, row.orgId), eq(quoteRevisions.quoteId, row.quoteId), eq(quoteRevisions.number, row.revisionNumber)));
  if (!revision) throw new Error("PRICED_PHOTO_NOT_FOUND");
  const rendered = await renderBoth(photo, regions, candidates, { quoteId: row.quoteId, ...revision });
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
  return saved;
}

type Source = PricedPhotoSource & { url: string };

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
  const attachments = await db()
    .select({ id: quoteAttachments.id, url: quoteAttachments.url, name: quoteAttachments.name, mimeType: quoteAttachments.mimeType })
    .from(quoteAttachments)
    .where(
      and(
        eq(quoteAttachments.orgId, orgId),
        eq(quoteAttachments.quoteId, quoteId),
        isNull(quoteAttachments.removedAt),
        asked ? eq(quoteAttachments.id, asked.id) : undefined,
      ),
    )
    .orderBy(desc(quoteAttachments.createdAt), desc(quoteAttachments.id));
  const photo = attachments.find((a) => isPhoto(a.mimeType, a.name, a.url));
  return photo ? { kind: "quote_attachment", id: photo.id, url: photo.url } : null;
}

type Photo = { bytes: Uint8Array; width: number; height: number };

/** The stored photo upright, scaled down to `MAX_SIDE`, as a JPEG; null when it has no bytes (fake://) or isn't an image. */
async function preparePhoto(url: string): Promise<Photo | null> {
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
function maskPaths(regions: PricedRegion[], candidates: PricedCandidate[]): Map<string, string[]> {
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
const PILL = "#111111";

const COPY: Record<Language, { notLocated: string; total: string }> = {
  en: { notLocated: "not located", total: "Total" },
  es: { notLocated: "no ubicado", total: "Total" },
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

type Text = { input: Buffer; width: number; height: number };

/** White (or `color`) text on clear, wrapped at `maxWidth`. */
async function textImage(text: string, px: number, maxWidth: number, color = "#ffffff"): Promise<Text> {
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
 * Draws the regions on the photo and a legend under it. Each object a line kept is filled and
 * outlined in the line's color (dashed for a second line on the same object); each line is labeled
 * once, centered on its largest object, and lines that kept the same object share one label of stacked rows. `svgPaths` holds each region's mask outlines
 * (keyed by line index, in the order of its objects); a missing one is drawn as its box. Labels that
 * would overlap move down. With `linePrices` false, labels carry quantities only; the total stays. Pure given its inputs.
 */
export async function renderOverlay(
  image: { bytes: Uint8Array; width: number; height: number },
  regions: PricedRegion[],
  svgPaths: Map<string, string[]>,
  totalCents: number,
  language: Language,
  options: { linePrices?: boolean } = {},
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const label = (region: PricedRegion) => lineLabel(region, language, options.linePrices ?? true);
  const { width, height } = image;
  const copy = COPY[language];
  // 20 px on a 1024 px photo, kept in proportion for larger and smaller ones.
  const px = Math.round(Math.min(30, Math.max(16, (20 * width) / 1024)));
  const pad = Math.round(px * 0.5);
  const rowHeight = Math.round(px * 1.5);
  const color = (region: PricedRegion) => PALETTE[region.lineIndex % PALETTE.length];

  // Masks: each kept object once, filled and outlined in the first line's color that kept it; each
  // other line that kept it adds a dashed outline in its own color. A mask over a large share of the
  // photo (a whole lawn) is filled lighter, so the yard still looks like itself.
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
      drawn.colors.push(color(region));
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
      shapes.push(`<circle cx="${rect.x + pad + dot / 2}" cy="${middle}" r="${dot / 2}" fill="${color(group.regions[i])}"/>`);
      texts.push({ input: row.input, left: rect.x + pad + dot + pad, top });
    });
  }

  // Legend: every line, located or not, then the quote's total. A note that doesn't fit beside its
  // line goes under it.
  const swatch = Math.round(px * 0.8);
  const textLeft = pad * 2 + swatch + pad;
  const legendRows = await Promise.all(
    regions.map(async (region) => {
      const text = await textImage(label(region), px, maxText);
      const note = region.located ? null : await textImage(`(${copy.notLocated})`, px, maxText, "#a1a1aa");
      const beside = !note || textLeft + text.width + pad + note.width <= width - pad;
      return { region, label: text, note, beside, span: rowSpan(text) + (beside || !note ? 0 : rowSpan(note) - (rowHeight - lineHeight)) };
    }),
  );
  const legendTops = rowTops(legendRows.map((row) => row.span));
  const legendSpan = legendRows.reduce((sum, row) => sum + row.span, 0);
  const total = await textImage(`${copy.total} ${formatCents(totalCents, language)}`, Math.round(px * 1.1), maxText);
  const legendHeight = pad * 2 + legendSpan + Math.round(px * 0.5) + total.height + pad * 2;
  shapes.push(`<rect x="0" y="${height}" width="${width}" height="${legendHeight}" fill="${PILL}"/>`);
  legendRows.forEach(({ region, label, note, beside }, i) => {
    const top = height + pad * 2 + legendTops[i];
    const middle = top + Math.round(lineHeight / 2);
    const x = pad * 2;
    shapes.push(
      `<rect x="${x}" y="${middle - swatch / 2}" width="${swatch}" height="${swatch}" rx="3" fill="${color(region)}" fill-opacity="${region.located ? 1 : 0.35}"/>`,
    );
    texts.push({ input: label.input, left: textLeft, top });
    if (note && beside) texts.push({ input: note.input, left: textLeft + label.width + pad, top });
    else if (note) texts.push({ input: note.input, left: textLeft, top: top + label.height });
  });
  const totalTop = height + pad * 2 + legendSpan + Math.round(px * 0.5);
  shapes.push(`<line x1="${pad * 2}" y1="${totalTop - Math.round(px * 0.35)}" x2="${width - pad * 2}" y2="${totalTop - Math.round(px * 0.35)}" stroke="#3f3f46" stroke-width="1"/>`);
  texts.push({ input: total.input, left: pad * 2, top: totalTop });

  const fullHeight = height + legendHeight;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fullHeight}">${shapes.join("")}</svg>`;
  const png = await sharp(image.bytes)
    .extend({ bottom: legendHeight, background: PILL })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }, ...texts])
    .png()
    .toBuffer();
  return { png: new Uint8Array(png), width, height: fullHeight };
}
