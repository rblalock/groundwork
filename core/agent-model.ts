import { meteredModel } from "./metered-model";
import { contextTokens, currentModel, type ModelId } from "./model-pricing";
import { languageModel, modelProviderOptions } from "./model-provider";
import { recordUsage, turnMeter } from "./usage";

/**
 * An agent's model for one step: a Meta model (the app's, unless the agent names its own), metered.
 * The step's model is bound to the turn it runs in, so every call (compaction summaries too) leaves a
 * usage receipt for its business, member, and channel (core/usage.ts). Meta's models aren't in the AI
 * Gateway catalog, so the context window is set explicitly, to the app's budget (`contextTokens()`).
 */
export function stepModel(event: unknown, ctx: Parameters<typeof turnMeter>[1], modelId: ModelId = currentModel()) {
  const turn = turnMeter(event, ctx);
  const providerOptions = modelProviderOptions();
  return {
    model: meteredModel(languageModel(modelId), (usage) => recordUsage(turn, usage, { deployment: modelId }).then(() => undefined)),
    modelContextWindowTokens: contextTokens(),
    reasoning: providerOptions.openai.reasoningEffort,
    modelOptions: { providerOptions },
  };
}
