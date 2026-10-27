import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Language } from "../../../../core/language";
import { createPricedPhoto, type PricedPhotoResult } from "../../../../core/priced-photo";
import { recentQuoteRef } from "../../../../core/quotes";
import { requireCaller, toolError } from "../../../../core/tool-context";

// With no quoteId, the quote this member made, revised, or approved in the last day.
const LATEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const NOTES: Record<Language, Record<Exclude<PricedPhotoResult, { pricedPhotoId: string }>["reason"], string>> = {
  en: {
    no_photo: "This quote has no photo to price. Say so in one line; a photo sent with the job goes on the quote.",
    unreadable_photo: "The quote's photo couldn't be read as a picture. Say so in one line and ask for a JPEG or PNG photo.",
    quote_not_found: "No quote to price. Use list_quotes for its id.",
    no_lines: "The quote has no lines to put on the photo.",
  },
  es: {
    no_photo: "Esta cotización no tiene foto para marcar. Dilo en una línea; una foto enviada con el trabajo va en la cotización.",
    unreadable_photo: "La foto de la cotización no se pudo leer como imagen. Dilo en una línea y pide una foto JPEG o PNG.",
    quote_not_found: "No hay cotización para marcar. Usa list_quotes para su id.",
    no_lines: "La cotización no tiene líneas para poner en la foto.",
  },
};

function summaryText(located: number, lines: number, notLocated: string[], language: Language): string {
  if (language === "es") {
    return `Foto con precios lista: ${located} de ${lines} líneas ubicadas${notLocated.length ? ` (no ubicadas: ${notLocated.join(", ")})` : ""}.`;
  }
  return `Priced photo ready: ${located} of ${lines} lines located${notLocated.length ? ` (not located: ${notLocated.join(", ")})` : ""}.`;
}

export default defineTool({
  description:
    "Make the priced photo for a quote: its photo with each quoted thing outlined and labeled with the line's quantity and price, and every line listed under it. It shows on the quote's card, its page, and the customer's link. Nothing is measured: quantities and prices come from the quote. Without quoteId it uses the quote the member just made or changed. Making it again replaces the one for that photo. located and notLocated say which lines were found in the photo; send summaryText's facts in your reply. A null pricedPhotoId comes with a note: say it in one line.",
  inputSchema: z.object({
    quoteId: z.string().optional().describe("The quote; defaults to the one the member just made or changed."),
    source: z
      .object({ kind: z.enum(["quote_attachment", "work_photo"]), id: z.string() })
      .optional()
      .describe("A particular photo: one of the quote's attachments (get_quote), or a work photo on its work. Defaults to the quote's latest photo."),
  }),
  async execute({ quoteId, source }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const id = quoteId ?? (await recentQuoteRef(caller.orgId, caller.memberId, new Date(Date.now() - LATEST_WINDOW_MS)));
      const result: PricedPhotoResult = id ? await createPricedPhoto(caller, { quoteId: id, source }) : { pricedPhotoId: null, reason: "quote_not_found" };
      if (result.pricedPhotoId === null) return { ...result, quoteId: id, note: NOTES[caller.language][result.reason] };
      return {
        quoteId: id,
        pricedPhotoId: result.pricedPhotoId,
        located: result.located,
        notLocated: result.notLocated,
        lines: result.regions.map((region) => ({ name: region.name, located: region.located })),
        summaryText: summaryText(result.located, result.regions.length, result.notLocated, caller.language),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
