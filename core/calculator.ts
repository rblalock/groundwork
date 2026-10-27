// The only place quote totals are computed. Pure and deterministic: integer cents,
// basis points for percentages. The model never does arithmetic.
import { createHash } from "node:crypto";
import type { Adjustment, AppliedRule, LineInput, LineResult, RuleLine } from "../schema/types";
import { percentOf } from "./money";

export type { Adjustment, AppliedRule, LineInput, LineResult, LineSource, RuleEffect, RuleLine, UnitKind } from "../schema/types";

export interface CalcInput {
  lines: LineInput[];
  rules: AppliedRule[];
  minimumCents: number | null;
  adjustments: Adjustment[];
  taxRateBp: number | null;
}

export interface CalcResult {
  state: "ready" | "needs_owner";
  reasons: string[];
  lines: LineResult[];
  ruleLines: RuleLine[];
  linesSubtotalCents: number;
  subtotalCents: number;
  minimumAppliedCents: number;
  adjustmentCents: number;
  preTaxCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
  hash: string;
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

function appliesToLine(rule: NonNullable<AppliedRule["effect"]>, line: LineResult): boolean {
  return rule.appliesTo === "any" || (line.itemId !== null && rule.appliesTo.includes(line.itemId));
}

/** JSON with object keys sorted at every depth, so equal inputs always hash equally. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function calculate(input: CalcInput): CalcResult {
  let reasons: string[] = [];

  const lines: LineResult[] = input.lines.map((line) => {
    if (line.unitCents === null) {
      reasons.push(`unpriced:${line.name}`);
      return { ...line, totalCents: null };
    }
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      reasons.push(`bad_quantity:${line.name}`);
      return { ...line, totalCents: null };
    }
    return { ...line, totalCents: Math.round(line.quantity * line.unitCents) };
  });

  const linesSubtotalCents = sum(lines.map((l) => l.totalCents ?? 0));

  const ruleLines: RuleLine[] = [];
  for (const rule of input.rules) {
    const effect = rule.effect;
    if (!effect) continue;
    const matched = lines.filter((l) => appliesToLine(effect, l));
    let cents: number;
    if (effect.op === "add_fixed") cents = effect.amount;
    else if (effect.op === "add_per_unit") cents = Math.round(effect.amount * sum(matched.filter((l) => l.totalCents !== null).map((l) => l.quantity)));
    else cents = percentOf(sum(matched.map((l) => l.totalCents ?? 0)), effect.amount);
    ruleLines.push({ ruleId: rule.ruleId, label: rule.text || rule.ruleId, cents });
  }

  const subtotalCents = linesSubtotalCents + sum(ruleLines.map((r) => r.cents));

  const minimumAppliedCents =
    reasons.length === 0 && input.minimumCents !== null ? Math.max(0, input.minimumCents - subtotalCents) : 0;

  const overrides = input.adjustments.filter((a) => a.kind === "override");
  // One total override ("just call it 400") prices the job, so unpriced lines no longer block it.
  if (overrides.length === 1) reasons = reasons.filter((r) => !r.startsWith("unpriced:"));
  if (overrides.length > 1) reasons.push("multiple_overrides");
  const discountCents = sum(input.adjustments.filter((a) => a.kind === "discount").map((a) => a.amountCents));

  const beforeAdjustments = subtotalCents + minimumAppliedCents;
  let preTaxCents = overrides.length === 1 ? overrides[0].amountCents : beforeAdjustments - discountCents;
  if (preTaxCents < 0) {
    reasons.push("negative_total");
    preTaxCents = 0;
  }
  const adjustmentCents = preTaxCents - beforeAdjustments;

  const taxableLinesCents = sum(lines.filter((l) => l.taxable).map((l) => l.totalCents ?? 0));
  // With no priced lines (an override over unpriced ones), the share is by count of taxable lines.
  const taxableShare =
    linesSubtotalCents !== 0
      ? taxableLinesCents / linesSubtotalCents
      : lines.length === 0
        ? 0
        : lines.filter((l) => l.taxable).length / lines.length;
  const nonLineCents = sum(ruleLines.map((r) => r.cents)) + minimumAppliedCents + adjustmentCents;
  const taxableCents = Math.max(0, taxableLinesCents + Math.round(nonLineCents * taxableShare));
  const taxCents = input.taxRateBp ? percentOf(taxableCents, input.taxRateBp) : 0;
  const totalCents = preTaxCents + taxCents;

  const hash = createHash("sha256")
    .update(stableJson({ input, linesSubtotalCents, subtotalCents, minimumAppliedCents, adjustmentCents, taxCents, totalCents }))
    .digest("hex");

  return {
    state: reasons.length === 0 ? "ready" : "needs_owner",
    reasons,
    lines,
    ruleLines,
    linesSubtotalCents,
    subtotalCents,
    minimumAppliedCents,
    adjustmentCents,
    preTaxCents,
    taxableCents,
    taxCents,
    totalCents,
    hash,
  };
}
