// The model, metered. Every call through it (ordinary steps and eve's compaction summaries alike)
// reports the provider's token counts once it finishes, streamed or not. agents/assistant/agent/agent.ts wraps the
// app's Meta model with this for each step, bound to the turn the step belongs to, so each call
// becomes one usage receipt (core/usage.ts). A failure to record is logged, never thrown: a
// receipt is bookkeeping, and the member's turn goes on.
import { wrapLanguageModel, type LanguageModel } from "ai";

type Model = Exclude<LanguageModel, string>;

/**
 * One finished call's usage. `reasoningTokens` is part of `outputTokens`; null when not reported.
 * `translation` is the web app's translated view (core/translation.ts), not a turn's step.
 */
export type CallUsage = {
  kind: "step" | "compaction" | "translation" | "sam";
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
  responseId: string | null;
  responseModel: string | null;
  /** The images a SAM call processed, its billed unit. */
  images?: number;
};

type TokenCount = number | { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number; text?: number; reasoning?: number } | undefined;
type RawUsage = { inputTokens?: TokenCount; outputTokens?: TokenCount } | undefined;

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

function part(value: TokenCount, key: "total" | "cacheRead" | "cacheWrite" | "reasoning"): number | undefined {
  if (typeof value === "number") return key === "total" ? count(value) : undefined;
  return count(value?.[key]);
}

/** The provider's usage, in the AI SDK's v3/v4 shape or the older flat one, as plain counts. */
export function readUsage(usage: RawUsage): Omit<CallUsage, "kind" | "responseId" | "responseModel"> {
  return {
    inputTokens: part(usage?.inputTokens, "total") ?? 0,
    cachedInputTokens: part(usage?.inputTokens, "cacheRead") ?? 0,
    cacheWriteTokens: part(usage?.inputTokens, "cacheWrite") ?? 0,
    outputTokens: part(usage?.outputTokens, "total") ?? 0,
    reasoningTokens: part(usage?.outputTokens, "reasoning") ?? null,
  };
}

const COMPACTION_MARKER = "CONTEXT CHECKPOINT COMPACTION";

/** eve's compaction summary: a call whose system prompt is eve's checkpoint instruction. */
export function isCompactionPrompt(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((message: { role?: unknown; content?: unknown }) => message?.role === "system" && typeof message.content === "string" && message.content.includes(COMPACTION_MARKER));
}

export function meteredModel(model: Model, onUsage: (usage: CallUsage) => Promise<void>): Model {
  const report = async (usage: CallUsage) => {
    try {
      await onUsage(usage);
    } catch (error) {
      console.error("usage: a model call's receipt was not recorded", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        const response = (result as { response?: { id?: string; modelId?: string } }).response;
        await report({
          kind: isCompactionPrompt(params.prompt) ? "compaction" : "step",
          ...readUsage(result.usage as RawUsage),
          responseId: response?.id ?? null,
          responseModel: response?.modelId ?? null,
        });
        return result;
      },
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        const kind = isCompactionPrompt(params.prompt) ? "compaction" : "step";
        let responseId: string | null = null;
        let responseModel: string | null = null;
        let usage: RawUsage;
        const stream = result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              const c = chunk as { type?: string; id?: string; modelId?: string; usage?: RawUsage };
              if (c.type === "response-metadata") {
                responseId = c.id ?? responseId;
                responseModel = c.modelId ?? responseModel;
              }
              if (c.type === "finish") usage = c.usage;
              controller.enqueue(chunk);
            },
            async flush() {
              // A stream that ends without a finish part reported nothing to bill.
              if (usage) await report({ kind, ...readUsage(usage), responseId, responseModel });
            },
          }),
        );
        return { ...result, stream };
      },
    },
  }) as Model;
}
