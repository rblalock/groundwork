import { defineTool } from "eve/tools";
import { z } from "zod";
import { storeInboundAttachment } from "../../../../core/blob";
import type { Language } from "../../../../core/language";
import { postToMember } from "../../../../core/outbound";
import { recentQuoteRef } from "../../../../core/quotes";
import { getServiceJob } from "../../../../core/scheduling";
import { POST_FORMATS, socialPostFor } from "../../../../core/social-post";
import { resolveWorkTarget } from "../../../../core/work-photos";
import { requireCaller, toolError } from "../../../../core/tool-context";

// With no quoteId, the quote this member made, revised, or approved in the last day.
const LATEST_WINDOW_MS = 24 * 60 * 60 * 1000;

type Reason = "no_before_after" | "no_work_quote" | "quote_not_found" | "unreadable_photo" | "not_posted";

const NOTES: Record<Language, Record<Reason, string>> = {
  en: {
    no_before_after:
      "A post needs the quote's priced photo from before the job and a priced photo from after it. Say so in one line; a finished-job photo priced with the job (price_photo with jobId) makes the pair.",
    no_work_quote: "That work has no quote, so there's no before-and-after to post. Say so in one line.",
    quote_not_found: "No quote to make a post from. Use list_quotes for its id.",
    unreadable_photo: "One of the two photos couldn't be read anymore. Say so in one line and ask for the photo again.",
    not_posted:
      "The image couldn't go to the member's texts. Say the post shows on the card under this reply and on the quote's page under Share, and give the caption.",
  },
  es: {
    no_before_after:
      "Una publicación necesita la foto con precios de la cotización de antes del trabajo y una foto con precios de después. Dilo en una línea; una foto del trabajo terminado marcada con el servicio (price_photo con jobId) completa el par.",
    no_work_quote: "Ese servicio no tiene cotización, así que no hay antes y después para publicar. Dilo en una línea.",
    quote_not_found: "No hay cotización para hacer la publicación. Usa list_quotes para su id.",
    unreadable_photo: "Una de las dos fotos ya no se pudo leer. Dilo en una línea y pide la foto de nuevo.",
    not_posted:
      "La imagen no se pudo mandar a los mensajes del miembro. Di que la publicación aparece en la tarjeta bajo esta respuesta y en la página de la cotización, en Compartir, y da el texto.",
  },
};

// Asked for the line asking for the next job, but the business has no phone or email to put in it.
const NO_CTA: Record<Language, string> = {
  en: "The post has no line asking for the next job: the business has no phone or email. Say so in one line; the owner adds one in Settings.",
  es: "La publicación no lleva la línea que pide el próximo trabajo: el negocio no tiene teléfono ni correo. Dilo en una línea; el dueño agrega uno en Ajustes.",
};

export default defineTool({
  description:
    "Make a share-ready social post from a quote's before-and-after: its photo from before the job and its finished-job photo, cropped to match, with Before and After labels and the business's name, and a caption written in code. No prices, outlines, or address. Without quoteId it uses the quote the member just made or changed; pass jobId (sj_…) for that work's quote. format is square (a feed post, the default) or story; cta (default true) adds a line asking for the next job with the business's phone or email. The image and caption are sent to the member's thread; posted says whether they went, and when they didn't, a note says what to tell the member. A ctaNote means the line asking for the next job was left off; mention it in one line. A null imageUrl comes with a note: say it in one line.",
  inputSchema: z.object({
    quoteId: z.string().optional().describe("The quote; defaults to the one the member just made or changed."),
    jobId: z.string().optional().describe("The work (sj_…) whose quote to use."),
    format: z.enum(POST_FORMATS).optional().describe("square (default) for a feed post, story for a tall story."),
    cta: z.boolean().optional().describe("Add the line asking for the next job; defaults to true."),
  }),
  async execute({ quoteId, jobId, format = "square", cta = true }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const notes = NOTES[caller.language];
      let id: string | null;
      if (jobId) {
        const resolved = await resolveWorkTarget(caller, { jobId });
        if ("choose" in resolved) throw new Error("SERVICE_JOB_NOT_FOUND");
        const job = await getServiceJob(caller, resolved.target.jobId);
        if (!job?.quoteId) return { imageUrl: null, reason: "no_work_quote", jobId, note: notes.no_work_quote };
        id = job.quoteId;
      } else {
        id = quoteId ?? (await recentQuoteRef(caller.orgId, caller.memberId, new Date(Date.now() - LATEST_WINDOW_MS)));
      }
      if (!id) return { imageUrl: null, reason: "quote_not_found", note: notes.quote_not_found };
      const post = await socialPostFor(caller.orgId, id, { format, cta, language: caller.language }).catch((error: unknown) => {
        if (error instanceof Error && error.message === "UNREADABLE_PHOTO") return "unreadable_photo" as const;
        throw error;
      });
      if (post === "unreadable_photo") return { imageUrl: null, reason: post, quoteId: id, note: notes.unreadable_photo };
      if (!post) return { imageUrl: null, reason: "no_before_after", quoteId: id, note: notes.no_before_after };

      const filename = `before-after-${format}.png`;
      const imageUrl = await storeInboundAttachment(filename, "image/png", post.png);
      const sent = await postToMember(
        caller.orgId,
        caller.memberId,
        { text: post.caption, file: { filename, mimeType: "image/png", data: Buffer.from(post.png) }, fileUrl: imageUrl },
        "system",
      );
      return {
        quoteId: id,
        imageUrl,
        caption: post.caption,
        format,
        posted: sent.posted,
        ...(sent.posted ? {} : { note: notes.not_posted }),
        ...(cta && !post.cta ? { ctaNote: NO_CTA[caller.language] } : {}),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
