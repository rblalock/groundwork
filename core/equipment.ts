// Equipment: what a line of work needs (a price book item's `equipment`) and what a member's truck carries
// (`members.equipment`), both in the owner's words. A job needs everything its quote's items need; a crew can
// take it when what they carry between them covers all of it. Words match after `equipmentKey` folds them, so
// "Trailers" is "trailer". Nothing is inferred: work without a quote, or lines without items, needs nothing.

/** The most things one item or member lists, and the longest one. */
export const MAX_EQUIPMENT = 20;
export const MAX_EQUIPMENT_LENGTH = 60;

/** How two words for the same thing match: trimmed, lowercase, spaces collapsed, a trailing "s" dropped. */
export function equipmentKey(text: string): string {
  const key = text.trim().toLowerCase().replace(/\s+/g, " ");
  return key.length > 1 && key.endsWith("s") ? key.slice(0, -1) : key;
}

/** A list as saved: each in the owner's words, trimmed and with spaces collapsed, blanks and repeats left out. */
export function cleanEquipment(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const text = raw.trim().replace(/\s+/g, " ").slice(0, MAX_EQUIPMENT_LENGTH);
    const key = equipmentKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, MAX_EQUIPMENT);
}

/** "trailer, 60in mower" as typed on a page, as a list. */
export function equipmentList(text: string): string[] {
  return text.split(",").map((part) => part.trim()).filter(Boolean);
}

/** Everything the lists name, once each, in the words first used. */
export function equipmentUnion(lists: string[][]): string[] {
  return cleanEquipment(lists.flat());
}

/** What none of the crew carries out of `needs`, in the needs' words; empty when they carry it all. */
export function missingEquipment(needs: string[], carried: string[][]): string[] {
  const have = new Set(carried.flat().map(equipmentKey));
  return cleanEquipment(needs).filter((need) => !have.has(equipmentKey(need)));
}

/** True when the crew between them carry everything in `needs`. */
export function carriesAll(needs: string[], carried: string[][]): boolean {
  return missingEquipment(needs, carried).length === 0;
}
