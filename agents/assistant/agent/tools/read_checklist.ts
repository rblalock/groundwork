import { defineTool } from "eve/tools";
import { z } from "zod";
import { checklistForTool, checklistOutlines, ensureChecklist } from "../../../../core/checklist";
import type { Language } from "../../../../core/language";
import { getProfile } from "../../../../core/profile";
import { getServiceJob } from "../../../../core/scheduling";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

const NO_QUOTE: Record<Language, string> = {
  en: "That work has no quote, so it has no checklist. Say so in one line; a visit is still marked done with change_visit_status.",
  es: "Ese servicio no tiene cotización, así que no tiene lista. Dilo en una línea; una visita se marca hecha con change_visit_status.",
};

export default defineTool({
  description:
    "Read the work's checklist: one item per line of its quote (name, quantity, unit; never prices), \"outlined in the photo\" (or \"in photo 2\" when the quote has several) when a priced photo shows it, each with done, who ticked it, and when. Pass jobId (sj_…, from read_schedule). Anyone on the team reads any work's list. The first read makes it from the quote when the work has none yet. text is the numbered list, done items marked ✓, ready to send. Pass itemIds to tick_checklist. Work with no quote has no list: a note says so.",
  inputSchema: z.object({ jobId: z.string().describe("The work (sj_…).") }),
  async execute({ jobId }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const job = await getServiceJob(caller, jobId);
      if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
      const items = await ensureChecklist(caller.orgId, job.id);
      if (!items.length) return { jobId: job.id, title: job.title, items: [], note: NO_QUOTE[caller.language] };
      const { timeZone } = await getProfile(caller.orgId);
      return plain({ jobId: job.id, title: job.title, ...checklistForTool(items, timeZone, caller.language, await checklistOutlines(caller.orgId, job.id)) });
    } catch (error) {
      return toolError(error);
    }
  },
});
