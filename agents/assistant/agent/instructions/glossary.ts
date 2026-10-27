import { defineDynamic, defineInstructions } from "eve/instructions";
import type { SessionAuthContext } from "eve/context";
import { glossaryInstructions, listGlossary } from "../../../../core/glossary";
import { resolveCaller } from "../../../../core/members";

// The business's glossary, for a turn with a Spanish-speaking member (text, web, or job): its own
// Spanish words for its English terms (core/glossary.ts). Resolved every turn, since an owner
// can change the glossary while a member's thread goes on. Nothing for English speakers, or an empty
// glossary.
export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const caller = await resolveCaller((ctx.session.auth.current ?? null) as SessionAuthContext | null).catch(() => null);
      if (!caller || caller.language !== "es") return null;
      const content = glossaryInstructions(await listGlossary(caller.orgId));
      return content ? defineInstructions({ content }) : null;
    },
  },
});
