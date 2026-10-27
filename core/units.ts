import type { Language } from "./language";

// A price book's unit is written singular ("cubic yard", "linear foot"); a line shows it beside its
// quantity, so anything but exactly 1 reads plural: "3 cubic yards", "40 linear feet". Only the last
// word changes. Simple rules, not a dictionary: a label they miss still reads as the member wrote it.

/** Words, and short forms, that read the same in the plural. */
const INVARIANT = new Set(["each", "ft", "in"]);

function pluralWord(word: string, language: Language): string {
  const lower = word.toLowerCase();
  const shout = word.length > 1 && word === word.toUpperCase() && word !== lower;
  const suffix = (text: string) => (shout ? text.toUpperCase() : text);
  if (language === "es") return lower.endsWith("s") ? word : word + suffix("s");
  if (INVARIANT.has(lower)) return word;
  if (lower === "foot") return word.slice(0, 1) + suffix("eet");
  if (/[^aeiou]y$/.test(lower)) return word.slice(0, -1) + suffix("ies");
  if (/(s|x|z|ch|sh)$/.test(lower)) return word + suffix("es");
  return word + suffix("s");
}

/** The unit as it reads after `quantity`: singular for 1 (as shown, to two places), plural otherwise. */
export function pluralUnit(quantity: number, unitLabel: string, language: Language): string {
  const label = unitLabel.trim();
  if (!label || Number(quantity.toFixed(2)) === 1) return label;
  const match = label.match(/^(.*?)([\p{L}]+)$/u);
  return match ? match[1] + pluralWord(match[2], language) : label;
}
