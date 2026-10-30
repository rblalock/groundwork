import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { pricebookChanges, pricebookItems, rules } from "../schema/schema";
import type { RuleEffect, UnitKind } from "./calculator";
import { db, newId, type Db, type Tx } from "./db";
import { cleanEquipment } from "./equipment";
import { recordEvent } from "./events";
import { bumpVersion, getProfileWith } from "./profile";

export type Item = typeof pricebookItems.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type NewItem = {
  name: string;
  unitKind: UnitKind;
  unitLabel: string;
  priceCents: number;
  taxable?: boolean;
  group?: string;
  notes?: string;
  /** The noun phrase that finds the item in a photo, for the priced photo. */
  photoPrompt?: string;
  /** What doing it needs ("trailer"); see `core/equipment.ts`. */
  equipment?: string[];
  createdFromQuoteId?: string;
};
export type ItemPatch = Partial<
  Pick<Item, "name" | "unitLabel" | "unitKind" | "priceCents" | "taxable" | "status" | "group" | "notes" | "photoPrompt" | "equipment">
>;

/** Lowercase, trim, collapse whitespace, strip punctuation except `/` and `-`. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function listItems(orgId: string, options: { includeRetired?: boolean } = {}): Promise<Item[]> {
  return db()
    .select()
    .from(pricebookItems)
    .where(and(eq(pricebookItems.orgId, orgId), options.includeRetired ? undefined : eq(pricebookItems.status, "active")))
    .orderBy(asc(pricebookItems.name), asc(pricebookItems.id));
}

/** Matches on the normalized name key; includes retired items. */
export async function findItemByName(orgId: string, name: string): Promise<Item | null> {
  const [row] = await db()
    .select()
    .from(pricebookItems)
    .where(and(eq(pricebookItems.orgId, orgId), eq(pricebookItems.nameKey, nameKey(name))));
  return row ?? null;
}

const TRACKED_FIELDS = [
  "name",
  "unitLabel",
  "unitKind",
  "priceCents",
  "taxable",
  "status",
  "group",
  "notes",
  "photoPrompt",
  "equipment",
] as const satisfies readonly (keyof ItemPatch)[];

const FIELD_NAMES: Record<(typeof TRACKED_FIELDS)[number], string> = {
  name: "name",
  unitLabel: "unit_label",
  unitKind: "unit_kind",
  priceCents: "price_cents",
  taxable: "taxable",
  status: "status",
  group: "group",
  notes: "notes",
  photoPrompt: "photo_prompt",
  equipment: "equipment",
};

/** A field's value as the change log keeps it: a list as its words joined by commas. */
const fieldText = (value: unknown) => (Array.isArray(value) ? value.join(", ") : String(value));
const sameValue = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? a.join("\n") === b.join("\n") : a === b);

/** Applies a patch to an existing item. Logs one change row per changed field. Returns null when nothing changed. */
async function applyPatch(
  tx: Tx,
  current: Item,
  patch: ItemPatch,
  memberId: string,
  sourceMessageId?: string,
): Promise<Item | null> {
  const changed = TRACKED_FIELDS.filter(
    (field) => patch[field] !== undefined && !sameValue(patch[field], current[field]),
  );
  if (changed.length === 0) return null;
  const version = current.version + 1;
  const set: Record<string, unknown> = { version, updatedAt: new Date() };
  for (const field of changed) set[field] = patch[field];
  if (changed.includes("name")) set.nameKey = nameKey(patch.name as string);
  const [updated] = await tx
    .update(pricebookItems)
    .set(set)
    .where(and(eq(pricebookItems.orgId, current.orgId), eq(pricebookItems.id, current.id)))
    .returning();
  await tx.insert(pricebookChanges).values(
    changed.map((field) => ({
      id: newId("pbc"),
      orgId: current.orgId,
      itemId: current.id,
      field: FIELD_NAMES[field],
      oldValue: current[field] === null ? null : fieldText(current[field]),
      newValue: fieldText(patch[field]),
      memberId,
      sourceMessageId: sourceMessageId ?? null,
      version,
    })),
  );
  return updated;
}

/** What saving one item did: added it, changed a saved one, or found it already saved as is. */
export type SaveOutcome = "added" | "updated" | "unchanged";

/**
 * Upserts by name key. A changed field logs pricebook_changes rows and bumps the item
 * version; a re-saved retired item comes back active. Bumps pricebookVersion once,
 * and only when something was created or changed.
 */
export async function saveItems(
  orgId: string,
  items: NewItem[],
  memberId: string,
  sourceMessageId?: string,
): Promise<Item[]> {
  return (await saveItemsWithOutcome(orgId, items, memberId, sourceMessageId)).map((s) => s.item);
}

/** `saveItems`, with what happened to each item, in input order. */
export async function saveItemsWithOutcome(
  orgId: string,
  items: NewItem[],
  memberId: string,
  sourceMessageId?: string,
): Promise<Array<{ item: Item; outcome: SaveOutcome }>> {
  return db().transaction(async (tx) => {
    const saved: Array<{ item: Item; outcome: SaveOutcome }> = [];
    let touched = false;
    for (const input of items) {
      const key = nameKey(input.name);
      if (!key) throw new Error("INVALID_ITEM_NAME");
      const [existing] = await tx
        .select()
        .from(pricebookItems)
        .where(and(eq(pricebookItems.orgId, orgId), eq(pricebookItems.nameKey, key)));
      if (!existing) {
        const [created] = await tx
          .insert(pricebookItems)
          .values({
            id: newId("pbi"),
            orgId,
            name: input.name.trim(),
            nameKey: key,
            unitKind: input.unitKind,
            unitLabel: input.unitLabel,
            priceCents: input.priceCents,
            taxable: input.taxable ?? true,
            group: input.group ?? null,
            notes: input.notes ?? null,
            photoPrompt: input.photoPrompt ?? null,
            equipment: cleanEquipment(input.equipment ?? []),
            createdFromQuoteId: input.createdFromQuoteId ?? null,
          })
          .returning();
        saved.push({ item: created, outcome: "added" });
        touched = true;
        continue;
      }
      const updated = await applyPatch(
        tx,
        existing,
        {
          unitKind: input.unitKind,
          unitLabel: input.unitLabel,
          priceCents: input.priceCents,
          taxable: input.taxable,
          group: input.group,
          notes: input.notes,
          photoPrompt: input.photoPrompt,
          equipment: input.equipment && cleanEquipment(input.equipment),
          status: "active",
        },
        memberId,
        sourceMessageId,
      );
      if (updated) touched = true;
      saved.push(updated ? { item: updated, outcome: "updated" } : { item: existing, outcome: "unchanged" });
    }
    if (touched) await bumpVersion(orgId, "pricebook", tx);
    return saved;
  });
}

/** Edits one item (rename, reprice, what it needs, retire). Throws `ITEM_NOT_FOUND` or `NAME_TAKEN`. */
export async function updateItem(
  orgId: string,
  itemId: string,
  patch: ItemPatch,
  memberId: string,
  sourceMessageId?: string,
): Promise<Item> {
  return db().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(pricebookItems)
      .where(and(eq(pricebookItems.orgId, orgId), eq(pricebookItems.id, itemId)));
    if (!current) throw new Error("ITEM_NOT_FOUND");
    if (patch.name !== undefined) {
      const key = nameKey(patch.name);
      if (!key) throw new Error("INVALID_ITEM_NAME");
      const [clash] = await tx
        .select({ id: pricebookItems.id })
        .from(pricebookItems)
        .where(and(eq(pricebookItems.orgId, orgId), eq(pricebookItems.nameKey, key)));
      if (clash && clash.id !== itemId) throw new Error("NAME_TAKEN");
    }
    const tidy = patch.equipment ? { ...patch, equipment: cleanEquipment(patch.equipment) } : patch;
    const updated = await applyPatch(tx, current, tidy, memberId, sourceMessageId);
    if (!updated) return current;
    await bumpVersion(orgId, "pricebook", tx);
    return updated;
  });
}

export function listRules(
  orgId: string,
  options: { includeRetired?: boolean; includeSuggested?: boolean } = {},
): Promise<Rule[]> {
  const statuses: Rule["status"][] = ["active"];
  if (options.includeSuggested) statuses.push("suggested");
  if (options.includeRetired) statuses.push("retired");
  return db()
    .select()
    .from(rules)
    .where(and(eq(rules.orgId, orgId), inArray(rules.status, statuses)))
    .orderBy(asc(rules.createdAt), asc(rules.id));
}

/** Stores a rule. Only an active rule bumps rulesVersion; a suggested one waits for the owner. */
export async function saveRule(
  orgId: string,
  input: { text: string; kind: Rule["kind"]; effect?: RuleEffect | null; status?: "active" | "suggested" },
  memberId: string,
  sourceMessageId?: string,
): Promise<Rule> {
  const status = input.status ?? "active";
  return db().transaction(async (tx) => {
    const [row] = await tx
      .insert(rules)
      .values({
        id: newId("rule"),
        orgId,
        text: input.text,
        kind: input.kind,
        effect: input.effect ?? null,
        status,
        memberId,
        sourceMessageId: sourceMessageId ?? null,
      })
      .returning();
    if (status === "active") await bumpVersion(orgId, "rules", tx);
    return row;
  });
}

/** Retires a rule. Throws `RULE_NOT_FOUND`. Already-retired rules are returned unchanged. */
export async function retireRule(orgId: string, ruleId: string, memberId: string): Promise<Rule> {
  return db().transaction(async (tx) => {
    const [current] = await tx.select().from(rules).where(and(eq(rules.orgId, orgId), eq(rules.id, ruleId)));
    if (!current) throw new Error("RULE_NOT_FOUND");
    if (current.status === "retired") return current;
    const [row] = await tx
      .update(rules)
      .set({ status: "retired", retiredAt: new Date(), version: sql`${rules.version} + 1` })
      .where(and(eq(rules.orgId, orgId), eq(rules.id, ruleId)))
      .returning();
    if (current.status === "active") await bumpVersion(orgId, "rules", tx);
    await recordEvent({ orgId, kind: "rule.retired", refId: ruleId, memberId }, tx);
    return row;
  });
}

/**
 * The owner accepts a crew member's suggested rule: it is saved again as theirs, active from now, and
 * the suggestion is retired (what the assistant does on "add the rule"). Throws `RULE_NOT_FOUND`, or
 * `RULE_NOT_SUGGESTED` for a rule that isn't waiting on the owner.
 */
export async function acceptRule(orgId: string, ruleId: string, memberId: string): Promise<Rule> {
  return db().transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(rules)
      .where(and(eq(rules.orgId, orgId), eq(rules.id, ruleId)))
      .for("update");
    if (!suggestion) throw new Error("RULE_NOT_FOUND");
    if (suggestion.status !== "suggested") throw new Error("RULE_NOT_SUGGESTED");
    const [accepted] = await tx
      .insert(rules)
      .values({
        id: newId("rule"),
        orgId,
        text: suggestion.text,
        kind: suggestion.kind,
        effect: suggestion.effect,
        status: "active",
        memberId,
        sourceMessageId: suggestion.sourceMessageId,
      })
      .returning();
    await tx
      .update(rules)
      .set({ status: "retired", retiredAt: new Date(), version: sql`${rules.version} + 1` })
      .where(and(eq(rules.orgId, orgId), eq(rules.id, ruleId)));
    await bumpVersion(orgId, "rules", tx);
    await recordEvent({ orgId, kind: "rule.accepted", refId: accepted.id, memberId, data: { suggestionId: ruleId } }, tx);
    return accepted;
  });
}

export async function versions(orgId: string): Promise<{ pricebookVersion: number; rulesVersion: number }> {
  const profile = await getProfileWith(orgId, db());
  return { pricebookVersion: profile.pricebookVersion, rulesVersion: profile.rulesVersion };
}
