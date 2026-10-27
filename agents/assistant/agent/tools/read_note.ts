import { defineTool } from "eve/tools";
import { z } from "zod";
import { getNote, noteForTool } from "../../../../core/notes";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Read one note or document in full: its text, tags, what it's on, and its files (each with a url). Use it before answering from a note whose text read_business or search_records cut short, and quote the note rather than retelling it.",
  inputSchema: z.object({ noteId: z.string().min(1) }),
  async execute({ noteId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const note = await getNote(caller, noteId);
      if (!note) throw new Error("NOTE_NOT_FOUND");
      return plain({ note: noteForTool(note, { full: true }) });
    } catch (error) {
      return toolError(error);
    }
  },
});
