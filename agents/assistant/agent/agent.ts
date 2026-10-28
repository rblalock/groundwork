import { defineAgent, defineDynamic } from "eve";
import { stepModel } from "../../../core/agent-model";

// The app's Meta model, metered per turn (core/agent-model.ts).
export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (event, ctx) => stepModel(event, ctx),
    },
  }),
  defaultTools: false,
  compaction: { thresholdPercent: 0.75 },
  // sharp (the priced photo's renderer) loads a native binary, so it must stay a dependency of the
  // hosted bundle instead of being compiled into it.
  build: { externalDependencies: ["sharp"] },
});
