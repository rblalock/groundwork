// A live check of the Meta Model API through the app's own factory (core/model-provider.ts): plain text,
// a tool call followed by a second step, structured output, and the fallback model. Prints each check's
// result, model, tokens, and time, never the key. Exits 1 if any check fails.
//   npm run smoke:model
import { generateText, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { currentModel } from "../core/model-pricing";
import { languageModel, modelProviderOptions, modelReady } from "../core/model-provider";

type Usage = { inputTokens?: number; outputTokens?: number };

async function check(name: string, modelId: string, run: () => Promise<{ usage: Usage; detail?: string }>): Promise<boolean> {
  const started = Date.now();
  try {
    const { usage, detail } = await run();
    const ms = Date.now() - started;
    console.log(`ok    ${name}  model=${modelId}  in=${usage.inputTokens ?? "?"} out=${usage.outputTokens ?? "?"}  ${ms}ms${detail ? `  ${detail}` : ""}`);
    return true;
  } catch (error) {
    const ms = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL  ${name}  model=${modelId}  ${ms}ms  ${message}`);
    return false;
  }
}

async function plainText(modelId: string) {
  const result = await generateText({
    model: languageModel(modelId),
    prompt: "Reply with one short sentence: what does a landscaper do?",
    providerOptions: modelProviderOptions(),
  });
  if (!result.text.trim()) throw new Error("empty reply");
  return { usage: result.totalUsage, detail: JSON.stringify(result.text.trim().slice(0, 80)) };
}

async function main() {
  if (!modelReady()) {
    console.log("FAIL  META_MODEL_API_KEY is not set");
    process.exit(1);
  }
  const primary = currentModel();
  const api = process.env.MODEL_API === "chat" ? "chat" : "responses";
  console.log(`Meta Model API (${api}) at ${process.env.MODEL_BASE_URL?.trim() || "https://api.meta.ai/v1"}`);

  const results = [
    await check("text", primary, () => plainText(primary)),

    await check("tool, then a second step", primary, async () => {
      let calls = 0;
      const result = await generateText({
        model: languageModel(primary),
        system: "You quote landscaping jobs. Always look prices up with the lookup_price tool; never guess a price.",
        prompt: "What is the price of one mulch delivery? Give the price in dollars.",
        tools: {
          lookup_price: tool({
            description: "Look up the price of a price-book item.",
            inputSchema: z.object({ item: z.string() }),
            execute: async () => {
              calls += 1;
              return { cents: 12500 };
            },
          }),
        },
        stopWhen: stepCountIs(3),
        providerOptions: modelProviderOptions(),
      });
      if (calls === 0) throw new Error("the tool was never called");
      if (result.steps.length < 2) throw new Error(`only ${result.steps.length} step(s)`);
      if (!result.text.includes("125")) throw new Error(`final text doesn't mention 125: ${JSON.stringify(result.text.slice(0, 200))}`);
      return { usage: result.totalUsage, detail: `steps=${result.steps.length} ${JSON.stringify(result.text.trim().slice(0, 80))}` };
    }),

    await check("structured output", primary, async () => {
      const result = await generateText({
        model: languageModel(primary),
        output: Output.object({ schema: z.object({ score: z.number(), reason: z.string() }) }),
        prompt: "Score from 1 to 5 how clear this quote line is, with a one-sentence reason: 'Mulch, 3 cubic yards, $135'.",
        providerOptions: modelProviderOptions("low"),
      });
      return { usage: result.usage, detail: JSON.stringify(result.output).slice(0, 120) };
    }),

    await check("fallback text", "muse-spark-1.3", () => plainText("muse-spark-1.3")),
  ];

  process.exit(results.every(Boolean) ? 0 : 1);
}

await main();
