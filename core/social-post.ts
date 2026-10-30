// A social post from a quote's before-and-after: the two photos cropped to match, side by side for a feed
// (square) or stacked for a story, with "Before" and "After" labels and the business's name (and logo)
// under them, and a line asking for the next job when `cta` is on. Lightly evened out, nothing more: no
// outlines, no prices, nothing from the customer's address. Drawn on demand with sharp: no SAM call.
import sharp, { type OverlayOptions } from "sharp";
import { formatPhone } from "../lib/format";
import { beforeAfterFor, type BeforeAfter } from "./before-after";
import { loadLogo } from "./branding";
import type { Language } from "./language";
import type { PdfLogo } from "./pdf";
import { PILL, preparePhoto, textImage } from "./priced-photo";
import { getProfile } from "./profile";

export const POST_FORMATS = ["square", "story"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

/** Who the post is from. Only the name, a way to reach them, and the logo: never the address. */
export type PostBusiness = { name: string; phone: string | null; email: string | null; logo?: PdfLogo | null };

/** The image sizes the networks take: 1080 square for a feed, 1080 by 1920 for a story. */
export const POST_SIZES: Record<PostFormat, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
};
/** The band under the photos is at least this tall, and taller only when a long name wraps. */
const MIN_BAND: Record<PostFormat, number> = { square: 168, story: 240 };
/** Between the two photos. */
const GAP = 8;
const PAD = 40;
const LABEL_PX = 36;
const NAME_PX = 44;
const CTA_PX = 32;
/** The logo sits on a white tile, so a dark logo still reads on the dark band. */
const LOGO_MAX = { width: 220, height: 96 };
const LOGO_PAD = 10;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where each photo goes on a post with a band `band` px tall: side by side on a square, stacked on a
 * story, both the same size with `GAP` between them, filling everything above the band.
 */
export function socialPostLayout(format: PostFormat, band: number): { width: number; height: number; before: Rect; after: Rect } {
  const { width, height } = POST_SIZES[format];
  const area = height - band;
  if (format === "square") {
    const half = Math.floor((width - GAP) / 2);
    return { width, height, before: { x: 0, y: 0, width: half, height: area }, after: { x: width - half, y: 0, width: half, height: area } };
  }
  const half = Math.floor((area - GAP) / 2);
  return { width, height, before: { x: 0, y: 0, width, height: half }, after: { x: 0, y: area - half, width, height: half } };
}

const COPY: Record<
  Language,
  { before: string; after: string; intro: string; text: (phone: string) => string; email: (email: string) => string }
> = {
  en: {
    before: "Before",
    after: "After",
    intro: "Before and after",
    text: (phone) => `Want yours done? Text ${phone}`,
    email: (email) => `Want yours done? Email ${email}`,
  },
  es: {
    before: "Antes",
    after: "Después",
    intro: "Antes y después",
    text: (phone) => `¿Quieres que hagamos el tuyo? Escríbenos al ${phone}`,
    email: (email) => `¿Quieres que hagamos el tuyo? Escríbenos a ${email}`,
  },
};

/** The line asking for the next job: by text when the business has a phone, else by email; null with neither. */
export function callToAction(business: Pick<PostBusiness, "phone" | "email">, language: Language): string | null {
  const copy = COPY[language];
  if (business.phone?.trim()) return copy.text(formatPhone(business.phone.trim()));
  if (business.email?.trim()) return copy.email(business.email.trim());
  return null;
}

/** The quote's line names as the after photo was priced with them, each once. */
export function postLines(pair: Pick<BeforeAfter, "after">): string[] {
  return [...new Set(pair.after.regions.map((region) => region.name.trim()).filter(Boolean))];
}

/**
 * The post's caption: "Before and after: mulch installed, bed edging, and hedge trimming." and, with
 * `cta`, the line asking for the next job. Written in code, the same every time.
 */
export function socialCaption(lines: string[], business: Pick<PostBusiness, "phone" | "email">, options: { cta: boolean; language: Language }): string {
  const { language } = options;
  const named = lines.map((line) => line.toLocaleLowerCase(language));
  const intro = named.length > 0 ? `${COPY[language].intro}: ${new Intl.ListFormat(language, { type: "conjunction" }).format(named)}.` : `${COPY[language].intro}.`;
  const cta = options.cta ? callToAction(business, language) : null;
  return cta ? `${intro} ${cta}.` : intro;
}

/**
 * Draws the post. Each photo is center-cropped to its half and scaled to fill it, its levels stretched
 * and its colors lifted a little, then labeled; the band under them has the logo (if any), the name, and
 * the call to action when `cta` is on. Throws `UNREADABLE_PHOTO` when either photo can't be read.
 */
export async function renderSocialPost(
  pair: BeforeAfter,
  options: { format: PostFormat; cta: boolean; language: Language; business: PostBusiness },
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const [before, after] = await Promise.all([preparePhoto(pair.before.sourceUrl), preparePhoto(pair.after.sourceUrl)]);
  if (!before || !after) throw new Error("UNREADABLE_PHOTO");
  const { format, business } = options;
  const copy = COPY[options.language];
  const { width } = POST_SIZES[format];

  // The band: the logo on its tile, then the name over the call to action, all centered on the band.
  const logo = business.logo ? await logoTile(business.logo).catch(() => null) : null;
  const textLeft = PAD + (logo ? logo.width + PAD * 0.75 : 0);
  const textWidth = width - textLeft - PAD;
  const name = await textImage(business.name, NAME_PX, textWidth);
  const ctaLine = options.cta ? callToAction(business, options.language) : null;
  const cta = ctaLine ? await textImage(ctaLine, CTA_PX, textWidth, "#d9d9d9") : null;
  const textHeight = name.height + (cta ? Math.round(CTA_PX * 0.4) + cta.height : 0);
  const band = Math.max(MIN_BAND[format], textHeight + PAD * 2, (logo?.height ?? 0) + PAD * 2);
  const layout = socialPostLayout(format, band);
  const bandTop = layout.height - band;

  const layers: OverlayOptions[] = [];
  const pills: string[] = [];
  const labels: OverlayOptions[] = [];
  const pad = Math.round(LABEL_PX * 0.5);
  const sides = [
    { photo: before, rect: layout.before, label: await textImage(copy.before, LABEL_PX, layout.before.width - pad * 4) },
    { photo: after, rect: layout.after, label: await textImage(copy.after, LABEL_PX, layout.after.width - pad * 4) },
  ];
  const pillHeight = Math.max(...sides.map((side) => side.label.height)) + pad;
  for (const { photo, rect, label } of sides) {
    const half = await sharp(photo.bytes)
      .resize(rect.width, rect.height, { fit: "cover", position: "centre" })
      .normalise()
      .modulate({ saturation: 1.08 })
      .toBuffer();
    layers.push({ input: half, left: rect.x, top: rect.y });
    const pill = { x: rect.x + PAD / 2, y: rect.y + PAD / 2, width: label.width + pad * 2, height: pillHeight };
    pills.push(`<rect x="${pill.x}" y="${pill.y}" width="${pill.width}" height="${pill.height}" rx="${Math.round(LABEL_PX * 0.6)}" fill="${PILL}" fill-opacity="0.85"/>`);
    labels.push({ input: label.input, left: pill.x + pad, top: pill.y + Math.round((pillHeight - label.height) / 2) });
  }

  if (logo) layers.push({ input: logo.input, left: PAD, top: bandTop + Math.round((band - logo.height) / 2) });
  const textTop = bandTop + Math.round((band - textHeight) / 2);
  labels.push({ input: name.input, left: Math.round(textLeft), top: textTop });
  if (cta) labels.push({ input: cta.input, left: Math.round(textLeft), top: textTop + name.height + Math.round(CTA_PX * 0.4) });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}">${pills.join("")}</svg>`;
  const png = await sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: PILL } })
    .composite([...layers, { input: Buffer.from(svg), top: 0, left: 0 }, ...labels])
    .png()
    .toBuffer();
  return { png: new Uint8Array(png), width: layout.width, height: layout.height };
}

/** The logo scaled into `LOGO_MAX` on a white rounded tile. */
async function logoTile(logo: PdfLogo): Promise<{ input: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(logo.bytes)
    .resize({ width: LOGO_MAX.width, height: LOGO_MAX.height, fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const width = info.width + LOGO_PAD * 2;
  const height = info.height + LOGO_PAD * 2;
  const tile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="12" fill="#ffffff"/></svg>`);
  const input = await sharp(tile)
    .composite([{ input: data, left: LOGO_PAD, top: LOGO_PAD }])
    .png()
    .toBuffer();
  return { input, width, height };
}

/** The business as its posts show it: name, phone, email, and logo from its profile and branding. */
export async function postBusinessFor(orgId: string): Promise<PostBusiness> {
  const [profile, logo] = await Promise.all([getProfile(orgId), loadLogo(orgId)]);
  return { name: profile.name, phone: profile.phone, email: profile.email, logo };
}

/**
 * The quote's post, drawn, with its caption; null when the quote has no before-and-after. Throws
 * `UNREADABLE_PHOTO` when either photo can't be read.
 */
export async function socialPostFor(
  orgId: string,
  quoteId: string,
  options: { format: PostFormat; cta: boolean; language: Language },
): Promise<{ pair: BeforeAfter; png: Uint8Array; width: number; height: number; caption: string } | null> {
  const pair = await beforeAfterFor(orgId, quoteId);
  if (!pair) return null;
  const business = await postBusinessFor(orgId);
  const drawn = await renderSocialPost(pair, { ...options, business });
  return { pair, ...drawn, caption: socialCaption(postLines(pair), business, options) };
}
