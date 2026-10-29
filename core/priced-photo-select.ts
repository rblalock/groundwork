// Which of SAM's objects a priced photo keeps as candidates, and which of those each quote line starts
// with. Pure: no SAM call, no database.
import type { PricedCandidate, PricedRegion, UnitKind } from "../schema/types";
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
/** How many of one phrase's objects are kept as candidates, largest first. */
export const MAX_CANDIDATES_PER_PHRASE = 12;
/** A candidate whose outline is longer than this is dropped rather than stored. */
export const MAX_PATH_CHARS = 60_000;

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
 * One region per line, in line order, from the candidates found for each phrase. Objects too small
 * (for the image, or beside the largest one found) or too unsure are dropped; of the rest, an `each`
 * line keeps up to its quantity of the largest and any other line the largest two. Two lines with the
 * same phrase keep from the same objects. A line with no phrase, or nothing left, is `located: false`.
 */
export function selectRegions(lines: PhotoLine[], results: Map<string, PricedCandidate[]>, image: { width: number; height: number }): PricedRegion[] {
  const minArea = image.width * image.height * MIN_BOX_SHARE;
  return lines.map((line) => {
    const found = line.phrase === null ? [] : (results.get(line.phrase) ?? []);
    const keep = line.unitKind === "each" ? Math.max(1, Math.ceil(line.quantity)) : KEEP_UNCOUNTED;
    const largest = Math.max(0, ...found.map((o) => o.areaPx));
    const objects = found
      .filter((o) => (o.box.right - o.box.left) * (o.box.bottom - o.box.top) >= minArea && o.areaPx >= largest * MIN_SHARE_OF_LARGEST)
      .filter((o) => o.confidence === null || o.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.areaPx - a.areaPx)
      .slice(0, keep)
      .map(regionObject);
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

const regionObject = (candidate: PricedCandidate): PricedRegion["objects"][number] => ({
  candidateId: candidate.id,
  box: { ...candidate.box },
  areaPx: candidate.areaPx,
  confidence: candidate.confidence,
});

/**
 * An outline with whole-pixel points: SAM's run along pixel edges at half pixels, so rounding leaves
 * repeated points and straight runs of many points, which are dropped. Absolute M, L and Z only, as
 * the mask decoder writes them.
 */
export function compactPath(d: string): string {
  const out: string[] = [];
  for (const sub of d.match(/M[^M]*/g) ?? []) {
    const points: Array<[number, number]> = [];
    for (const [, x, y] of sub.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)) {
      const point: [number, number] = [Math.round(Number(x)), Math.round(Number(y))];
      const last = points.at(-1);
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      const before = points.at(-2);
      // The last point is dropped when it sits on the line from the one before it to this one.
      if (last && before && (last[0] - before[0]) * (point[1] - last[1]) === (last[1] - before[1]) * (point[0] - last[0])) points.pop();
      points.push(point);
    }
    if (points.length < 3) continue;
    out.push(`M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`);
  }
  return out.join("");
}

/**
 * The candidates one phrase's objects make: the largest `MAX_CANDIDATES_PER_PHRASE`, each with its
 * outline compacted. One whose outline is still over `MAX_PATH_CHARS` is dropped with a warning.
 */
export function candidatesFrom(phrase: string, objects: SamObject[], newId: () => string): PricedCandidate[] {
  return [...objects]
    .sort((a, b) => b.areaPx - a.areaPx)
    .slice(0, MAX_CANDIDATES_PER_PHRASE)
    .flatMap((o) => {
      const svgPath = compactPath(o.svgPath);
      if (svgPath.length > MAX_PATH_CHARS) {
        console.warn("priced photo: an outline too long to keep was dropped", { phrase, chars: svgPath.length });
        return [];
      }
      return [{ id: newId(), phrase, box: { ...o.box }, areaPx: o.areaPx, confidence: o.confidence, svgPath }];
    });
}
