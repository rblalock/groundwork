import { landscaping } from "./landscaping";
import type { VerticalPack } from "./types";

export type { PackItem, PackNote, PackRule, VerticalPack } from "./types";

export const VERTICALS: Record<string, VerticalPack> = { landscaping };

/** The pack `VERTICAL` names, read on every call. Unset, empty, or `none` is no pack; an unknown name throws `UNKNOWN_VERTICAL`. */
export function activeVertical(): VerticalPack | null {
  const id = process.env.VERTICAL?.trim().toLowerCase() ?? "";
  if (!id || id === "none") return null;
  const pack = VERTICALS[id];
  if (!pack) throw new Error("UNKNOWN_VERTICAL");
  return pack;
}
