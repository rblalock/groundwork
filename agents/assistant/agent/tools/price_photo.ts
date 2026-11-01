import { defineTool } from "eve/tools";
import { z } from "zod";
import { pairOf } from "../../../../core/before-after";
import type { Language } from "../../../../core/language";
import { createPricedPhoto, numberList, pricedPhotosFor, pricePhotos, quotePricedPhotos, type PhotoPricing, type PricedPhotoResult } from "../../../../core/priced-photo";
import { recentQuoteRef } from "../../../../core/quotes";
import { getServiceJob } from "../../../../core/scheduling";
import { listWorkPhotos, resolveWorkTarget } from "../../../../core/work-photos";
import { requireCaller, toolError } from "../../../../core/tool-context";

// With no quoteId, the quote this member made, revised, or approved in the last day.
const LATEST_WINDOW_MS = 24 * 60 * 60 * 1000;

type Reason = Exclude<PricedPhotoResult, { pricedPhotoId: string }>["reason"] | "no_work_quote" | "no_work_photo";
type Skip = Extract<PhotoPricing, { pricedPhotoId: null }>;

const NOTES: Record<Language, Record<Reason, string>> = {
  en: {
    no_work_quote: "That work has no quote, so there are no lines to put on the photo. Say so in one line.",
    no_work_photo: "That work has no photos yet. Put the member's photos on it with attach_work_photos first.",
    no_photo: "This quote has no photo to price. Say so in one line; a photo sent with the job goes on the quote.",
    unreadable_photo: "The quote's photos couldn't be read as pictures. Say so in one line and ask for JPEG or PNG photos.",
    photo_too_small: "The quote's photos are too small to label. Say so in one line and ask for larger photos.",
    quote_not_found: "No quote to price. Use list_quotes for its id.",
    no_lines: "The quote has no lines to put on the photo.",
  },
  es: {
    no_work_quote: "Ese servicio no tiene cotización, así que no hay líneas para poner en la foto. Dilo en una línea.",
    no_work_photo: "Ese servicio todavía no tiene fotos. Primero pon las fotos del miembro con attach_work_photos.",
    no_photo: "Esta cotización no tiene foto para marcar. Dilo en una línea; una foto enviada con el trabajo va en la cotización.",
    unreadable_photo: "Las fotos de la cotización no se pudieron leer como imágenes. Dilo en una línea y pide fotos JPEG o PNG.",
    photo_too_small: "Las fotos de la cotización son demasiado pequeñas para marcarlas. Dilo en una línea y pide fotos más grandes.",
    quote_not_found: "No hay cotización para marcar. Usa list_quotes para su id.",
    no_lines: "La cotización no tiene líneas para poner en la foto.",
  },
};

const SKIPPED: Record<Language, Record<Skip["reason"], string>> = {
  en: { unreadable_photo: "couldn't be read", photo_too_small: "too small to label", failed: "couldn't be priced just now" },
  es: { unreadable_photo: "no se pudo leer", photo_too_small: "demasiado pequeña para marcar", failed: "no se pudo marcar ahora" },
};

/** "Lawn mowing: photos 1 and 2", the photos each line is in; "" for a line in none. */
const linePlaces = (lines: Array<{ name: string; photos: number[] }>, language: Language) =>
  lines
    .filter((line) => line.photos.length > 0)
    .map((line) => `${line.name}: ${language === "es" ? (line.photos.length > 1 ? "fotos" : "foto") : line.photos.length > 1 ? "photos" : "photo"} ${numberList(line.photos, language)}`)
    .join("; ");

/** What to say about a finished-job photo: how many of its lines were located, and which weren't. */
function workSummary(located: number, lines: number, notLocated: string[], language: Language, beforeAfter: boolean): string {
  if (language === "es") {
    return `Foto con precios lista: ${located} de ${lines} líneas ubicadas${notLocated.length ? ` (no ubicadas: ${notLocated.join(", ")})` : ""}.${beforeAfter ? " El antes y después con la foto de la cotización está en la factura y en la guía de precios del cliente. Di 'haz una publicación' para una imagen lista para compartir." : ""}`;
  }
  return `Priced photo ready: ${located} of ${lines} lines located${notLocated.length ? ` (not located: ${notLocated.join(", ")})` : ""}.${beforeAfter ? " The before-and-after with the quote's photo is on the invoice and the customer's price guide. Say 'make a post' for a share-ready image." : ""}`;
}

/** What to say once the quote's photos are priced: how many, which photo shows each line, the lines in none, and the photos left out. */
function photosSummary(priced: number, lines: Array<{ name: string; photos: number[] }>, notLocated: string[], skipped: number, language: Language): string {
  const places = linePlaces(lines, language);
  if (language === "es") {
    return [
      `${priced === 1 ? "1 foto marcada con precios" : `${priced} fotos marcadas con precios`}${places ? ` (${places})` : ""}.`,
      notLocated.length ? `No ubicadas en ninguna foto: ${notLocated.join(", ")}.` : "",
      skipped ? `${skipped === 1 ? "1 foto no se pudo marcar" : `${skipped} fotos no se pudieron marcar`} (ver skipped).` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `${priced === 1 ? "1 photo priced" : `${priced} photos priced`}${places ? ` (${places})` : ""}.`,
    notLocated.length ? `Located in no photo: ${notLocated.join(", ")}.` : "",
    skipped ? `${skipped === 1 ? "1 photo" : `${skipped} photos`} couldn't be priced (see skipped).` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Each line of the quote and the numbers of its priced photos that show it. */
async function quoteLines(orgId: string, quoteId: string, priced: PricedPhotoResult & { pricedPhotoId: string }) {
  const set = await quotePricedPhotos(orgId, quoteId);
  return priced.regions.map((region) => ({
    name: region.name,
    photos: set.flatMap((photo) => (photo.regions.some((r) => r.lineIndex === region.lineIndex && r.located) ? [photo.place.number] : [])),
  }));
}

export default defineTool({
  description:
    "Price the quote's photos: each photo with each quoted thing outlined and labeled with its line's quantity and price, numbered in the order the photos came, and each photo's legend listing the lines it shows. They show on the quote's card, its page, the customer's link, and the customer's price guide, and the crew get them with their checklist. Nothing is measured: quantities and prices come from the quote, and a line in two photos is still counted once. Without quoteId it uses the quote the member just made or changed. With no source, every photo on the quote is priced; source prices one. After the job, pass jobId (the work, sj_…) instead: the work's latest photo is priced with the work's quote and saved to the customer's price guide; when the quote already has a priced photo from before the job, beforeAfter: true says the two now make a before-and-after on the invoice and the price guide. Pricing again replaces the photo's earlier one. lines says which photos show each line and notLocated the lines found in none; send summaryText's facts in your reply (how many photos were priced and which lines were in none). A null pricedPhotoId comes with a note: say it in one line.",
  inputSchema: z.object({
    quoteId: z.string().optional().describe("The quote; defaults to the one the member just made or changed."),
    source: z
      .object({ kind: z.enum(["quote_attachment", "work_photo"]), id: z.string() })
      .optional()
      .describe("One particular photo: one of the quote's attachments (get_quote), or a work photo on its work. Leave it out to price every photo on the quote."),
    jobId: z.string().optional().describe("The work (sj_…) whose finished-job photo to price, with the work's quote."),
  }),
  async execute({ quoteId, source, jobId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const { language } = caller;
      let id: string | null;
      if (jobId) {
        // After the job: the work's quote, and the newest photo on the work.
        const resolved = await resolveWorkTarget(caller, { jobId });
        if ("choose" in resolved) throw new Error("SERVICE_JOB_NOT_FOUND");
        const job = await getServiceJob(caller, resolved.target.jobId);
        if (!job?.quoteId) return { pricedPhotoId: null, reason: "no_work_quote", jobId, note: NOTES[language].no_work_quote };
        id = job.quoteId;
        const latest = (await listWorkPhotos(caller.orgId, { jobId: job.id })).at(-1);
        if (!latest) return { pricedPhotoId: null, reason: "no_work_photo", quoteId: id, jobId, note: NOTES[language].no_work_photo };
        source = { kind: "work_photo", id: latest.id };
      } else {
        id = quoteId ?? (await recentQuoteRef(caller.orgId, caller.memberId, new Date(Date.now() - LATEST_WINDOW_MS)));
      }
      if (!id) return { pricedPhotoId: null, reason: "quote_not_found", quoteId: id, note: NOTES[language].quote_not_found };

      if (!source) {
        // Every photo on the quote, in the order they came.
        const all = await pricePhotos(caller, { quoteId: id });
        if (all.photos === null) return { pricedPhotoId: null, reason: all.reason, quoteId: id, note: NOTES[language][all.reason] };
        const priced = all.photos.flatMap((photo) => (photo.pricedPhotoId !== null ? [{ number: photo.number, pricedPhotoId: photo.pricedPhotoId, located: photo.located }] : []));
        const skipped = all.photos.flatMap((photo) =>
          photo.pricedPhotoId === null ? [{ attachmentId: photo.attachmentId, reason: photo.reason, note: SKIPPED[language][photo.reason] }] : [],
        );
        return {
          quoteId: id,
          pricedPhotoId: priced[0].pricedPhotoId,
          photos: priced,
          ...(skipped.length ? { skipped } : {}),
          lines: all.lines,
          notLocated: all.notLocated,
          summaryText: photosSummary(priced.length, all.lines, all.notLocated, skipped.length, language),
        };
      }

      const result = await createPricedPhoto(caller, { quoteId: id, source });
      if (result.pricedPhotoId === null) return { ...result, quoteId: id, note: NOTES[language][result.reason] };
      // After the job, paired with the quote's own priced photo when it has one.
      const beforeAfter = Boolean(jobId && pairOf(await pricedPhotosFor(caller.orgId, id)));
      if (source.kind === "quote_attachment") {
        // One of the quote's own photos: where each line is across all of them.
        const lines = await quoteLines(caller.orgId, id, result);
        const notLocated = lines.filter((line) => line.photos.length === 0).map((line) => line.name);
        return { quoteId: id, pricedPhotoId: result.pricedPhotoId, located: result.located, lines, notLocated, summaryText: photosSummary(1, lines, notLocated, 0, language) };
      }
      return {
        quoteId: id,
        pricedPhotoId: result.pricedPhotoId,
        located: result.located,
        notLocated: result.notLocated,
        lines: result.regions.map((region) => ({ name: region.name, located: region.located })),
        ...(beforeAfter ? { beforeAfter: true } : {}),
        summaryText: workSummary(result.located, result.regions.length, result.notLocated, language, beforeAfter),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
