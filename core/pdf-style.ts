import { z } from "zod";

// How a business's quote and invoice PDFs look beyond its facts: an accent colour, its own closing line
// on quotes and on invoices, and which contact facts print in the header. The logo is stored apart
// (`core/branding.ts`). Unset, everything is today's look. Shared by the PDFs, the tools, and the
// Settings page, so this file stays free of the database.

/** The contact facts a PDF's header can leave off. */
export const PDF_DETAILS = ["address", "phone", "email", "licenseNumber"] as const;
export type PdfDetail = (typeof PDF_DETAILS)[number];

export const FOOTER_MAX_CHARS = 400;
export const FOOTER_MAX_LINES = 6;

/** `#1f6feb`, `1F6FEB`, or `#16e` as `#1f6feb`; null for anything else. */
export function normalizeHex(value: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return `#${hex.toLowerCase()}`;
}

/** Line endings made plain, each line trimmed, blank runs cut to one; empty becomes null. */
export function normalizeFooter(value: string): string | null {
  const text = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? null : text;
}

const footerSchema = z
  .string()
  .max(FOOTER_MAX_CHARS * 2)
  .transform(normalizeFooter)
  .refine((v) => v === null || v.length <= FOOTER_MAX_CHARS, `Keep it to ${FOOTER_MAX_CHARS} characters.`)
  .refine((v) => v === null || v.split("\n").length <= FOOTER_MAX_LINES, `Keep it to ${FOOTER_MAX_LINES} lines.`)
  // Tabs and newlines are fine; other control and invisible formatting characters aren't.
  .refine((v) => v === null || !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(v), "Use plain text.");

/** The PDF settings the Settings page and update_branding change. null clears a setting back to the default. */
export const brandingFieldsSchema = z.object({
  accentColor: z
    .string()
    .transform((v, ctx) => {
      const hex = normalizeHex(v);
      if (!hex) ctx.addIssue({ code: "custom", message: "Use a hex color like #1f6feb." });
      return hex ?? "";
    })
    .nullable()
    .optional()
    .describe("A hex color like #1f6feb for the PDFs' headings band. null goes back to the plain look."),
  quoteFooter: footerSchema
    .nullable()
    .optional()
    .describe("The closing note printed at the end of every quote, in the owner's words, in place of the standard thank-you line. null goes back to the standard line."),
  invoiceFooter: footerSchema
    .nullable()
    .optional()
    .describe("The closing note at the end of every invoice (payment terms, a thank-you), in the owner's words. null goes back to the standard line."),
  showOnPdf: z
    .object(Object.fromEntries(PDF_DETAILS.map((d) => [d, z.boolean().optional()])) as Record<PdfDetail, z.ZodOptional<z.ZodBoolean>>)
    .strict()
    .optional()
    .describe("Which saved business facts print in the PDF header: false leaves one off, true puts it back. Pass only the ones they named."),
});

export const brandingPatchSchema = brandingFieldsSchema.refine(
  (patch) => Object.values(patch).some((v) => v !== undefined),
  "Pass at least one setting.",
);

export type BrandingPatch = z.infer<typeof brandingPatchSchema>;

// ---------------------------------------------------------------------------------------------
// Colour: the accent fills the table's heading band, so its text has to stay readable on it, and the
// accent used as text on white paper is darkened until it reads.

export type Rgb = [r: number, g: number, b: number];

/** The PDFs' body ink, rgb(0.12, 0.13, 0.15). */
export const INK_RGB: Rgb = [0.12, 0.13, 0.15];
const WHITE: Rgb = [1, 1, 1];

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export type AccentColors = {
  /** The accent itself, for the heading band and rules. */
  fill: Rgb;
  /** White or ink, whichever reads better on `fill`. */
  onFill: Rgb;
  /** The accent darkened, if needed, to read as text on white (4.5:1). */
  text: Rgb;
  /** A pale wash of the accent, for a band that holds body text in ink. */
  tint: Rgb;
};

export function accentColors(hex: string): AccentColors {
  const fill = hexToRgb(hex);
  const onFill = contrastRatio(fill, WHITE) >= contrastRatio(fill, INK_RGB) ? WHITE : INK_RGB;
  let text = fill;
  for (let step = 1; contrastRatio(text, WHITE) < 4.5 && step <= 20; step++) text = mix(fill, [0, 0, 0], step / 20);
  return { fill, onFill, text, tint: mix(fill, WHITE, 0.9) };
}
