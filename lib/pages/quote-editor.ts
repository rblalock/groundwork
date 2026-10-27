import { z } from "zod";
import { storeInboundAttachment } from "../../core/blob";
import { listItems } from "../../core/pricebook";
import { getQuote, reviseQuote, type QuoteDetail } from "../../core/quotes";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, refuse } from "./access";
import { PHOTO_MAX_BYTES, preparePhoto } from "./photo-upload";
import { mayChangeQuoteLanguage } from "./quote-language";
import { assertVisible } from "./quotes";

// Editing a quote on its page: its lines, its notes for the customer, and its photos. Each save
// is a new revision through `reviseQuote`, the same as the assistant's `revise_quote`, so pricing, rules,
// minimums, tax, and the PDF all come from one place, and an approved quote goes back for approval.
// Nothing is texted: the member is on the page.

/** Who may change a quote: an owner or admin, or the crew member who started it, while it's open to revising. */
export function mayReviseQuote(caller: AppCaller, quote: Pick<QuoteDetail, "quoteId" | "status">): Promise<boolean> {
  return mayChangeQuoteLanguage(caller, quote);
}

export type EditorItem = { id: string; name: string; unitLabel: string; priceCents: number };

/** The business's active price book items, for picking a line's item. */
export async function editorItems(caller: AppCaller): Promise<EditorItem[]> {
  const items = await listItems(caller.orgId);
  return items.map((item) => ({ id: item.id, name: item.name, unitLabel: item.unitLabel, priceCents: item.priceCents }));
}

const lineSchema = z
  .object({
    itemId: z.string().min(1).max(64).optional(),
    name: z.string().trim().max(200).optional(),
    unitLabel: z.string().trim().max(40).optional(),
    quantity: z.number().positive().max(1_000_000),
    unitCents: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();

const reviseSchema = z
  .object({
    /** The revision the page showed: a quote that moved on since is refused. */
    revision: z.number().int().positive(),
    lines: z.array(lineSchema).min(1).max(50).optional(),
    customerNotes: z.string().max(4000).optional(),
    removePhotoIds: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
  })
  .strict()
  .refine((body) => body.lines !== undefined || body.customerNotes !== undefined || body.removePhotoIds !== undefined, "Nothing to change.");

/**
 * Saves the member's edit as a new revision of the one the page showed. A 404 for a quote they can't
 * see, a 403 for one they may not change (or a super admin looking in), a 409 when it changed since the
 * page loaded or is closed, and a 400 for a line the library won't take.
 */
export async function reviseQuoteFromApp(caller: AppCaller, quoteId: string, body: unknown): Promise<{ revision: number }> {
  const actor = memberCaller(caller);
  await assertVisible(caller, quoteId);
  const input = reviseSchema.parse(body);
  const quote = await getQuote(caller.orgId, quoteId);
  if (!quote) throw notFound();
  const e = pageCopyFor(caller.language).quotes.errors;
  if (!(await mayReviseQuote(caller, quote))) throw new HttpError(403, "NOT_ALLOWED", e.editNotAllowed);
  if (quote.revisionNumber !== input.revision) throw new HttpError(409, "REVISION_CHANGED", e.quoteChanged);
  try {
    const revised = await reviseQuote(
      { quoteId, lines: input.lines, customerNotes: input.customerNotes?.trim(), removePhotoIds: input.removePhotoIds },
      actor,
      { post: async () => ({ posted: true }) },
    );
    return { revision: revised.revisionNumber };
  } catch (error) {
    refuse(error, {
      QUOTE_CLOSED: [409, e.quoteClosed],
      QUOTE_NOT_FOUND: [404, "That isn't here."],
      PHOTO_NOT_FOUND: [404, e.photoGone],
      UNKNOWN_ITEM: [400, e.itemGone],
      LINE_NEEDS_ITEM_OR_NAME: [400, e.lineName],
      INVALID_QUANTITY: [400, e.lineQuantity],
      INVALID_PRICE: [400, e.linePrice],
      NO_LINES: [400, e.noLines],
    });
  }
}

/** One photo per upload: Vercel caps a request's body at about 4.5 MB. */
export const QUOTE_PHOTO_MAX_BYTES = PHOTO_MAX_BYTES;
/** Photos a quote may carry at once; the PDF prints the first eight. */
export const QUOTE_PHOTO_LIMIT = 20;

/**
 * Adds a photo the member uploaded on the quote's page, as a new revision (`reviseQuote`), so it prints
 * on the PDF and can be taken off like a texted one. JPEG, PNG, or an iPhone's HEIC (made a JPEG, as a
 * texted one is), told apart by the bytes, never the browser's say-so. Same gate as editing the quote.
 */
export async function addQuotePhotoFromApp(
  caller: AppCaller,
  quoteId: string,
  file: { name: string; bytes: Uint8Array },
): Promise<{ revision: number }> {
  const actor = memberCaller(caller);
  await assertVisible(caller, quoteId);
  const quote = await getQuote(caller.orgId, quoteId);
  if (!quote) throw notFound();
  const e = pageCopyFor(caller.language).quotes.errors;
  if (!(await mayReviseQuote(caller, quote))) throw new HttpError(403, "NOT_ALLOWED", e.editNotAllowed);
  if (quote.attachments.length >= QUOTE_PHOTO_LIMIT) throw new HttpError(409, "TOO_MANY_PHOTOS", e.photoLimit);
  const { bytes, mimeType, name } = await preparePhoto(file, e);
  const url = await storeInboundAttachment(name, mimeType, bytes);
  try {
    const revised = await reviseQuote({ quoteId }, actor, { post: async () => ({ posted: true }), addPhotos: [{ url, name, mimeType }] });
    return { revision: revised.revisionNumber };
  } catch (error) {
    refuse(error, { QUOTE_CLOSED: [409, e.quoteClosed], QUOTE_NOT_FOUND: [404, "That isn't here."] });
  }
}
