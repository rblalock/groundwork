// Before and after: a quote's priced photo from before the job beside its priced work photo from after
// it, each with a "Before" or "After" label in a corner, and the quote's title (and total, when the viewer
// sees line prices) under both. The photos are plain unless outlines are asked for, then each has the
// quoted things outlined from its kept masks. Drawn on demand from the two source photos and the kept
// outlines: no SAM call, nothing stored.
import { and, eq } from "drizzle-orm";
import sharp, { type OverlayOptions } from "sharp";
import { quoteRevisions, quotes } from "../schema/schema";
import { readStoredFile } from "./blob";
import { db } from "./db";
import type { Language } from "./language";
import { formatCents } from "./money";
import { maskPaths, maskShapes, PILL, preparePhoto, pricedPhotosFor, textImage, type Photo, type PricedPhoto } from "./priced-photo";

/**
 * A quote's newest priced photo of its own (before the job) and newest priced work photo (after it).
 * `totalCents` is the total of the revision the after photo was drawn for. `version` changes whenever
 * either photo is made again or edited.
 */
export type BeforeAfter = { quoteId: string; title: string; totalCents: number; before: PricedPhoto; after: PricedPhoto; version: number };

/** The pair among one quote's priced photos (newest first, as `pricedPhotosFor` lists them); null unless it has both kinds. */
export function pairOf(photos: PricedPhoto[]): Pick<BeforeAfter, "before" | "after" | "version"> | null {
  const before = photos.find((photo) => photo.sourceKind === "quote_attachment");
  const after = photos.find((photo) => photo.sourceKind === "work_photo");
  if (!before || !after) return null;
  const version = Math.max(...[before, after].flatMap((photo) => [photo.createdAt.getTime(), photo.editedAt?.getTime() ?? 0]));
  return { before, after, version };
}

/** The quote's before-and-after, or null when it has no priced photo of one kind or the other. */
export async function beforeAfterFor(orgId: string, quoteId: string): Promise<BeforeAfter | null> {
  const pair = pairOf(await pricedPhotosFor(orgId, quoteId));
  if (!pair) return null;
  const [quote] = await db()
    .select({ title: quotes.title, totalCents: quoteRevisions.totalCents })
    .from(quotes)
    .leftJoin(quoteRevisions, and(eq(quoteRevisions.orgId, orgId), eq(quoteRevisions.quoteId, quotes.id), eq(quoteRevisions.number, pair.after.revisionNumber)))
    .where(and(eq(quotes.orgId, orgId), eq(quotes.id, quoteId)));
  if (!quote) return null;
  return { quoteId, title: quote.title, totalCents: quote.totalCents ?? 0, ...pair };
}

// ---------------------------------------------------------------------------------------------
// Drawing

/** The composite's long side stays within this. */
export const BEFORE_AFTER_MAX = 2048;
/** Between the two photos. */
const GAP = 8;

const COPY: Record<Language, { before: string; after: string; total: string }> = {
  en: { before: "Before", after: "After", total: "Total" },
  es: { before: "Antes", after: "Después", total: "Total" },
};

export const beforeAfterCopy = (language: Language) => COPY[language];

type Size = { width: number; height: number };
type Rect = Size & { x: number; y: number };

/**
 * Where each photo goes: side by side at the same height, never larger than the shorter photo, with the
 * width within `BEFORE_AFTER_MAX`. Two portraits sit side by side too: stacked, they made a tall strip
 * that printed small on the invoice.
 */
export function beforeAfterLayout(before: Size, after: Size): Size & { before: Rect; after: Rect } {
  const wide = before.width / before.height + after.width / after.height;
  const height = Math.floor(Math.min(before.height, after.height, (BEFORE_AFTER_MAX - GAP) / wide));
  const left = Math.floor((height * before.width) / before.height);
  const right = Math.floor((height * after.width) / after.height);
  return { width: left + GAP + right, height, before: { x: 0, y: 0, width: left, height }, after: { x: left + GAP, y: 0, width: right, height } };
}

/**
 * The photo a priced photo was drawn on, with its kept outlines and no labels. A photo made before
 * outlines were kept has its stored render's photo part instead (the copy without line prices when
 * those are hidden), or the plain photo when even that can't be cut out. Null when nothing can be read.
 */
async function outlined(photo: PricedPhoto, linePrices: boolean): Promise<Photo | null> {
  if (photo.candidates.length > 0) {
    const source = await preparePhoto(photo.sourceUrl);
    if (source) {
      const { width, height } = source;
      const shapes = maskShapes(photo.regions, maskPaths(photo.regions, photo.candidates), width, height);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}</svg>`;
      const bytes = await sharp(source.bytes).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
      return { bytes: new Uint8Array(bytes), width, height };
    }
  }
  const render = photo.photoHeight === null ? null : linePrices ? photo.url : photo.customerUrl;
  const stored = render ? await readStoredFile(render).catch(() => null) : null;
  if (stored && photo.photoHeight !== null) {
    try {
      const height = photo.photoHeight;
      const bytes = await sharp(stored).extract({ left: 0, top: 0, width: photo.width, height }).png().toBuffer();
      return { bytes: new Uint8Array(bytes), width: photo.width, height };
    } catch {
      // Not the size the row says: the plain photo below.
    }
  }
  return preparePhoto(photo.sourceUrl);
}

/**
 * Draws the before-and-after: both photos labeled (and, with `outlines`, outlined), laid out by
 * `beforeAfterLayout`, over a caption of the quote's title and, with `linePrices`, its total. Throws
 * `UNREADABLE_PHOTO` when either photo can't be read.
 */
export async function renderBeforeAfter(
  pair: BeforeAfter,
  language: Language,
  options: { linePrices: boolean; outlines?: boolean },
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const draw = (photo: PricedPhoto) => (options.outlines ? outlined(photo, options.linePrices) : preparePhoto(photo.sourceUrl));
  const [before, after] = await Promise.all([draw(pair.before), draw(pair.after)]);
  if (!before || !after) throw new Error("UNREADABLE_PHOTO");
  const layout = beforeAfterLayout(before, after);
  const { width, height } = layout;
  const copy = COPY[language];
  // As the priced photo sizes its labels: 20 px on a 1024 px wide image, within 16 to 30.
  const px = Math.round(Math.min(30, Math.max(16, (20 * width) / 1024)));
  const pad = Math.round(px * 0.5);

  // The photos, then their label pills over them, then the labels' text.
  const photos: OverlayOptions[] = [];
  const pills: string[] = [];
  const texts: OverlayOptions[] = [];
  const sides = [
    { photo: before, rect: layout.before, label: await textImage(copy.before, px, layout.before.width - pad * 4) },
    { photo: after, rect: layout.after, label: await textImage(copy.after, px, layout.after.width - pad * 4) },
  ];
  // Both pills as tall as the taller label, so an accent doesn't make one stand out.
  const pillHeight = Math.max(...sides.map((side) => side.label.height)) + pad;
  for (const { photo, rect, label } of sides) {
    const scaled = await sharp(photo.bytes).resize(rect.width, rect.height, { fit: "fill" }).toBuffer();
    photos.push({ input: scaled, left: rect.x, top: rect.y });
    const pill = { x: rect.x + pad, y: rect.y + pad, width: label.width + pad * 2, height: pillHeight };
    pills.push(`<rect x="${pill.x}" y="${pill.y}" width="${pill.width}" height="${pill.height}" rx="${Math.round(px * 0.6)}" fill="${PILL}" fill-opacity="0.85"/>`);
    texts.push({ input: label.input, left: pill.x + pad, top: pill.y + Math.round((pillHeight - label.height) / 2) });
  }

  const caption = await textImage(
    options.linePrices ? `${pair.title} · ${copy.total} ${formatCents(pair.totalCents, language)}` : pair.title,
    Math.round(px * 1.1),
    width - pad * 4,
  );
  const captionHeight = pad * 4 + caption.height;
  texts.push({ input: caption.input, left: pad * 2, top: height + pad * 2 });

  const fullHeight = height + captionHeight;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fullHeight}">${pills.join("")}</svg>`;
  const png = await sharp({ create: { width, height: fullHeight, channels: 3, background: PILL } })
    .composite([...photos, { input: Buffer.from(svg), top: 0, left: 0 }, ...texts])
    .png()
    .toBuffer();
  return { png: new Uint8Array(png), width, height: fullHeight };
}
