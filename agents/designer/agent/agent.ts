import { defineAgent, defineDynamic } from "eve";
import { stepModel } from "../../../core/agent-model";
import { designerDeployment } from "../../../core/model-pricing";

// The page designer: its own deployment (DESIGNER_DEPLOYMENT_NAME, muse-wonder-1.0 by default), set
// apart from the assistant's so it can move on its own, metered per turn like the assistant's
// (core/agent-model.ts). Its only tools are its own: the customer pages, read_brand, look_at_page, and
// the business's logo and PDF look (tools/), and a browser in its sandbox (extensions/browser, sandbox.ts) for the websites members name.
// A member keeps one conversation with it per page for good (agent_sessions), so sessions don't time out.
export default defineAgent({
  description: "Designs a business's customer pages (a quote's link, an invoice's pay link) with its owner or admins.",
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => stepModel(event, ctx, designerDeployment()),
    },
  }),
  defaultTools: false,
  compaction: { thresholdPercent: 0.75 },
  limits: { sessionTimeoutMs: false },
});
