// Which of SAM's objects a priced photo keeps for each quote line. Pure: no SAM call, no database.
import type { PricedRegion, UnitKind } from "../schema/types";
import type { SamObject } from "./sam";

/** An object whose box is under this share of the image is dropped: usually something in the next yard. */
export const MIN_BOX_SHARE = 0.005;
/** An object SAM is less sure of than this is dropped. An object with no confidence is kept. */
export const MIN_CONFIDENCE = 0.6;
/**
 * An object whose mask is under this share of the phrase's largest is dropped: a strip of the
 * neighbor's lawn beside the customer's, a palm two houses down.
 */
export const MIN_SHARE_OF_LARGEST = 0.1;
/** How many objects a line that isn't counted by the piece keeps. */
const KEEP_UNCOUNTED = 2;

export type PhotoLine = {
  index: number;
  itemId: string | null;
  name: string;
  quantity: number;
  unitKind: UnitKind | null;
  unitLabel: string;
  totalCents: number | null;
  /** The noun phrase the line is looked for by; null for a line a photo can't show. */
  phrase: string | null;
};

/**
 * One region per line, in line order. Objects too small (for the image, or beside the largest one
 * found) or too unsure are dropped; of the rest, an `each` line keeps up to its quantity of the
 * largest and any other line the largest two. Two lines with the same phrase keep from the same
 * objects. A line with no phrase, or nothing left, is `located: false`.
 */
export function selectRegions(lines: PhotoLine[], results: Map<string, SamObject[]>, image: { width: number; height: number }): PricedRegion[] {
  const minArea = image.width * image.height * MIN_BOX_SHARE;
  return lines.map((line) => {
    const found = line.phrase === null ? [] : (results.get(line.phrase) ?? []);
    const keep = line.unitKind === "each" ? Math.max(1, Math.ceil(line.quantity)) : KEEP_UNCOUNTED;
    const largest = Math.max(0, ...found.map((o) => o.areaPx));
    const objects = found
      .filter((o) => o.width * o.height >= minArea && o.areaPx >= largest * MIN_SHARE_OF_LARGEST)
      .filter((o) => o.confidence === null || o.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.areaPx - a.areaPx)
      .slice(0, keep)
      .map((o) => ({ box: { ...o.box }, areaPx: o.areaPx, confidence: o.confidence }));
    return {
      lineIndex: line.index,
      itemId: line.itemId,
      name: line.name,
      quantity: line.quantity,
      unitLabel: line.unitLabel,
      totalCents: line.totalCents,
      phrase: line.phrase,
      objects,
      located: objects.length > 0,
    };
  });
}
