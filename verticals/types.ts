import type { UnitKind } from "../schema/types";

// A trade pack: plain data applied to a business by `applyVerticalPack` (core/vertical-seed.ts), plus
// the instruction overlay the assistant gets each turn when `VERTICAL` names the pack.

export type PackItem = {
  name: string;
  unitKind: UnitKind;
  unitLabel: string;
  priceCents: number;
  group?: string;
  notes?: string;
  /** The noun phrase that finds the item in a photo ("mulch bed"); none for items a photo can't show. */
  photoPrompt?: string;
  /** What doing it needs, in the owner's words ("trailer", "chipper"); a crew booked for it must carry all of it. */
  equipment?: string[];
  /** Work rain or heat calls off (mowing, sod): its stops are checked against the forecast the evening before. */
  weatherSensitive?: boolean;
};

export type PackRule = {
  text: string;
  kind: "pricing_modifier" | "scope" | "exclusion" | "process";
  /** `appliesTo` lists item names; the seed resolves them to the saved items' ids. */
  effect?: { op: "add_fixed" | "add_per_unit" | "percent"; amount: number; appliesTo: "any" | string[] };
};

export type PackNote = { title: string; body: string; tags?: string[] };

/**
 * Business settings the pack starts a business with: days a quote stays open, deposit percent, days to a
 * follow-up, and whether customers see each line's price (unset, they do).
 */
export type PackProfile = { quoteValidityDays?: number; depositPercent?: number; followUpDays?: number; customerLinePrices?: boolean };

export type VerticalPack = {
  id: string;
  label: string;
  minimumChargeCents: number | null;
  items: PackItem[];
  rules: PackRule[];
  notes: PackNote[];
  profile?: PackProfile;
  instructions: string;
};
