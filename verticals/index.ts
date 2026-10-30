import { irrigation } from "./irrigation";
import { landscaping } from "./landscaping";
import { pool } from "./pool";
import type { VerticalPack } from "./types";

export type { PackItem, PackNote, PackRule, VerticalPack } from "./types";

export const VERTICALS: Record<string, VerticalPack> = { landscaping, irrigation, pool };

const warned = new Set<string>();

/**
 * The pack `VERTICAL` names, read on every call. Unset, empty, or `none` is no pack; so is an unknown
 * name, which warns once so a typo never stops a turn (scripts/seed-vertical.ts refuses one).
 */
export function activeVertical(): VerticalPack | null {
  const id = process.env.VERTICAL?.trim().toLowerCase() ?? "";
  if (!id || id === "none") return null;
  const pack = VERTICALS[id];
  if (!pack && !warned.has(id)) {
    warned.add(id);
    console.warn(`verticals: no pack named "${id}"; running without one. Packs: ${Object.keys(VERTICALS).join(", ")}.`);
  }
  return pack ?? null;
}
