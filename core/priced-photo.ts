// The priced photo: a quote's photo with each quoted thing outlined by SAM and labeled with its line's
// quantity and price, and a legend of every line under it. Nothing here measures anything: quantities
// and prices come from the quote. One per quote per source photo; making it again replaces it.
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import sharp, { type OverlayOptions } from "sharp";
import { pricedPhotos, quoteAttachments, quotes, serviceJobs, workPhotos } from "../schema/schema";
import type { PricedRegion } from "../schema/types";
import { deleteBlob, readStoredFile, storeInboundAttachment } from "./blob";
import { db, newId } from "./db";
import { MAX_PIXELS } from "./images";
import type { Language } from "./language";
import type { Caller } from "./members";
import { NOTO_SANS_BOLD_BASE64 } from "./fonts/noto-sans-bold";
import { formatCents } from "./money";
import { listItems } from "./pricebook";
import { selectRegions, type PhotoLine } from "./priced-photo-select";
import { getQuote } from "./quotes";
import { segmentMany, type SamObject } from "./sam";

export type PricedPhoto = typeof pricedPhotos.$inferSelect;
export type PricedPhotoSource = { kind: "quote_attachment" | "work_photo"; id: string };

export type PricedPhotoResult =
  | { pricedPhotoId: string; url: string; regions: PricedRegion[]; located: number; notLocated: string[] }
  | { pricedPhotoId: null; reason: "no_photo" | "unreadable_photo" | "quote_not_found" | "no_lines" };

/** The photo is scaled down to this long side before SAM sees it and before drawing. */
const MAX_SIDE = 1600;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png"]);
const PHOTO_NAME = /\.(jpe?g|png)$/i;

/**
 * Makes (or makes again) the priced photo for a quote: from the photo given, or else the quote's most
 * recent JPEG or PNG. Lines whose item has a photo prompt are looked for; the rest, and any SAM can't
 * find, stay on the legend as not located. Throws when every SAM call fails.
 */
export async function createPricedPhoto(caller: Caller, input: { quoteId: string; source?: PricedPhotoSource }): Promise<PricedPhotoResult> {
  const { orgId } = caller;
  const quote = await getQuote(orgId, input.quoteId);
  if (!quote) return { pricedPhotoId: null, reason: "quote_not_found" };
  if (quote.lines.length === 0) return { pricedPhotoId: null, reason: "no_lines" };
  const source = await findSource(orgId, quote.quoteId, input.source);
  if (!source) return { pricedPhotoId: null, reason: "no_photo" };
  const photo = await preparePhoto(source.url);
  if (!photo) return { pricedPhotoId: null, reason: "unreadable_photo" };

  const items = new Map((await listItems(orgId, { includeRetired: true })).map((item) => [item.id, item]));
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
  const phrases = lines.flatMap((line) => (line.phrase ? [line.phrase] : []));
  const found = phrases.length > 0 ? await segmentMany({ bytes: photo.bytes, mimeType: "image/jpeg" }, phrases, { size: photo }) : new Map<string, SamObject[]>();
  const regions = selectRegions(lines, found, photo);
  const png = await renderOverlay(photo, regions, maskPaths(regions, found), quote.totalCents, quote.customerLanguage);
  const url = await storeInboundAttachment(`priced-${quote.quoteId}.png`, "image/png", png.png);

  const [before] = await db()
    .select({ url: pricedPhotos.url })
    .from(pricedPhotos)
    .where(and(eq(pricedPhotos.orgId, orgId), eq(pricedPhotos.quoteId, quote.quoteId), eq(pricedPhotos.sourceUrl, source.url)));
  const values = {
    revisionNumber: quote.revisionNumber,
    sourceKind: source.kind,
    sourceId: source.id,
    url,
    width: png.width,
    height: png.height,
    regions,
    memberId: caller.memberId,
    createdAt: new Date(),
  };
  const [row] = await db()
    .insert(pricedPhotos)
    .values({ id: newId("ppho"), orgId, quoteId: quote.quoteId, sourceUrl: source.url, ...values })
    .onConflictDoUpdate({ target: [pricedPhotos.orgId, pricedPhotos.quoteId, pricedPhotos.sourceUrl], set: values })
    .returning({ id: pricedPhotos.id });
  if (before && before.url !== url) await deleteBlob(before.url).catch((error) => console.error("priced photo: deleting the old render failed", error));

  return {
    pricedPhotoId: row.id,
    url,
    regions,
    located: regions.filter((region) => region.located).length,
    notLocated: regions.filter((region) => !region.located).map((region) => region.name),
  };
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

const boxKey = (box: PricedRegion["objects"][number]["box"]) => `${box.left},${box.top},${box.right},${box.bottom}`;

/** Each region's mask outlines, keyed by line index, in the order of its objects. */
function maskPaths(regions: PricedRegion[], found: Map<string, SamObject[]>): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const region of regions) {
    const byBox = new Map((region.phrase ? (found.get(region.phrase) ?? []) : []).map((o) => [boxKey(o.box), o.svgPath]));
    paths.set(String(region.lineIndex), region.objects.map((o) => byBox.get(boxKey(o.box)) ?? ""));
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

/** "Mulch installed · 3 cubic yard · $285.00", as the customer page writes a line. */
function lineLabel(region: PricedRegion, language: Language): string {
  const amount = `${quantityText(region.quantity)}${region.unitLabel ? ` ${region.unitLabel}` : ""}`;
  return [region.name, amount, ...(region.totalCents === null ? [] : [formatCents(region.totalCents, language)])].join(" · ");
}

type Rect = { x: number; y: number; width: number; height: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Draws the regions on the photo and a legend under it. Each object a line kept is filled and
 * outlined in the line's color (dashed for a second line on the same object); each line is labeled
 * once, on its largest object, and lines that kept the same object share one label of stacked rows. `svgPaths` holds each region's mask outlines
 * (keyed by line index, in the order of its objects); a missing one is drawn as its box. Labels that
 * would overlap move down. Pure given its inputs.
 */
export async function renderOverlay(
  image: { bytes: Uint8Array; width: number; height: number },
  regions: PricedRegion[],
  svgPaths: Map<string, string[]>,
  totalCents: number,
  language: Language,
): Promise<{ png: Uint8Array; width: number; height: number }> {
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
  for (const group of [...groups.values()].sort((a, b) => a.box.top - b.box.top || b.area - a.area)) {
    const rows = await Promise.all(group.regions.map((region) => textImage(lineLabel(region, language), px, maxText)));
    const pill = {
      width: pad * 2 + dot + pad + Math.max(...rows.map((row) => row.width)),
      height: pad * 2 + rows.length * rowHeight - (rowHeight - px) + Math.round(px * 0.2),
    };
    const rect: Rect = {
      x: Math.max(0, Math.min(width - pill.width, group.box.left + pad)),
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
      const top = rect.y + pad + i * rowHeight;
      const middle = top + Math.round(row.height / 2);
      shapes.push(`<circle cx="${rect.x + pad + dot / 2}" cy="${middle}" r="${dot / 2}" fill="${color(group.regions[i])}"/>`);
      texts.push({ input: row.input, left: rect.x + pad + dot + pad, top });
    });
  }

  // Legend: every line, located or not, then the quote's total.
  const legendRows = await Promise.all(
    regions.map(async (region) => ({
      region,
      label: await textImage(lineLabel(region, language), px, maxText),
      note: region.located ? null : await textImage(`(${copy.notLocated})`, px, maxText, "#a1a1aa"),
    })),
  );
  const total = await textImage(`${copy.total} ${formatCents(totalCents, language)}`, Math.round(px * 1.1), maxText);
  const legendHeight = pad * 2 + legendRows.length * rowHeight + Math.round(px * 0.5) + total.height + pad * 2;
  shapes.push(`<rect x="0" y="${height}" width="${width}" height="${legendHeight}" fill="${PILL}"/>`);
  legendRows.forEach(({ region, label, note }, i) => {
    const top = height + pad * 2 + i * rowHeight;
    const middle = top + Math.round(label.height / 2);
    const swatch = Math.round(px * 0.8);
    const x = pad * 2;
    shapes.push(
      `<rect x="${x}" y="${middle - swatch / 2}" width="${swatch}" height="${swatch}" rx="3" fill="${color(region)}" fill-opacity="${region.located ? 1 : 0.35}"/>`,
    );
    texts.push({ input: label.input, left: x + swatch + pad, top });
    if (note) texts.push({ input: note.input, left: Math.min(width - note.width, x + swatch + pad + label.width + pad), top });
  });
  const totalTop = height + pad * 2 + legendRows.length * rowHeight + Math.round(px * 0.5);
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
