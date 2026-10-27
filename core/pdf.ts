// Renders the customer-facing quote PDF. Standard Helvetica (WinAnsi) only: every piece of
// user-provided text goes through `safeText` so an emoji or odd symbol is replaced, never thrown.
// A business's branding (its logo, and from its profile an accent colour, closing lines, and which
// contact facts print) changes the look; without any, the PDF is exactly the plain one.
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { Adjustment, LineResult, RuleLine } from "./calculator";
import { formatCents } from "./money";
import { formatDateOnly, localeFor, type Language } from "./language";
import { pdfCopy, type PdfCopy } from "./pdf-copy";
import { accentColors, normalizeHex, type AccentColors, type PdfDetail, type Rgb } from "./pdf-style";
import type { Profile } from "./profile";

export interface QuotePdfDocument {
  profile: Profile;
  quoteId: string;
  title: string;
  status: string;
  revision: {
    number: number;
    lines: LineResult[];
    ruleLines: RuleLine[];
    adjustments: Adjustment[];
    subtotalCents: number;
    minimumAppliedCents: number;
    adjustmentCents: number;
    taxRateBp: number | null;
    taxCents: number;
    totalCents: number;
    validUntil: string;
    customerNotes: string | null;
  };
  customer: { name: string; phones: string[]; emails: string[] } | null;
  property: { address: string } | null;
  language: Language;
  /** Photos attached to the quote, printed after the totals. JPEG and PNG only. */
  photos?: QuotePdfPhoto[];
  /** The business's logo, at the top of the header. */
  logo?: PdfLogo | null;
  /** The customer's link to approve the quote online, printed under the totals. */
  approveUrl?: string | null;
}

export interface QuotePdfPhoto {
  bytes: Uint8Array;
  mimeType: string;
}

/** A normalized logo (`core/logo.ts`): PNG or JPEG. */
export type PdfLogo = QuotePdfPhoto;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const LEFT = MARGIN;
const RIGHT = PAGE_WIDTH - MARGIN;
const BOTTOM = MARGIN + 18; // leaves room for the page footer
// Table columns: service text on the left, then right edges for the numeric columns.
const SERVICE_WIDTH = 262;
const QTY_RIGHT = 390;
const UNIT_RIGHT = 474;
const AMOUNT_RIGHT = RIGHT;
const LABEL_RIGHT = UNIT_RIGHT;

const INK = rgb(0.12, 0.13, 0.15);
const MUTED = rgb(0.42, 0.44, 0.47);
const RULE = rgb(0.84, 0.85, 0.87);
const BAND = rgb(0.95, 0.96, 0.97);
const WATERMARK = rgb(0.9, 0.9, 0.91);

const MAX_FILE_STEM = 80;
// The logo's box at the top left of the header; it's scaled to fit, keeping its shape.
const LOGO_MAX_WIDTH = 200;
const LOGO_MAX_HEIGHT = 60;

/** Replace anything the font cannot encode (emoji, CJK, controls) with "?" and collapse whitespace. */
function safeText(text: string, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const raw of text.normalize("NFC")) {
    let ch = raw;
    if (/\s/u.test(ch)) ch = " ";
    else if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(ch)) continue; // controls, zero-width, lone surrogates
    if (supported.has(ch.codePointAt(0)!)) {
      out += ch;
      continue;
    }
    // Try the base letter without its accent before giving up.
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
    out += base && [...base].every((c) => supported.has(c.codePointAt(0)!)) ? base : "?";
  }
  return out.replace(/ {2,}/g, " ").trim();
}

interface Ctx {
  pdf: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  copy: PdfCopy;
  language: Language;
  watermark: string | null;
  pages: PDFPage[];
  /** The business's accent, or null for the plain look. */
  accent: Record<keyof AccentColors, ReturnType<typeof rgb>> | null;
  logo: PDFImage | null;
}

const toRgb = ([r, g, b]: Rgb) => rgb(r, g, b);

/** The parts of a context that come from the business's branding. */
async function brandingOf(pdf: PDFDocument, profile: Profile, logo: PdfLogo | null | undefined): Promise<Pick<Ctx, "accent" | "logo">> {
  const hex = profile.pdfAccentColor ? normalizeHex(profile.pdfAccentColor) : null;
  const colors = hex ? accentColors(hex) : null;
  let image: PDFImage | null = null;
  if (logo) {
    try {
      image = /png/i.test(logo.mimeType) ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
    } catch (error) {
      console.warn("pdf: the logo could not be embedded, left off", error);
    }
  }
  return {
    accent: colors && { fill: toRgb(colors.fill), onFill: toRgb(colors.onFill), text: toRgb(colors.text), tint: toRgb(colors.tint) },
    logo: image,
  };
}

function fontOf(ctx: Ctx, strong: boolean): PDFFont {
  return strong ? ctx.bold : ctx.regular;
}

function clean(ctx: Ctx, text: string, strong = false): string {
  return safeText(text, fontOf(ctx, strong));
}

/** Truncate with an ellipsis so a single-line cell never runs into its neighbour. */
function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

/** Greedy word wrap that also breaks words longer than the column. */
function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ").filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const ch of word) {
        if (line && font.widthOfTextAtSize(line + ch, size) > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Wrap user text: sanitize each paragraph first, keep blank-line structure. */
function wrapUser(ctx: Ctx, text: string, size: number, maxWidth: number, strong = false): string[] {
  const paragraphs = text.split(/\r\n|\r|\n/).map((p) => clean(ctx, p, strong));
  return wrap(fontOf(ctx, strong), paragraphs.join("\n"), size, maxWidth);
}

function drawText(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  size: number,
  options: { strong?: boolean; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {},
): void {
  if (!text) return;
  const font = fontOf(ctx, options.strong ?? false);
  const left = options.align === "right" ? x - font.widthOfTextAtSize(text, size) : x;
  ctx.page.drawText(text, { x: left, y, size, font, color: options.color ?? INK });
}

function addPage(ctx: Ctx): void {
  ctx.page = ctx.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.pages.push(ctx.page);
  ctx.y = PAGE_HEIGHT - MARGIN;
  if (ctx.watermark) {
    const size = Math.min(110, (560 * 110) / ctx.bold.widthOfTextAtSize(ctx.watermark, 110));
    const width = ctx.bold.widthOfTextAtSize(ctx.watermark, size);
    // Rotate 45 degrees about the page centre.
    const angle = Math.PI / 4;
    const cx = PAGE_WIDTH / 2;
    const cy = PAGE_HEIGHT / 2;
    ctx.page.drawText(ctx.watermark, {
      x: cx - (width / 2) * Math.cos(angle) + (size * 0.35) * Math.sin(angle),
      y: cy - (width / 2) * Math.sin(angle) - (size * 0.35) * Math.cos(angle),
      size,
      font: ctx.bold,
      color: WATERMARK,
      rotate: degrees(45),
    });
  }
}

/** Starts a new page (and runs `onNewPage`, e.g. a repeated table header) when `height` does not fit. */
function newPageIfNeeded(ctx: Ctx, height: number, onNewPage?: () => void): void {
  if (ctx.y - height >= BOTTOM) return;
  addPage(ctx);
  onNewPage?.();
}

function hairline(ctx: Ctx, y = ctx.y): void {
  ctx.page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.6, color: RULE });
}

const BODY = 10;
const LEADING = 14;

function tableHeader(ctx: Ctx): void {
  const top = ctx.y;
  ctx.page.drawRectangle({ x: LEFT, y: top - 20, width: RIGHT - LEFT, height: 22, color: ctx.accent?.fill ?? BAND });
  const y = top - 14;
  const size = 9;
  const color = ctx.accent?.onFill ?? MUTED;
  drawText(ctx, clean(ctx, ctx.copy.service, true), LEFT + 6, y, size, { strong: true, color });
  drawText(ctx, clean(ctx, ctx.copy.qty, true), QTY_RIGHT, y, size, { strong: true, color, align: "right" });
  drawText(ctx, clean(ctx, ctx.copy.unit, true), UNIT_RIGHT, y, size, { strong: true, color, align: "right" });
  drawText(ctx, clean(ctx, ctx.copy.amount, true), AMOUNT_RIGHT - 6, y, size, { strong: true, color, align: "right" });
  ctx.y = top - 28;
}

/** One table row: wrapped service text plus right-aligned numeric cells. */
function drawRow(
  ctx: Ctx,
  row: { service: string; qty?: string; unit?: string; amount?: string; muted?: boolean },
): void {
  const lines = wrapUser(ctx, row.service, BODY, SERVICE_WIDTH);
  const height = lines.length * LEADING + 6;
  newPageIfNeeded(ctx, height, () => tableHeader(ctx));
  const color = row.muted ? MUTED : INK;
  const top = ctx.y;
  lines.forEach((text, i) => drawText(ctx, text, LEFT + 6, top - 11 - i * LEADING, BODY, { color }));
  const y = top - 11;
  if (row.qty) drawText(ctx, fit(ctx.regular, row.qty, BODY, QTY_RIGHT - (LEFT + SERVICE_WIDTH + 12)), QTY_RIGHT, y, BODY, { align: "right" });
  if (row.unit) drawText(ctx, fit(ctx.regular, row.unit, BODY, UNIT_RIGHT - QTY_RIGHT - 6), UNIT_RIGHT, y, BODY, { align: "right" });
  if (row.amount) drawText(ctx, row.amount, AMOUNT_RIGHT - 6, y, BODY, { align: "right", color });
  ctx.y = top - height;
  hairline(ctx, ctx.y + 3);
}

/** A totals row: label right-aligned beside the amount column. */
function drawMoneyRow(ctx: Ctx, label: string, cents: number, options: { strong?: boolean; size?: number } = {}): void {
  const size = options.size ?? BODY;
  const strong = options.strong ?? false;
  newPageIfNeeded(ctx, size + 10);
  const y = ctx.y - size - 2;
  const text = fit(fontOf(ctx, strong), clean(ctx, label, strong), size, LABEL_RIGHT - (LEFT + 120));
  drawText(ctx, text, LABEL_RIGHT, y, size, { strong, color: strong ? INK : MUTED, align: "right" });
  drawText(ctx, formatCents(cents, ctx.language), AMOUNT_RIGHT - 6, y, size, { strong, align: "right" });
  ctx.y -= size + 10;
}

function formatQuantity(quantity: number, language: Language): string {
  return new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: 2 }).format(quantity);
}

function formatRate(bp: number, language: Language): string {
  return new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: 2 }).format(bp / 100);
}

function textBlock(ctx: Ctx, lines: string[], size: number, options: { strong?: boolean; color?: ReturnType<typeof rgb>; x?: number } = {}): void {
  for (const text of lines) {
    newPageIfNeeded(ctx, size + 4);
    drawText(ctx, text, options.x ?? LEFT, ctx.y - size, size, options);
    ctx.y -= size + 4;
  }
}

function drawHeader(ctx: Ctx, doc: QuotePdfDocument): void {
  const subtitle = doc.revision.number > 1 ? [ctx.copy.revision(doc.revision.number)] : [];
  drawDocumentHeader(ctx, doc.profile, ctx.copy.quote, doc.title, subtitle);
}

/** The business block on the left; the document's label, its title, and small lines under it on the right. */
function drawDocumentHeader(ctx: Ctx, profile: Profile, label: string, title: string, small: string[]): void {
  const top = ctx.y;
  const rightColumn = 190;
  const leftWidth = RIGHT - LEFT - rightColumn - 16;

  // Right column: document label, title, then the small lines (a revision, an invoice number).
  let ry = top - 22;
  drawText(ctx, clean(ctx, label.toUpperCase(), true), RIGHT, ry, 22, { strong: true, align: "right", color: ctx.accent?.text });
  ry -= 18;
  for (const text of wrapUser(ctx, title, 11, rightColumn).slice(0, 3)) {
    drawText(ctx, text, RIGHT, ry, 11, { align: "right", color: MUTED });
    ry -= 14;
  }
  for (const line of small) {
    drawText(ctx, clean(ctx, line), RIGHT, ry, 9, { align: "right", color: MUTED });
    ry -= 13;
  }

  // Left column: the logo, then the business block.
  let ly = top;
  if (ctx.logo) {
    const scale = Math.min(Math.min(LOGO_MAX_WIDTH, leftWidth) / ctx.logo.width, LOGO_MAX_HEIGHT / ctx.logo.height);
    const width = ctx.logo.width * scale;
    const height = ctx.logo.height * scale;
    ctx.page.drawImage(ctx.logo, { x: LEFT, y: ly - height, width, height });
    ly -= height + 8;
  }
  for (const text of wrapUser(ctx, profile.name, 20, leftWidth, true).slice(0, 2)) {
    drawText(ctx, text, LEFT, ly - 20, 20, { strong: true });
    ly -= 24;
  }
  const hidden = new Set<PdfDetail>((profile.pdfHiddenDetails ?? []) as PdfDetail[]);
  const contact = [
    hidden.has("address") ? null : profile.address,
    hidden.has("phone") ? null : profile.phone,
    hidden.has("email") ? null : profile.email,
    profile.licenseNumber && !hidden.has("licenseNumber") ? `${ctx.copy.license} ${profile.licenseNumber}` : null,
  ].filter((v): v is string => Boolean(v && v.trim()));
  for (const item of contact) {
    for (const text of wrapUser(ctx, item, 9.5, leftWidth).slice(0, 2)) {
      drawText(ctx, text, LEFT, ly - 12, 9.5, { color: MUTED });
      ly -= 13;
    }
  }

  ctx.y = Math.min(ly, ry) - 12;
  if (ctx.accent) ctx.page.drawLine({ start: { x: LEFT, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 2, color: ctx.accent.fill });
  else hairline(ctx);
  ctx.y -= 16;
}

function drawParties(ctx: Ctx, doc: QuotePdfDocument): void {
  const half = (RIGHT - LEFT) / 2 - 10;
  const left: string[] = [];
  if (doc.customer) {
    left.push(...wrapUser(ctx, doc.customer.name, BODY + 1, half, true));
    for (const v of [...doc.customer.phones, ...doc.customer.emails]) left.push(...wrapUser(ctx, v, BODY, half));
  }
  if (doc.property?.address) left.push(...wrapUser(ctx, doc.property.address, BODY, half));
  const validText = formatDateOnly(doc.revision.validUntil, doc.language);

  const blockHeight = 14 + Math.max(left.length, 2) * LEADING;
  newPageIfNeeded(ctx, blockHeight);
  const top = ctx.y;
  if (left.length > 0) {
    drawText(ctx, clean(ctx, ctx.copy.preparedFor.toUpperCase(), true), LEFT, top - 9, 8, { strong: true, color: MUTED });
    let y = top - 9 - 4;
    left.forEach((text, i) => {
      y -= LEADING;
      drawText(ctx, text, LEFT, y, i === 0 && doc.customer ? BODY + 1 : BODY, { strong: i === 0 && Boolean(doc.customer) });
    });
  }
  const rx = LEFT + half + 20;
  drawText(ctx, clean(ctx, ctx.copy.validUntil.toUpperCase(), true), rx, top - 9, 8, { strong: true, color: MUTED });
  drawText(ctx, clean(ctx, validText), rx, top - 9 - 4 - LEADING, BODY + 1, { strong: true });
  ctx.y = top - blockHeight - 14;
}

function drawTotals(ctx: Ctx, doc: QuotePdfDocument): void {
  const rev = doc.revision;
  const rows: Array<{ label: string; cents: number }> = [{ label: ctx.copy.subtotal, cents: rev.subtotalCents }];
  if (rev.minimumAppliedCents !== 0) rows.push({ label: ctx.copy.minimumAdjustment, cents: rev.minimumAppliedCents });
  if (rev.adjustmentCents !== 0) {
    const isOverride = rev.adjustments.some((a) => a.kind === "override");
    rows.push({ label: isOverride ? ctx.copy.override : ctx.copy.discount, cents: rev.adjustmentCents });
  }
  if (rev.taxRateBp !== null) {
    rows.push({ label: ctx.copy.tax(formatRate(rev.taxRateBp, doc.language)), cents: rev.taxCents });
  }
  // Keep the whole totals block together.
  newPageIfNeeded(ctx, rows.length * 22 + 48, () => tableHeader(ctx));
  ctx.y -= 4;
  for (const row of rows) drawMoneyRow(ctx, row.label, row.cents);
  ctx.y -= 2;
  ctx.page.drawLine({ start: { x: LABEL_RIGHT - 150, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 1, color: INK });
  ctx.y -= 4;
  drawMoneyRow(ctx, ctx.copy.total, rev.totalCents, { strong: true, size: 13 });
}

export async function renderQuotePdf(doc: QuotePdfDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const copy = pdfCopy(doc.language);
  const isDraft = doc.status === "draft" || doc.status === "needs_owner";
  // Marks the file itself, not just the watermark, so a draft can be told apart by tests and tools.
  if (isDraft) pdf.setKeywords(["draft"]);
  const ctx: Ctx = {
    pdf,
    page: undefined as unknown as PDFPage, // set by addPage below
    y: 0,
    regular,
    bold,
    copy,
    language: doc.language,
    watermark: isDraft ? safeText(copy.draftWatermark, bold) : null,
    pages: [],
    ...(await brandingOf(pdf, doc.profile, doc.logo)),
  };
  addPage(ctx);

  drawHeader(ctx, doc);
  drawParties(ctx, doc);

  tableHeader(ctx);
  const rev = doc.revision;
  for (const line of rev.lines) {
    const unitPrice = line.unitCents === null ? "-" : formatCents(line.unitCents, doc.language);
    drawRow(ctx, {
      service: line.name,
      qty: `${formatQuantity(line.quantity, doc.language)}${line.unitLabel ? ` ${clean(ctx, line.unitLabel)}` : ""}`,
      unit: unitPrice,
      amount: line.totalCents === null ? "-" : formatCents(line.totalCents, doc.language),
    });
  }
  for (const rule of rev.ruleLines) {
    drawRow(ctx, { service: rule.label, amount: formatCents(rule.cents, doc.language), muted: true });
  }

  drawTotals(ctx, doc);

  if (doc.approveUrl && !isDraft) {
    ctx.y -= 16;
    drawLinkBox(ctx, copy.approveOnline, copy.approveOnlineHelp, doc.approveUrl);
  }

  if (rev.customerNotes && rev.customerNotes.trim()) {
    ctx.y -= 16;
    newPageIfNeeded(ctx, 40);
    textBlock(ctx, [clean(ctx, copy.notes.toUpperCase(), true)], 8, { strong: true, color: MUTED });
    ctx.y -= 2;
    textBlock(ctx, wrapUser(ctx, rev.customerNotes, BODY, RIGHT - LEFT), BODY);
  }

  ctx.y -= 18;
  textBlock(ctx, wrapUser(ctx, doc.profile.quoteFooter?.trim() || copy.thanks, BODY, RIGHT - LEFT), BODY, { color: MUTED });

  await drawPhotos(ctx, doc.photos ?? []);

  // Footer on every page, now that the page count is known.
  const total = ctx.pages.length;
  ctx.pages.forEach((page, index) => {
    ctx.page = page;
    const left = clean(ctx, `${copy.preparedBy} ${doc.profile.name}`);
    drawText(ctx, fit(regular, left, 8, 380), LEFT, MARGIN - 6, 8, { color: MUTED });
    if (total > 1) drawText(ctx, `${index + 1} / ${total}`, RIGHT, MARGIN - 6, 8, { color: MUTED, align: "right" });
  });

  return pdf.save();
}

const PHOTO_GAP = 14;
// Two photos fit a page under the heading.
const PHOTO_MAX_HEIGHT = (PAGE_HEIGHT - MARGIN - BOTTOM - 30 - PHOTO_GAP) / 2;

/** Photos on their own pages under `heading`, each scaled to fit the column, two to a page. One that won't embed is skipped. */
async function drawPhotos(ctx: Ctx, photos: QuotePdfPhoto[], heading = ctx.copy.photos): Promise<void> {
  const images = [];
  for (const photo of photos) {
    try {
      images.push(/png/i.test(photo.mimeType) ? await ctx.pdf.embedPng(photo.bytes) : await ctx.pdf.embedJpg(photo.bytes));
    } catch (error) {
      console.warn("pdf: a photo could not be embedded, skipped", error);
    }
  }
  if (images.length === 0) return;
  addPage(ctx);
  textBlock(ctx, [clean(ctx, heading.toUpperCase(), true)], 8, { strong: true, color: MUTED });
  ctx.y -= 8;
  for (const image of images) {
    const scale = Math.min((RIGHT - LEFT) / image.width, PHOTO_MAX_HEIGHT / image.height, 1);
    const width = image.width * scale;
    const height = image.height * scale;
    newPageIfNeeded(ctx, height);
    ctx.page.drawImage(image, { x: LEFT + (RIGHT - LEFT - width) / 2, y: ctx.y - height, width, height });
    ctx.y -= height + PHOTO_GAP;
  }
}

/** ASCII-safe download name, e.g. "Quote - 4512 Palm Ave - r2.pdf". */
export function pdfFileName(title: string, revisionNumber: number, language: Language): string {
  const stem = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[\u2010-\u2015\-/\\|:]+/) // dashes and separators become a plain " - "
    .map((part) => part.replace(/[^A-Za-z0-9 ]+/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" - ")
    .slice(0, MAX_FILE_STEM)
    .replace(/[ -]+$/, "");
  return [pdfCopy(language).quote, stem, `r${revisionNumber}`].filter(Boolean).join(" - ") + ".pdf";
}

// ---------------------------------------------------------------------------------------------
// Invoices

export interface InvoicePdfDocument {
  profile: Profile;
  /** "INV-0001". */
  label: string;
  title: string;
  status: "draft" | "sent" | "partially_paid" | "paid" | "void";
  /** `YYYY-MM-DD`; null on a draft that hasn't been issued. */
  issueDate: string | null;
  dueDate: string | null;
  lines: LineResult[];
  ruleLines: RuleLine[];
  adjustments: Adjustment[];
  subtotalCents: number;
  minimumAppliedCents: number;
  adjustmentCents: number;
  taxRateBp: number | null;
  taxCents: number;
  totalCents: number;
  amountPaidCents: number;
  notes: string | null;
  customer: { name: string; phones: string[]; emails: string[] } | null;
  property: { address: string } | null;
  /** Where the customer pays by card; null when the business doesn't take card payments online. */
  payUrl: string | null;
  language: Language;
  /** The business's logo, at the top of the header. */
  logo?: PdfLogo | null;
  /** Photos of the work chosen for it, printed after the invoice. JPEG and PNG only. */
  photos?: QuotePdfPhoto[];
}

function drawBillTo(ctx: Ctx, doc: InvoicePdfDocument): void {
  const half = (RIGHT - LEFT) / 2 - 10;
  const left: string[] = [];
  if (doc.customer) {
    left.push(...wrapUser(ctx, doc.customer.name, BODY + 1, half, true));
    for (const v of [...doc.customer.phones, ...doc.customer.emails]) left.push(...wrapUser(ctx, v, BODY, half));
  }
  if (doc.property?.address) left.push(...wrapUser(ctx, doc.property.address, BODY, half));
  const dates: Array<[string, string]> = [];
  if (doc.issueDate) dates.push([ctx.copy.invoiceDate, formatDateOnly(doc.issueDate, doc.language)]);
  if (doc.dueDate) {
    dates.push([ctx.copy.dueDate, doc.issueDate === doc.dueDate ? ctx.copy.dueOnReceipt : formatDateOnly(doc.dueDate, doc.language)]);
  }
  const blockHeight = 14 + Math.max(left.length, dates.length * 2, 2) * LEADING;
  newPageIfNeeded(ctx, blockHeight);
  const top = ctx.y;
  if (left.length > 0) {
    drawText(ctx, clean(ctx, ctx.copy.billTo.toUpperCase(), true), LEFT, top - 9, 8, { strong: true, color: MUTED });
    let y = top - 9 - 4;
    left.forEach((text, i) => {
      y -= LEADING;
      drawText(ctx, text, LEFT, y, i === 0 && doc.customer ? BODY + 1 : BODY, { strong: i === 0 && Boolean(doc.customer) });
    });
  }
  const rx = LEFT + half + 20;
  let y = top - 9;
  for (const [label, value] of dates) {
    drawText(ctx, clean(ctx, label.toUpperCase(), true), rx, y, 8, { strong: true, color: MUTED });
    drawText(ctx, clean(ctx, value), rx, y - 4 - LEADING, BODY + 1, { strong: true });
    y -= 2 * LEADING + 6;
  }
  ctx.y = top - blockHeight - 14;
}

function drawInvoiceTotals(ctx: Ctx, doc: InvoicePdfDocument): void {
  const rows: Array<{ label: string; cents: number }> = [{ label: ctx.copy.subtotal, cents: doc.subtotalCents }];
  if (doc.minimumAppliedCents !== 0) rows.push({ label: ctx.copy.minimumAdjustment, cents: doc.minimumAppliedCents });
  if (doc.adjustmentCents !== 0) {
    const isOverride = doc.adjustments.some((a) => a.kind === "override");
    rows.push({ label: isOverride ? ctx.copy.override : ctx.copy.discount, cents: doc.adjustmentCents });
  }
  if (doc.taxRateBp !== null) rows.push({ label: ctx.copy.tax(formatRate(doc.taxRateBp, doc.language)), cents: doc.taxCents });
  const paid = doc.amountPaidCents > 0;
  newPageIfNeeded(ctx, rows.length * 22 + (paid ? 100 : 48), () => tableHeader(ctx));
  ctx.y -= 4;
  for (const row of rows) drawMoneyRow(ctx, row.label, row.cents);
  ctx.y -= 2;
  ctx.page.drawLine({ start: { x: LABEL_RIGHT - 150, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 1, color: INK });
  ctx.y -= 4;
  drawMoneyRow(ctx, ctx.copy.total, doc.totalCents, { strong: !paid, size: paid ? BODY + 1 : 13 });
  if (paid) {
    drawMoneyRow(ctx, ctx.copy.paid, -doc.amountPaidCents);
    ctx.y -= 2;
    ctx.page.drawLine({ start: { x: LABEL_RIGHT - 150, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 1, color: INK });
    ctx.y -= 4;
    drawMoneyRow(ctx, ctx.copy.balanceDue, Math.max(0, doc.totalCents - doc.amountPaidCents), { strong: true, size: 13 });
  }
}

/** The pay link, in a tinted band, so a customer reading the PDF sees how to pay. */
function drawLinkBox(ctx: Ctx, title: string, help: string, url: string): void {
  const lines = wrap(ctx.regular, clean(ctx, url), BODY, RIGHT - LEFT - 24);
  const height = 34 + lines.length * LEADING;
  newPageIfNeeded(ctx, height + 8);
  const top = ctx.y;
  ctx.page.drawRectangle({ x: LEFT, y: top - height, width: RIGHT - LEFT, height, color: ctx.accent?.tint ?? BAND });
  drawText(ctx, clean(ctx, title.toUpperCase(), true), LEFT + 12, top - 16, 8, { strong: true, color: ctx.accent?.text ?? MUTED });
  drawText(ctx, clean(ctx, help), LEFT + 12, top - 30, BODY, { color: INK });
  lines.forEach((text, i) => drawText(ctx, text, LEFT + 12, top - 30 - (i + 1) * LEADING, BODY, { strong: true }));
  ctx.y = top - height - 8;
}

function drawFooters(ctx: Ctx, preparedBy: string): void {
  const total = ctx.pages.length;
  ctx.pages.forEach((page, index) => {
    ctx.page = page;
    drawText(ctx, fit(ctx.regular, clean(ctx, preparedBy), 8, 380), LEFT, MARGIN - 6, 8, { color: MUTED });
    if (total > 1) drawText(ctx, `${index + 1} / ${total}`, RIGHT, MARGIN - 6, 8, { color: MUTED, align: "right" });
  });
}

/** The customer-facing invoice: dates, lines, totals, what's been paid, the balance, the pay link, and any photos of the work. */
export async function renderInvoicePdf(doc: InvoicePdfDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const copy = pdfCopy(doc.language);
  const watermark = doc.status === "draft" ? copy.draftWatermark : doc.status === "paid" ? copy.paidWatermark : null;
  if (doc.status === "draft") pdf.setKeywords(["draft"]);
  pdf.setTitle(`${copy.invoice} ${doc.label}`);
  const ctx: Ctx = {
    pdf,
    page: undefined as unknown as PDFPage, // set by addPage below
    y: 0,
    regular,
    bold,
    copy,
    language: doc.language,
    watermark: watermark ? safeText(watermark, bold) : null,
    pages: [],
    ...(await brandingOf(pdf, doc.profile, doc.logo)),
  };
  addPage(ctx);
  drawDocumentHeader(ctx, doc.profile, copy.invoice, doc.title, [doc.label]);
  drawBillTo(ctx, doc);

  tableHeader(ctx);
  for (const line of doc.lines) {
    drawRow(ctx, {
      service: line.name,
      qty: `${formatQuantity(line.quantity, doc.language)}${line.unitLabel ? ` ${clean(ctx, line.unitLabel)}` : ""}`,
      unit: line.unitCents === null ? "-" : formatCents(line.unitCents, doc.language),
      amount: line.totalCents === null ? "-" : formatCents(line.totalCents, doc.language),
    });
  }
  for (const rule of doc.ruleLines) drawRow(ctx, { service: rule.label, amount: formatCents(rule.cents, doc.language), muted: true });
  drawInvoiceTotals(ctx, doc);

  const balance = doc.totalCents - doc.amountPaidCents;
  if (doc.payUrl && balance > 0 && doc.status !== "draft") {
    ctx.y -= 16;
    drawLinkBox(ctx, ctx.copy.payOnline, ctx.copy.payOnlineHelp, doc.payUrl);
  }
  if (doc.notes && doc.notes.trim()) {
    ctx.y -= 16;
    newPageIfNeeded(ctx, 40);
    textBlock(ctx, [clean(ctx, copy.notes.toUpperCase(), true)], 8, { strong: true, color: MUTED });
    ctx.y -= 2;
    textBlock(ctx, wrapUser(ctx, doc.notes, BODY, RIGHT - LEFT), BODY);
  }
  ctx.y -= 18;
  textBlock(ctx, wrapUser(ctx, doc.profile.invoiceFooter?.trim() || copy.invoiceThanks, BODY, RIGHT - LEFT), BODY, { color: MUTED });
  await drawPhotos(ctx, doc.photos ?? [], copy.workPhotos);
  drawFooters(ctx, `${doc.label} · ${doc.profile.name}`);
  return pdf.save();
}

/** ASCII-safe download name, e.g. "Invoice INV-0003 - 12 Oak St.pdf". */
export function invoicePdfFileName(label: string, title: string, language: Language): string {
  const stem = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILE_STEM);
  return `${[`${pdfCopy(language).invoice} ${label}`, stem].filter(Boolean).join(" - ")}.pdf`;
}

// ---------------------------------------------------------------------------------------------
// Receipts

export interface ReceiptPdfDocument {
  profile: Profile;
  /** The invoice's label, "INV-0001". */
  label: string;
  title: string;
  customerName: string | null;
  /** The payments still on the invoice, oldest first. `card` is how the card prints ("Visa •••• 4242"), when known. */
  payments: Array<{ receivedDate: string; method: "cash" | "check" | "card" | "other"; card: string | null; amountCents: number }>;
  totalCents: number;
  amountPaidCents: number;
  language: Language;
  /** The business's logo, at the top of the header. */
  logo?: PdfLogo | null;
}

// The receipt's table: the day, then how it was paid, then the amount at the right edge.
const RECEIPT_METHOD_X = LEFT + 130;

function receiptTableHeader(ctx: Ctx): void {
  const top = ctx.y;
  ctx.page.drawRectangle({ x: LEFT, y: top - 20, width: RIGHT - LEFT, height: 22, color: ctx.accent?.fill ?? BAND });
  const y = top - 14;
  const color = ctx.accent?.onFill ?? MUTED;
  drawText(ctx, clean(ctx, ctx.copy.date, true), LEFT + 6, y, 9, { strong: true, color });
  drawText(ctx, clean(ctx, ctx.copy.method, true), RECEIPT_METHOD_X, y, 9, { strong: true, color });
  drawText(ctx, clean(ctx, ctx.copy.amount, true), AMOUNT_RIGHT - 6, y, 9, { strong: true, color, align: "right" });
  ctx.y = top - 28;
}

function drawReceiptRow(ctx: Ctx, row: { date: string; method: string; amount: string }): void {
  const height = LEADING + 6;
  newPageIfNeeded(ctx, height, () => receiptTableHeader(ctx));
  const y = ctx.y - 11;
  drawText(ctx, fit(ctx.regular, clean(ctx, row.date), BODY, RECEIPT_METHOD_X - LEFT - 18), LEFT + 6, y, BODY);
  drawText(ctx, fit(ctx.regular, clean(ctx, row.method), BODY, AMOUNT_RIGHT - RECEIPT_METHOD_X - 110), RECEIPT_METHOD_X, y, BODY);
  drawText(ctx, row.amount, AMOUNT_RIGHT - 6, y, BODY, { align: "right" });
  ctx.y -= height;
  hairline(ctx, ctx.y + 3);
}

/**
 * The customer's receipt for an invoice: the business's header, who paid, each payment (its day, how,
 * and how much), then the invoice's total, what's been paid, and the balance left or "Paid in full".
 */
export async function renderReceiptPdf(doc: ReceiptPdfDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const copy = pdfCopy(doc.language);
  pdf.setTitle(`${copy.receipt} ${doc.label}`);
  const ctx: Ctx = {
    pdf,
    page: undefined as unknown as PDFPage, // set by addPage below
    y: 0,
    regular,
    bold,
    copy,
    language: doc.language,
    watermark: null,
    pages: [],
    ...(await brandingOf(pdf, doc.profile, doc.logo)),
  };
  addPage(ctx);
  drawDocumentHeader(ctx, doc.profile, copy.receipt, doc.title, [copy.receiptFor(doc.label)]);

  if (doc.customerName?.trim()) {
    const name = wrapUser(ctx, doc.customerName, BODY + 1, (RIGHT - LEFT) / 2, true);
    newPageIfNeeded(ctx, 14 + name.length * LEADING);
    textBlock(ctx, [clean(ctx, copy.receivedFrom.toUpperCase(), true)], 8, { strong: true, color: MUTED });
    textBlock(ctx, name, BODY + 1, { strong: true });
    ctx.y -= 14;
  }

  receiptTableHeader(ctx);
  for (const payment of doc.payments) {
    drawReceiptRow(ctx, {
      date: formatDateOnly(payment.receivedDate, doc.language),
      method: payment.card ?? copy.methods[payment.method],
      amount: formatCents(payment.amountCents, doc.language),
    });
  }

  const balance = Math.max(0, doc.totalCents - doc.amountPaidCents);
  newPageIfNeeded(ctx, 100, () => receiptTableHeader(ctx));
  ctx.y -= 4;
  drawMoneyRow(ctx, copy.invoiceTotal, doc.totalCents);
  drawMoneyRow(ctx, copy.paid, -doc.amountPaidCents);
  ctx.y -= 2;
  ctx.page.drawLine({ start: { x: LABEL_RIGHT - 150, y: ctx.y }, end: { x: RIGHT, y: ctx.y }, thickness: 1, color: INK });
  ctx.y -= 4;
  if (balance > 0) drawMoneyRow(ctx, copy.balanceDue, balance, { strong: true, size: 13 });
  else {
    drawText(ctx, clean(ctx, copy.paidInFull, true), AMOUNT_RIGHT - 6, ctx.y - 15, 13, { strong: true, align: "right", color: ctx.accent?.text });
    ctx.y -= 23;
  }

  ctx.y -= 18;
  textBlock(ctx, wrapUser(ctx, doc.profile.invoiceFooter?.trim() || copy.invoiceThanks, BODY, RIGHT - LEFT), BODY, { color: MUTED });
  drawFooters(ctx, `${copy.receipt} · ${doc.label} · ${doc.profile.name}`);
  return pdf.save();
}

/** ASCII-safe download name, e.g. "Receipt INV-0003.pdf". */
export function receiptPdfFileName(label: string, language: Language): string {
  return `${pdfCopy(language).receipt} ${label.replace(/[^A-Za-z0-9-]+/g, "")}.pdf`;
}
