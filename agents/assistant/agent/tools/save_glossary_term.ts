import { defineTool } from "eve/tools";
import { z } from "zod";
import { removeGlossaryTerm, saveGlossaryTerm } from "../../../../core/glossary";
import { privilegedOnly } from "../../../../core/policies";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Save a word of the business's glossary: the Spanish it uses for one of its English terms, when the owner or an admin says so (\"in Spanish call the X 'Y'\", \"we say Y for X\"). The web app's translations and your Spanish replies use it. term is the English word as they said it, spanish the Spanish word exactly as they said it, and note only what they said about when to use it. Saving a term that's there changes its Spanish. remove true takes a term off. Returns the whole glossary.",
  inputSchema: z.object({
    term: z.string().max(120).describe("The English term, like \"quote\"."),
    spanish: z.string().max(120).optional().describe("The Spanish to use for it, exactly as they said it. Required unless remove."),
    note: z.string().max(300).optional().describe("Only when they said when or how to use it."),
    remove: z.boolean().optional(),
  }),
  approval: privilegedOnly("change the glossary"),
  async execute(input, ctx) {
    try {
      refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      if (input.remove) return plain({ removed: input.term, glossary: await removeGlossaryTerm(caller, input.term) });
      const saved = await saveGlossaryTerm(caller, { term: input.term, spanish: input.spanish ?? "", note: input.note });
      return plain(saved);
    } catch (error) {
      return toolError(error);
    }
  },
});
