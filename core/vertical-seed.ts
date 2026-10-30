import type { VerticalPack } from "../verticals/types";
import type { RuleEffect } from "./calculator";
import { businessNotes, saveNote } from "./notes";
import { listRules, nameKey, saveItems, saveRule } from "./pricebook";
import { updateProfile } from "./profile";

/**
 * Loads a trade pack into one business, as its owner: prices (upserted by name, with each item's photo
 * prompt, equipment, and weather flag), rules and business notes (skipped when one with the same text or
 * title is already saved), the minimum charge, and its profile settings (quote validity, deposit,
 * follow-up).
 * Safe to run again. Rule `appliesTo` names become the saved items' ids. Throws `PACK_ITEM_UNKNOWN`
 * for a rule naming an item the pack does not have.
 */
export async function applyVerticalPack(
  orgId: string,
  memberId: string,
  pack: VerticalPack,
): Promise<{ items: number; rulesAdded: number; notesAdded: number }> {
  const items = await saveItems(orgId, pack.items, memberId);
  const idByName = new Map(items.map((item) => [nameKey(item.name), item.id]));

  const savedRules = new Set(
    (await listRules(orgId, { includeRetired: true, includeSuggested: true })).map((rule) => rule.text.trim()),
  );
  let rulesAdded = 0;
  for (const rule of pack.rules) {
    if (savedRules.has(rule.text.trim())) continue;
    let effect: RuleEffect | null = null;
    if (rule.effect) {
      const { appliesTo } = rule.effect;
      effect = {
        ...rule.effect,
        appliesTo:
          appliesTo === "any"
            ? "any"
            : appliesTo.map((name) => {
                const id = idByName.get(nameKey(name));
                if (!id) throw new Error("PACK_ITEM_UNKNOWN");
                return id;
              }),
      };
    }
    await saveRule(orgId, { text: rule.text, kind: rule.kind, effect }, memberId);
    rulesAdded++;
  }

  const savedTitles = new Set((await businessNotes(orgId, 1000)).map((note) => note.title.trim()));
  let notesAdded = 0;
  for (const note of pack.notes) {
    if (savedTitles.has(note.title.trim())) continue;
    await saveNote({ orgId, memberId, role: "owner" }, { title: note.title, body: note.body, tags: note.tags ?? [] });
    notesAdded++;
  }

  const profile = { ...pack.profile, ...(pack.minimumChargeCents !== null ? { minimumChargeCents: pack.minimumChargeCents } : {}) };
  if (Object.keys(profile).length > 0) await updateProfile(orgId, profile, memberId);
  return { items: items.length, rulesAdded, notesAdded };
}
