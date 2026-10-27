import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { CUSTOMER_PAGE_KINDS } from "../../../../core/customer-page-template";
import { privilegedOnly } from "../../../../core/policies";
import { requireCaller, toolError } from "../../../../core/tool-context";
import { renderPreview } from "../../../../lib/pages/customer-pages";
import { browse, capture, openAt } from "../lib/browser";

type Violation = { id: string; impact: string | null; help: string; nodes: Array<{ target: unknown }> };

// The designer's own work, the way customers will see it: a saved version filled with the sample
// document, as the editor previews it, photographed at phone and desktop widths, with an accessibility
// check of the rendered page (contrast, mostly).
export default defineTool({
  description:
    "Look at a saved version of a customer page as customers will see it, filled with the sample document: screenshots at phone (390px) and desktop (1280px) width, and the accessibility problems found on it (contrast, mostly). Call it after every write or edit, check the page against your checklist, and fix what's off before replying.",
  inputSchema: z.object({
    page: z.enum(CUSTOMER_PAGE_KINDS),
    version: z.number().int().positive().optional().describe("The version to look at; the newest by default."),
    state: z.string().max(20).optional().describe('The document\'s state: "open", "approved", or "expired" for a quote; "payable", "paid", or "void" for an invoice.'),
    language: z.enum(["en", "es"]).default("en"),
  }),
  approval: privilegedOnly("design the business's customer pages"),
  async execute({ page, version, state, language }, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const html = await renderPreview(caller.orgId, page, { source: "sample", version, state, language });
      if (!html) throw new Error("PAGE_NOT_DESIGNED");
      const sandbox = await ctx.getSandbox();
      const path = `designer/${page}.html`;
      await sandbox.writeTextFile({ path, content: html });
      const url = `file://${sandbox.resolvePath(path)}`;
      await openAt(ctx, url, 390, 844);
      const phone = await capture(ctx, { full: true });
      const audit = await browse<{ violations?: Violation[] }>(ctx, ["a11y", url, "--json"]).catch(() => null);
      await openAt(ctx, url, 1280, 900);
      const desktop = await capture(ctx, { full: true });
      const problems = (audit?.violations ?? []).map((v) => ({ rule: v.id, impact: v.impact, help: v.help, where: v.nodes.slice(0, 4).map((n) => n.target) }));
      return { page, version: version ?? "newest", phone, desktop, problems };
    } catch (error) {
      return toolError(error);
    }
  },
  toModelOutput(output) {
    if (!("phone" in output)) return toolOutput.json(output);
    return toolOutput.content([
      toolOutputPart.text(`The ${output.page} page (${output.version}) on a phone, 390px wide:`),
      toolOutputPart.file(output.phone, { mediaType: "image/jpeg" }),
      toolOutputPart.text("On a desktop, 1280px wide:"),
      toolOutputPart.file(output.desktop, { mediaType: "image/jpeg" }),
      toolOutputPart.text(output.problems.length ? `Accessibility problems: ${JSON.stringify(output.problems)}` : "No accessibility problems found."),
    ]);
  },
});
