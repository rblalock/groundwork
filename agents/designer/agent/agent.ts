import { defineAgent, defineDynamic } from "eve";
import { stepModel } from "../../../core/agent-model";
import { designerModel } from "../../../core/model-pricing";

// The page designer: off unless DESIGNER_ENABLED=1. Its model (`designerModel()`) is named on its own so
// it can move apart from the assistant's, metered per turn like the assistant's (core/agent-model.ts).
// Its only tools are its own: the customer pages, read_brand, look_at_page, and the business's logo and
// PDF look (tools/), and a browser in its sandbox (extensions/browser, sandbox.ts) for the websites members name.
// A member keeps one conversation with it per page for good (agent_sessions), so sessions don't time out.
export default defineAgent({
  description: "Designs a business's customer pages (a quote's link, an invoice's pay link) with its owner or admins.",
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => {
        if (process.env.DESIGNER_ENABLED !== "1") throw new Error("Designer agent is disabled (set DESIGNER_ENABLED=1)");
        return stepModel(event, ctx, designerModel());
      },
    },
  }),
  defaultTools: false,
  compaction: { thresholdPercent: 0.75 },
  limits: { sessionTimeoutMs: false },
});
