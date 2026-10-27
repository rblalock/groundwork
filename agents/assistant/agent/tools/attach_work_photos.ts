import { defineTool } from "eve/tools";
import { z } from "zod";
import { getServiceJob } from "../../../../core/scheduling";
import { attachTextedWorkPhotos, resolveWorkTarget } from "../../../../core/work-photos";
import { requireCaller, toolError } from "../../../../core/tool-context";

const PHOTO_WINDOW_MS = 30 * 60 * 1000;

export default defineTool({
  description:
    "Put the photos the member just texted on a piece of work: pictures of the job itself, usually the finished work (\"here's the after\", \"done at Oak St\" with photos), not photos for pricing a new job (those go on a quote). Give the visitId or jobId when you know it (read_schedule, get_quote); with neither, it uses the visit the member is on today. When it returns choose, ask which one in one line. Anyone on the team adds photos to any work. A short description is optional (\"before\", \"after\", \"back porch\").",
  inputSchema: z.object({
    visitId: z.string().optional().describe("The visit they were taken on, when known."),
    jobId: z.string().optional().describe("The work (sj_…), when there's no visit to name."),
    description: z.string().max(500).optional().describe("What they show, in the member's words."),
  }),
  async execute({ visitId, jobId, description }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const resolved = await resolveWorkTarget(caller, { visitId, jobId });
      if ("choose" in resolved) {
        return resolved.choose.length
          ? { added: 0, choose: resolved.choose }
          : { added: 0, choose: [], note: "No visit for this member today: ask which job these are for, then read_schedule or get_quote for its id." };
      }
      // Photos the member sent in the last half hour that no quote or work has taken.
      const added = await attachTextedWorkPhotos(caller, resolved.target, new Date(Date.now() - PHOTO_WINDOW_MS), description);
      const job = await getServiceJob(caller, resolved.target.jobId);
      return {
        added,
        jobId: resolved.target.jobId,
        visitId: resolved.target.visitId,
        title: job?.title ?? null,
        customerName: job?.customerName ?? null,
        ...(added === 0 ? { note: "No new photos from the member in the last half hour. On the web, photos are added on the work's page." } : {}),
      };
    } catch (error) {
      return toolError(error);
    }
  },
});
