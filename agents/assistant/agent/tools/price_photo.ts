import { defineTool } from "eve/tools";
import { z } from "zod";
import { pairOf } from "../../../../core/before-after";
import type { Language } from "../../../../core/language";
import { createPricedPhoto, pricedPhotosFor, type PricedPhotoResult } from "../../../../core/priced-photo";
import { recentQuoteRef } from "../../../../core/quotes";
import { getServiceJob } from "../../../../core/scheduling";
import { listWorkPhotos, resolveWorkTarget } from "../../../../core/work-photos";
import { requireCaller, toolError } from "../../../../core/tool-context";

// With no quoteId, the quote this member made, revised, or approved in the last day.
const LATEST_WINDOW_MS = 24 * 60 * 60 * 1000;

type Reason = Exclude<PricedPhotoResult, { pricedPhotoId: string }>["reason"] | "no_work_quote" | "no_work_photo";

const NOTES: Record<Language, Record<Reason, string>> = {
  en: {
    no_work_quote: "That work has no quote, so there are no lines to put on the photo. Say so in one line.",
    no_work_photo: "That work has no photos yet. Put the member's photos on it with attach_work_photos first.",
    no_photo: "This quote has no photo to price. Say so in one line; a photo sent with the job goes on the quote.",
    unreadable_photo: "The quote's photo couldn't be read as a picture. Say so in one line and ask for a JPEG or PNG photo.",
    photo_too_small: "The quote's photo is too small to label. Say so in one line and ask for a larger photo.",
    quote_not_found: "No quote to price. Use list_quotes for its id.",
    no_lines: "The quote has no lines to put on the photo.",
  },
  es: {
    no_work_quote: "Ese servicio no tiene cotización, así que no hay líneas para poner en la foto. Dilo en una línea.",
    no_work_photo: "Ese servicio todavía no tiene fotos. Primero pon las fotos del miembro con attach_work_photos.",
    no_photo: "Esta cotización no tiene foto para marcar. Dilo en una línea; una foto enviada con el trabajo va en la cotización.",
    unreadable_photo: "La foto de la cotización no se pudo leer como imagen. Dilo en una línea y pide una foto JPEG o PNG.",
    photo_too_small: "La foto de la cotización es demasiado pequeña para marcarla. Dilo en una línea y pide una foto más grande.",
    quote_not_found: "No hay cotización para marcar. Usa list_quotes para su id.",
    no_lines: "La cotización no tiene líneas para poner en la foto.",
  },
};

function summaryText(located: number, lines: number, notLocated: string[], language: Language, beforeAfter: boolean): string {
  if (language === "es") {
    return `Foto con precios lista: ${located} de ${lines} líneas ubicadas${notLocated.length ? ` (no ubicadas: ${notLocated.join(", ")})` : ""}.${beforeAfter ? " El antes y después con la foto de la cotización está en la factura y en la guía de precios del cliente. Di 'haz una publicación' para una imagen lista para compartir." : ""}`;
  }
  return `Priced photo ready: ${located} of ${lines} lines located${notLocated.length ? ` (not located: ${notLocated.join(", ")})` : ""}.${beforeAfter ? " The before-and-after with the quote's photo is on the invoice and the customer's price guide. Say 'make a post' for a share-ready image." : ""}`;
}

export default defineTool({
  description:
    "Make the priced photo for a quote: its photo with each quoted thing outlined and labeled with the line's quantity and price, and every line listed under it. It shows on the quote's card, its page, the customer's link, and the customer's price guide. Nothing is measured: quantities and prices come from the quote. Without quoteId it uses the quote the member just made or changed. After the job, pass jobId (the work, sj_…) instead: the work's latest photo is priced with the work's quote and saved to the customer's price guide; when the quote already has a priced photo from before the job, beforeAfter: true says the two now make a before-and-after on the invoice and the price guide. Making it again replaces the one for that photo. located and notLocated say which lines were found in the photo; send summaryText's facts in your reply. A null pricedPhotoId comes with a note: say it in one line.",
  inputSchema: z.object({
    quoteId: z.string().optional().describe("The quote; defaults to the one the member just made or changed."),
    source: z
      .object({ kind: z.enum(["quote_attachment", "work_photo"]), id: z.string() })
      .optional()
      .describe("A particular photo: one of the quote's attachments (get_quote), or a work photo on its work. Defaults to the quote's latest photo."),
    jobId: z.string().optional().describe("The work (sj_…) whose finished-job photo to price, with the work's quote."),
  }),
  async execute({ quoteId, source, jobId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      let id: string | null;
      if (jobId) {
        // After the job: the work's quote, and the newest photo on the work.
        const resolved = await resolveWorkTarget(caller, { jobId });
        if ("choose" in resolved) throw new Error("SERVICE_JOB_NOT_FOUND");
        const job = await getServiceJob(caller, resolved.target.jobId);
        if (!job?.quoteId) return { pricedPhotoId: null, reason: "no_work_quote", jobId, note: NOTES[caller.language].no_work_quote };
        id = job.quoteId;
        const latest = (await listWorkPhotos(caller.orgId, { jobId: job.id })).at(-1);
        if (!latest) return { pricedPhotoId: null, reason: "no_work_photo", quoteId: id, jobId, note: NOTES[caller.language].no_work_photo };
        source = { kind: "work_photo", id: latest.id };
      } else {
        id = quoteId ?? (await recentQuoteRef(caller.orgId, caller.memberId, new Date(Date.now() - LATEST_WINDOW_MS)));
      }
      const result: PricedPhotoResult = id ? await createPricedPhoto(caller, { quoteId: id, source }) : { pricedPhotoId: null, reason: "quote_not_found" };
      if (result.pricedPhotoId === null) return { ...result, quoteId: id, note: NOTES[caller.language][result.reason] };
      // After the job, paired with the quote's own priced photo when it has one.
      const beforeAfter = Boolean(jobId && id && pairOf(await pricedPhotosFor(caller.orgId, id)));
      return {
        quoteId: id,
        pricedPhotoId: result.pricedPhotoId,
        located: result.located,
        notLocated: result.notLocated,
        lines: result.regions.map((region) => ({ name: region.name, located: region.located })),
        ...(beforeAfter ? { beforeAfter: true } : {}),
        summaryText: summaryText(result.located, result.regions.length, result.notLocated, caller.language, beforeAfter),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
