import { z } from "zod";
import { listMembers } from "../../core/members";
import { acceptRule, findItemByName, listItems, listRules, nameKey, retireRule, saveItems, saveRule, updateItem, type Item, type Rule } from "../../core/pricebook";
import { cents, ruleKindSchema } from "../../core/tool-schemas";
import { HttpError, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { privilegedActor, refuse } from "./access";

// The price book is for owners and admins (the nav hides it from crew and the page 404s for them):
// crew text their own price for one job, and only the owner's prices go in the book.

export type PricebookPage = { items: Item[]; rules: Array<Rule & { by: string | null }> };

function requireOwnerView(caller: AppCaller): void {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
}

/** Every item, active first, and every rule: suggestions waiting on the owner first, then active, then retired. */
export async function pricebookFor(caller: AppCaller): Promise<PricebookPage> {
  requireOwnerView(caller);
  const [items, rules, members] = await Promise.all([
    listItems(caller.orgId, { includeRetired: true }),
    listRules(caller.orgId, { includeRetired: true, includeSuggested: true }),
    listMembers(caller.orgId),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const order = { suggested: 0, active: 1, retired: 2 } as const;
  return {
    items: [...items].sort((a, b) => Number(a.status === "retired") - Number(b.status === "retired")),
    rules: rules
      .map((rule) => ({ ...rule, by: names.get(rule.memberId) ?? null }))
      .sort((a, b) => order[a.status] - order[b.status]),
  };
}

const UNIT_KINDS = ["each", "sqft", "linear_ft", "hour", "visit", "flat", "other"] as const;
const itemName = z.string().trim().min(1).max(120);
const unitLabel = z.string().trim().min(1).max(40);
const price = cents.max(100_000_000);

export const itemPatchSchema = z
  .object({
    name: itemName.optional(),
    unitKind: z.enum(UNIT_KINDS).optional(),
    unitLabel: unitLabel.optional(),
    priceCents: price.optional(),
    taxable: z.boolean().optional(),
    status: z.enum(["active", "retired"]).optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), "Pass something to change.");

/** Edits an item (name, unit, price, taxable) or retires or restores it, through `updateItem`, which logs the change and bumps the price book's version. */
export async function updateItemFromApp(caller: AppCaller, itemId: string, patch: z.infer<typeof itemPatchSchema>): Promise<Item> {
  const actor = privilegedActor(caller);
  const e = pageCopyFor(caller.language).pricebook.errors;
  try {
    return await updateItem(caller.orgId, itemId, patch, actor.memberId);
  } catch (error) {
    refuse(error, {
      ITEM_NOT_FOUND: [404, "That isn't here."],
      NAME_TAKEN: [409, e.nameTaken],
      INVALID_ITEM_NAME: [400, e.nameRequired],
    });
  }
}

export const newItemSchema = z
  .object({ name: itemName, unitKind: z.enum(UNIT_KINDS), unitLabel, priceCents: price, taxable: z.boolean().optional() })
  .strict();

/**
 * Adds an item to the price book, as `save_pricebook_items` does. A name already in the book (retired ones
 * too) is refused rather than overwritten: the page edits that item instead.
 */
export async function createItemFromApp(caller: AppCaller, input: z.infer<typeof newItemSchema>): Promise<Item> {
  const actor = privilegedActor(caller);
  const e = pageCopyFor(caller.language).pricebook.errors;
  if (!nameKey(input.name)) throw new HttpError(400, "INVALID_ITEM_NAME", e.nameRequired);
  if (await findItemByName(caller.orgId, input.name)) throw new HttpError(409, "NAME_TAKEN", e.nameTaken);
  try {
    const [item] = await saveItems(caller.orgId, [{ ...input, taxable: input.taxable ?? true }], actor.memberId);
    return item;
  } catch (error) {
    refuse(error, { INVALID_ITEM_NAME: [400, e.nameRequired] });
  }
}

export const newRuleSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    kind: ruleKindSchema,
    effect: z
      .object({
        op: z.enum(["add_fixed", "add_per_unit", "percent"]),
        // Cents, or basis points for a percent; negative for a discount.
        amount: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0),
        appliesTo: z.union([z.literal("any"), z.array(z.string().min(1).max(64)).min(1).max(20)]),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((rule) => !rule.effect || rule.kind === "pricing_modifier", "Only a pricing rule changes the price.")
  .refine((rule) => !rule.effect || rule.effect.op !== "percent" || Math.abs(rule.effect.amount) <= 100_000, "A percent is at most 1000%.");

/** Adds an owner's rule, active now, as `save_rule` does for an owner or admin. Items it applies to must be this business's. */
export async function createRuleFromApp(caller: AppCaller, input: z.infer<typeof newRuleSchema>): Promise<Rule> {
  const actor = privilegedActor(caller);
  const appliesTo = input.effect?.appliesTo;
  if (Array.isArray(appliesTo)) {
    const ours = new Set((await listItems(caller.orgId, { includeRetired: true })).map((item) => item.id));
    if (!appliesTo.every((id) => ours.has(id))) throw new HttpError(404, "ITEM_NOT_FOUND", "That isn't here.");
  }
  return saveRule(caller.orgId, { text: input.text, kind: input.kind, effect: input.effect ?? null, status: "active" }, actor.memberId);
}

/** Accept a crew suggestion (it becomes the owner's active rule) or retire a rule, as the assistant does. */
export async function ruleActionFromApp(caller: AppCaller, ruleId: string, action: "accept" | "retire"): Promise<Rule> {
  const actor = privilegedActor(caller);
  try {
    return action === "accept"
      ? await acceptRule(caller.orgId, ruleId, actor.memberId)
      : await retireRule(caller.orgId, ruleId, actor.memberId);
  } catch (error) {
    refuse(error, {
      RULE_NOT_FOUND: [404, "That isn't here."],
      RULE_NOT_SUGGESTED: [409, pageCopyFor(caller.language).pricebook.errors.notSuggested],
    });
  }
}
