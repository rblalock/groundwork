// Which of SAM's objects a priced photo keeps as candidates, which of those each quote line starts with,
// and how a member's edits move them between lines. Pure: no SAM call, no database.
import type { PricedBox, PricedCandidate, PricedRegion, UnitKind } from "../schema/types";
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

const sameBox = (a: PricedBox, b: PricedBox) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

/** `found` without any whose phrase and box match a candidate already kept. */
export function newCandidates(existing: PricedCandidate[], found: PricedCandidate[]): PricedCandidate[] {
  return found.filter((c) => !existing.some((e) => e.phrase === c.phrase && sameBox(e.box, c.box)));
}

/** Whether the middle of `box` lies inside `area` (`right` and `bottom` exclusive). */
export function centeredIn(area: PricedBox, box: PricedBox): boolean {
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  return x >= area.left && x < area.right && y >= area.top && y < area.bottom;
}

export type Assignment = { candidateId: string; lineIndexes: number[] };

/**
 * Every region's objects as a member assigned them: each candidate on each line it lists, and a
 * candidate not listed on no line. A region's objects run largest first. Throws `UNKNOWN_CANDIDATE` for a
 * candidate the photo doesn't have and `UNKNOWN_LINE` for a line it has no region for.
 */
export function applyAssignments(candidates: PricedCandidate[], regions: PricedRegion[], assignments: Assignment[]): PricedRegion[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const lines = new Map<number, PricedCandidate[]>(regions.map((r) => [r.lineIndex, []]));
  for (const { candidateId, lineIndexes } of assignments) {
    const candidate = byId.get(candidateId);
    if (!candidate) throw new Error(`UNKNOWN_CANDIDATE: ${candidateId}`);
    for (const lineIndex of lineIndexes) {
      const kept = lines.get(lineIndex);
      if (!kept) throw new Error(`UNKNOWN_LINE: ${lineIndex}`);
      if (!kept.includes(candidate)) kept.push(candidate);
    }
  }
  return regions.map((region) => {
    const objects = lines.get(region.lineIndex)!.sort((a, b) => b.areaPx - a.areaPx).map(regionObject);
    return { ...region, objects, located: objects.length > 0 };
  });
}

/** `regions` with `added` on the line at `lineIndex` too, largest first. Throws `UNKNOWN_LINE` for a line it has no region for. */
export function addToLine(regions: PricedRegion[], lineIndex: number, added: PricedCandidate[]): PricedRegion[] {
  if (!regions.some((r) => r.lineIndex === lineIndex)) throw new Error(`UNKNOWN_LINE: ${lineIndex}`);
  return regions.map((region) => {
    if (region.lineIndex !== lineIndex) return region;
    const objects = [...region.objects, ...added.map(regionObject)].sort((a, b) => b.areaPx - a.areaPx);
    return { ...region, objects, located: objects.length > 0 };
  });
}
