// The one place the app reaches a model: Meta's Model API, which speaks the OpenAI Responses API.
// The agent's steps, translation, and the eval judge all build their models here.
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { currentModel, type ModelId } from "./model-pricing";

export type ReasoningEffort = "low" | "medium" | "high";

const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** True when the Meta Model API key is set, so model calls can run. */
export function modelReady(): boolean {
  return Boolean(process.env.META_MODEL_API_KEY?.trim());
}

/**
 * A model on the Meta Model API: the app's (`currentModel()`) unless one is named. `MODEL_API=chat` swaps
 * the Responses API for Chat Completions, a fallback in case the Responses path misbehaves.
 */
export function languageModel(modelId: ModelId = currentModel()): Exclude<LanguageModel, string> {
  const provider = createOpenAI({
    baseURL: process.env.MODEL_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey: process.env.META_MODEL_API_KEY,
  });
  return process.env.MODEL_API === "chat" ? provider.chat(modelId) : provider.responses(modelId);
}

function envEffort(): ReasoningEffort {
  const value = process.env.MODEL_REASONING_EFFORT?.trim() as ReasoningEffort | undefined;
  return value && EFFORTS.includes(value) ? value : "medium";
}

/**
 * Provider options every call sends. `store: false` because the provider otherwise replays earlier
 * steps as stored-item references, which Meta doesn't resolve, so the second step after a tool call
 * fails. `forceReasoning` because the provider only sends reasoning effort for model ids it knows.
 */
export function modelProviderOptions(effort: ReasoningEffort = envEffort()) {
  return { openai: { store: false, forceReasoning: true, reasoningEffort: effort } } as const;
}
