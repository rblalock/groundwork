import { and, eq } from "drizzle-orm";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { memberPhones } from "../../../../schema/schema";
import { db } from "../../../../core/db";
import { PHOTON } from "../../../../core/channel-dispatch";
import { addReaction } from "../../../../core/imessage";
import { latestInbound, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Tapback the member's latest text, when a reaction is the whole answer: thumbs_up for a short instruction that is done and needs no words. On SMS, where tapbacks do not exist, nothing is sent and the result speaks for itself.",
  inputSchema: z.object({
    emoji: z.enum(["thumbs_up", "heart", "thumbs_down", "laugh", "exclamation", "question"]),
  }),
  endsTurn: true,
  async execute({ emoji }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      // A web turn has no text to tapback; its reply is words on the web.
      if (ctx.session.auth.current?.authenticator !== PHOTON) return { reacted: false };
      const message = await latestInbound(caller.orgId, caller.memberId);
      if (!message?.threadId || !message.providerMessageId) return { reacted: false };
      if (caller.phoneE164) {
        const [phone] = await db()
          .select({ lastService: memberPhones.lastService })
          .from(memberPhones)
          .where(and(eq(memberPhones.orgId, caller.orgId), eq(memberPhones.e164, caller.phoneE164)));
        if (phone?.lastService === "SMS" || phone?.lastService === "RCS") return { reacted: false };
      }
      await addReaction(message.threadId, message.providerMessageId, emoji);
      return { reacted: true };
    } catch (error) {
      return toolError(error);
    }
  },
});
