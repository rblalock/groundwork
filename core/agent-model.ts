import { createAzure } from "@ai-sdk/azure";
import { meteredModel } from "./metered-model";
import { currentDeployment } from "./model-pricing";
import { recordUsage, turnMeter } from "./usage";

const azure = createAzure({
  resourceName: process.env.AZURE_RESOURCE_NAME,
  apiKey: process.env.AZURE_API_KEY,
});

/**
 * An agent's model for one step: an Azure deployment (the app's, unless the agent names its own), metered.
 * The step's model is bound to the turn it runs in, so every call (compaction summaries too) leaves a
 * usage receipt for its business, member, and channel (core/usage.ts). Custom Azure deployments aren't in
 * the AI Gateway catalog, so the context window is set explicitly.
 */
export function stepModel(event: unknown, ctx: Parameters<typeof turnMeter>[1], deployment = currentDeployment()) {
  const turn = turnMeter(event, ctx);
  return {
    model: meteredModel(azure(deployment), (usage) => recordUsage(turn, usage, { deployment }).then(() => undefined)),
    modelContextWindowTokens: 128_000,
  };
}
