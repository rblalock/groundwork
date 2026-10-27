// What a model call costs, estimated. These are list prices in US dollars per million tokens, keyed by
// Azure deployment name: a published scenario, not this account's Azure rate sheet. Every cost shown
// from them is an estimate and says so. `MODEL_PRICES` overrides or adds deployments, as JSON:
//   MODEL_PRICES='{"muse-wonder-1.0":{"input":4,"cachedInput":0.2,"output":20}}'
// A deployment that's in neither is priced at the default deployment's rates and marked `fallback`.

/** USD per one million tokens. Reasoning tokens are billed as output. */
export type ModelRates = { input: number; cachedInput: number; cacheWrite: number; output: number };

export const DEFAULT_DEPLOYMENT = "muse-wonder-1.0";

/** The page designer's deployment, set on its own so it can move apart from the assistant's. */
export const DEFAULT_DESIGNER_DEPLOYMENT = "muse-wonder-1.0";

/** Public list prices. muse-spark-1.3 is the cheaper fallback to muse-wonder-1.0. */
export const PRICE_TABLE: Readonly<Record<string, ModelRates>> = {
  "muse-wonder-1.0": { input: 4, cachedInput: 0.2, cacheWrite: 0.2, output: 20 },
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, cacheWrite: 0.15, output: 4.25 },
};

export type PriceSource = "table" | "env" | "fallback";

/** The tokens one call reported. `inputTokens` is the whole prompt, cache reads included. */
export type CallTokens = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

export function currentDeployment(): string {
  return process.env.AZURE_DEPLOYMENT_NAME?.trim() || DEFAULT_DEPLOYMENT;
}

export function designerDeployment(): string {
  return process.env.DESIGNER_DEPLOYMENT_NAME?.trim() || DEFAULT_DESIGNER_DEPLOYMENT;
}

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

/** The rates for a deployment and where they came from. */
export function ratesFor(deployment: string): { rates: ModelRates; source: PriceSource } {
  const base = PRICE_TABLE[deployment];
  const override = envPrices()[deployment];
  if (override) {
    const fallback = base ?? PRICE_TABLE[DEFAULT_DEPLOYMENT];
    return {
      rates: {
        input: rate(override.input) ?? fallback.input,
        cachedInput: rate(override.cachedInput) ?? fallback.cachedInput,
        cacheWrite: rate(override.cacheWrite) ?? fallback.cacheWrite,
        output: rate(override.output) ?? fallback.output,
      },
      source: "env",
    };
  }
  if (base) return { rates: base, source: "table" };
  return { rates: PRICE_TABLE[DEFAULT_DEPLOYMENT], source: "fallback" };
}

/** The estimated cost of one call, in US dollars, to eight places. */
export function estimateCostUsd(tokens: CallTokens, rates: ModelRates): number {
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  const uncached = Math.max(0, tokens.inputTokens - cached);
  const usd =
    (uncached * rates.input + cached * rates.cachedInput + tokens.cacheWriteTokens * rates.cacheWrite + tokens.outputTokens * rates.output) /
    1_000_000;
  return Number(usd.toFixed(8));
}
