import { defineTool } from "eve/tools";
import { z } from "zod";
import { noteForTool, saveNote, takeRecentFiles } from "../../../../core/notes";
import { plain, refuseFromEmail, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Save something the business wants remembered that isn't a price: how it does things (a procedure, a checklist, warranty terms, a policy, crew instructions), a site note on a customer, property, or quote (a gate code, where to park, the dog's name), or a file the member texted and asked to keep (a warranty PDF, a permit). Use the member's own words; never add facts they didn't give. Linked to nothing, a note is business-wide: only the owner or an admin saves those. Pass customerId, propertyId, or quoteId (from find_customer, list_quotes, or search_records) to put it on one: crew can do that for a customer or quote they work on. keepTextedFile true keeps the file(s) on the member's latest text as this note's document; describe it in text with what they said it is and anything you read in it. To change a note, pass its noteId (from read_business, search_records, or read_note) with only what changes: text replaces the text, so pass the whole new text. archive true takes it off the lists.",
  inputSchema: z.object({
    noteId: z.string().optional().describe("The note to change. Omit to add one."),
    title: z.string().max(160).optional().describe("A short name for it, like \"Sill wiping\" or \"Gate code\". Required for a new note."),
    text: z.string().max(20000).optional().describe("The note in the member's words, lightly tidied."),
    tags: z.array(z.string()).max(12).optional().describe("A few plain words to find it by, like \"warranty\" or \"access\"."),
    customerId: z.string().optional(),
    propertyId: z.string().optional(),
    quoteId: z.string().optional(),
    keepTextedFile: z.boolean().optional(),
    archive: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    try {
      // A new note from an email is fine; changing one on record waits for the member.
      if (input.noteId) refuseFromEmail(ctx);
      const caller = await requireCaller(ctx);
      const files = input.keepTextedFile ? await takeRecentFiles(caller.orgId, caller.memberId) : [];
      if (input.keepTextedFile && files.length === 0) throw new Error("NO_TEXTED_FILE");
      const note = await saveNote(caller, {
        noteId: input.noteId,
        title: input.title,
        body: input.text,
        tags: input.tags,
        customerId: input.customerId,
        propertyId: input.propertyId,
        quoteId: input.quoteId,
        files,
        archived: input.archive,
      });
      return plain({ note: noteForTool(note), filesKept: files.length });
    } catch (error) {
      return toolError(error);
    }
  },
});
