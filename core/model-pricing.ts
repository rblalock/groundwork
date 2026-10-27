// The model catalog: which Meta model the app calls, its context budget, and what a call costs, estimated.
// Prices are list prices in US dollars per million tokens, keyed by model id (SAM's are per image); every
// cost shown from them is an estimate and says so. `MODEL_PRICES` overrides or adds models, as JSON:
//   MODEL_PRICES='{"muse-wonder-1.0":{"input":4,"cachedInput":0.2,"output":20}}'
// A model that's in neither is priced at the default model's rates and marked `fallback`.

/** A Meta Model API model id, such as `muse-wonder-1.0`. */
export type ModelId = string;

/** USD per one million tokens, and per image for a model billed by the image. Reasoning tokens are billed as output. */
export type ModelRates = { input: number; cachedInput: number; cacheWrite: number; output: number; image?: number };

const DEFAULT_MODEL: ModelId = "muse-wonder-1.0";
const DEFAULT_FALLBACK_MODEL: ModelId = "muse-spark-1.3";
const DEFAULT_CONTEXT_TOKENS = 200_000;

/** Public list prices. muse-spark-1.3 is the cheaper fallback to muse-wonder-1.0; sam-3.1 is $2.50 per 1,000 images. */
export const PRICE_TABLE: Readonly<Record<ModelId, ModelRates>> = {
  "muse-wonder-1.0": { input: 4, cachedInput: 0.2, cacheWrite: 0.2, output: 20 },
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, cacheWrite: 0.15, output: 4.25 },
  "sam-3.1": { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, image: 0.0025 },
};

/** The model every call uses: `MODEL_ID`, or `MODEL_FALLBACK_ID` when `MODEL_USE_FALLBACK=1`. */
export function currentModel(): ModelId {
  if (process.env.MODEL_USE_FALLBACK === "1") return process.env.MODEL_FALLBACK_ID?.trim() || DEFAULT_FALLBACK_MODEL;
  return process.env.MODEL_ID?.trim() || DEFAULT_MODEL;
}

/** The page designer's model. The same as the assistant's for now, named so it can move apart. */
export function designerModel(): ModelId {
  return currentModel();
}

/**
 * The context window the app budgets for, not the model's advertised one. Compaction triggers off it, and
 * an iMessage thread is one long-lived session, so a smaller budget keeps each step's cost in check.
 */
export function contextTokens(): number {
  const value = Number(process.env.MODEL_CONTEXT_TOKENS?.trim());
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONTEXT_TOKENS;
}

export type PriceSource = "table" | "env" | "fallback";

/** The tokens one call reported. `inputTokens` is the whole prompt, cache reads included. `images` is a SAM call's. */
export type CallTokens = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  images?: number;
};

function envPrices(): Record<string, Partial<ModelRates>> {
  const raw = process.env.MODEL_PRICES?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, Partial<ModelRates>>;
  } catch (error) {
    console.error("model pricing: MODEL_PRICES is not valid JSON; using the built-in table", { error: String(error) });
    return {};
  }
}

const rate = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** The rates for a model and where they came from. */
export function ratesFor(model: ModelId): { rates: ModelRates; source: PriceSource } {
  const base = PRICE_TABLE[model];
  const override = envPrices()[model];
  if (override) {
    const fallback = base ?? PRICE_TABLE[DEFAULT_MODEL];
    const image = rate(override.image) ?? fallback.image;
    return {
      rates: {
        input: rate(override.input) ?? fallback.input,
        cachedInput: rate(override.cachedInput) ?? fallback.cachedInput,
        cacheWrite: rate(override.cacheWrite) ?? fallback.cacheWrite,
        output: rate(override.output) ?? fallback.output,
        ...(image === undefined ? {} : { image }),
      },
      source: "env",
    };
  }
  if (base) return { rates: base, source: "table" };
  return { rates: PRICE_TABLE[DEFAULT_MODEL], source: "fallback" };
}

/** The estimated cost of one call, in US dollars, to eight places. */
export function estimateCostUsd(tokens: CallTokens, rates: ModelRates): number {
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const uncached = Math.max(0, tokens.inputTokens - cached);
  const usd =
    (uncached * rates.input + cached * rates.cachedInput + tokens.cacheWriteTokens * rates.cacheWrite + tokens.outputTokens * rates.output) /
      1_000_000 +
    (tokens.images ?? 0) * (rates.image ?? 0);
  return Number(usd.toFixed(8));
}
