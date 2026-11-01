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
/** A piece of an outline enclosing less than this share of its largest piece is a speck of the mask, and dropped. */
export const SPECK_SHARE = 0.01;
/** Two candidates of different phrases whose boxes overlap this much (intersection over union) are one object. */
export const SAME_OBJECT_IOU = 0.9;

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

/** Two of one phrase's objects whose masks overlap this much (intersection over union) are one object, found twice. */
export const SAME_MASK_IOU = 0.6;
/** Two of one phrase's objects are one object, too, when this share of the smaller lies inside the larger: a hedge and one end of it. */
export const SAME_MASK_INSIDE = 0.8;

/**
 * One region per line, in line order, from the candidates found for each phrase. Objects too small
 * (for the image, or beside the largest one found) or too unsure are dropped, and one found twice
 * (`sameObject`) is kept once, the larger. Each object goes on one line at most: lines that share a
 * phrase share out its objects, the largest to the line with the largest quantity (in line order when
 * their units differ), the next to the next, and round again while lines have room and objects are left;
 * an `each` line has room for its quantity, any other line for two. A phrase's lines come in the order of
 * the first of them, and an object an earlier line has (or one with the same mask) isn't offered again.
 * A line with no phrase, or nothing left, is `located: false`.
 */
export function selectRegions(lines: PhotoLine[], results: Map<string, PricedCandidate[]>, image: { width: number; height: number }): PricedRegion[] {
  const minArea = image.width * image.height * MIN_BOX_SHARE;
  const objectsOf = new Map<number, PricedCandidate[]>(lines.map((line) => [line.index, []]));
  const claimed: PricedCandidate[] = [];
  const phrases = new Map<string, PhotoLine[]>();
  for (const line of lines) if (line.phrase !== null) phrases.set(line.phrase, [...(phrases.get(line.phrase) ?? []), line]);
  for (const [phrase, sharing] of phrases) {
    const found = results.get(phrase) ?? [];
    const largest = Math.max(0, ...found.map((o) => o.areaPx));
    const distinct: PricedCandidate[] = [];
    for (const o of [...found].sort((a, b) => b.areaPx - a.areaPx)) {
      if ((o.box.right - o.box.left) * (o.box.bottom - o.box.top) < minArea || o.areaPx < largest * MIN_SHARE_OF_LARGEST) continue;
      if (o.confidence !== null && o.confidence < MIN_CONFIDENCE) continue;
      if (distinct.some((kept) => sameObject(kept, o, true))) continue;
      if (claimed.some((taken) => taken === o || sameObject(taken, o, false))) continue;
      distinct.push(o);
    }
    const sameUnit = sharing.every((line) => line.unitKind === sharing[0].unitKind && line.unitLabel === sharing[0].unitLabel);
    const order = sameUnit ? [...sharing].sort((a, b) => b.quantity - a.quantity || a.index - b.index) : sharing;
    const room = (line: PhotoLine) => (line.unitKind === "each" ? Math.max(1, Math.ceil(line.quantity)) : KEEP_UNCOUNTED);
    let next = 0;
    while (next < distinct.length && order.some((line) => objectsOf.get(line.index)!.length < room(line))) {
      for (const line of order) {
        if (next < distinct.length && objectsOf.get(line.index)!.length < room(line)) objectsOf.get(line.index)!.push(distinct[next++]);
      }
    }
    claimed.push(...distinct.slice(0, next));
  }
  return lines.map((line) => {
    const objects = objectsOf.get(line.index)!.map(regionObject);
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

/**
 * Whether two candidates are one object: their masks overlap by `SAME_MASK_IOU` or more, or, for two of
 * one phrase (`samePhrase`), `SAME_MASK_INSIDE` of the smaller lies inside the larger. Of two phrases, one
 * inside the other is a thing on another (a shrub in a mulch bed), not the same one. Masks are read from
 * the outlines; without an outline, the boxes' overlap stands in, and only for intersection over union.
 */
export function sameObject(a: PricedCandidate, b: PricedCandidate, samePhrase: boolean): boolean {
  if (boxIou(a.box, b.box) === 0) return false;
  if (!a.svgPath || !b.svgPath) return boxIou(a.box, b.box) >= SAME_MASK_IOU;
  const inter = maskIntersection(a, b);
  const areaA = a.areaPx || polygonsArea(a);
  const areaB = b.areaPx || polygonsArea(b);
  const union = areaA + areaB - inter;
  if (union > 0 && inter / union >= SAME_MASK_IOU) return true;
  return samePhrase && Math.min(areaA, areaB) > 0 && inter / Math.min(areaA, areaB) >= SAME_MASK_INSIDE;
}

/** How many sample rows and columns across two boxes' overlap a mask intersection is counted at. */
const MASK_SAMPLES = 64;
const outlines = new WeakMap<PricedCandidate, Array<Array<[number, number]>>>();

/** A candidate's outline as closed polygons, from its absolute M and L points. */
function polygonsOf(candidate: PricedCandidate): Array<Array<[number, number]>> {
  let polygons = outlines.get(candidate);
  if (!polygons) {
    polygons = (candidate.svgPath.match(/M[^M]*/g) ?? [])
      .map((sub) => [...sub.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)].map(([, x, y]): [number, number] => [Number(x), Number(y)]))
      .filter((points) => points.length >= 3);
    outlines.set(candidate, polygons);
  }
  return polygons;
}

const polygonsArea = (candidate: PricedCandidate) => polygonsOf(candidate).reduce((sum, points) => sum + polygonArea(points), 0);

/** Where row `y` crosses a candidate's outline, left to right: a point is inside where an odd number lie left of it (even-odd, so holes stay out). */
function crossings(polygons: Array<Array<[number, number]>>, y: number): number[] {
  const xs: number[] = [];
  for (const points of polygons) {
    points.forEach(([x1, y1], i) => {
      const [x2, y2] = points[(i + 1) % points.length];
      if (y1 <= y !== y2 <= y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    });
  }
  return xs.sort((p, q) => p - q);
}

const inside = (xs: number[], x: number) => xs.filter((crossing) => crossing < x).length % 2 === 1;

/** About how many pixels two candidates' masks share, counted on a grid over their boxes' overlap. */
export function maskIntersection(a: PricedCandidate, b: PricedCandidate): number {
  const left = Math.max(a.box.left, b.box.left);
  const top = Math.max(a.box.top, b.box.top);
  const right = Math.min(a.box.right, b.box.right);
  const bottom = Math.min(a.box.bottom, b.box.bottom);
  if (right <= left || bottom <= top) return 0;
  const stepX = Math.max(1, (right - left) / MASK_SAMPLES);
  const stepY = Math.max(1, (bottom - top) / MASK_SAMPLES);
  const [pa, pb] = [polygonsOf(a), polygonsOf(b)];
  let hits = 0;
  for (let y = top + stepY / 2; y < bottom; y += stepY) {
    const [xa, xb] = [crossings(pa, y), crossings(pb, y)];
    for (let x = left + stepX / 2; x < right; x += stepX) if (inside(xa, x) && inside(xb, x)) hits++;
  }
  return hits * stepX * stepY;
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
  const pieces: Array<Array<[number, number]>> = [];
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
    pieces.push(points);
  }
  // A mask often has stray specks apart from the object (a few pixels of lawn across the yard); each
  // would draw as its own small outline. Holes are pieces too, and a hole that small is noise as well.
  const areas = pieces.map((points) => Math.abs(polygonArea(points)));
  const largest = Math.max(0, ...areas);
  return pieces
    .filter((_, i) => areas[i] > 0 && areas[i] >= largest * SPECK_SHARE)
    .map((points) => `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`)
    .join("");
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

/** Whether two boxes are the same box. */
export const sameBox = (a: PricedBox, b: PricedBox) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

/** The fewest and most points a hand-drawn outline takes. */
export const MIN_DRAWN_POINTS = 3;
export const MAX_DRAWN_POINTS = 200;
/** A hand-drawn outline enclosing less than this many pixels is a slip, not a thing. */
export const MIN_DRAWN_AREA = 100;
/** What a hand-drawn outline not put on a line is called. */
export const DRAWN_PHRASE = "drawn";
/** What an object a member boxed for SAM, not put on a line, is called. */
export const SELECTED_PHRASE = "selected";
/** The most points a member taps to tell SAM what a boxed object is not. */
export const MAX_PROMPT_POINTS = 3;

/**
 * A member's polygon as a candidate: its points rounded to whole pixels, with a point repeating the
 * one before it (or the first, closing it) dropped, as one closed path, with its bounds and the area it
 * encloses. No confidence: a drawn outline gives way to an object SAM found in the same place. Throws
 * `BAD_OUTLINE` for fewer than `MIN_DRAWN_POINTS` or more than `MAX_DRAWN_POINTS` points, a point off the
 * photo, or an area under `MIN_DRAWN_AREA`.
 */
export function drawnCandidate(points: Array<{ x: number; y: number }>, image: { width: number; height: number }, id: string, phrase: string): PricedCandidate {
  if (points.length > MAX_DRAWN_POINTS) throw new Error("BAD_OUTLINE: too many points");
  if (points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > image.width || y > image.height)) {
    throw new Error("BAD_OUTLINE: off the photo");
  }
  const kept: Array<[number, number]> = [];
  for (const { x, y } of points) {
    const point: [number, number] = [Math.round(x), Math.round(y)];
    const last = kept.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) kept.push(point);
  }
  if (kept.length > 1 && kept[0][0] === kept.at(-1)![0] && kept[0][1] === kept.at(-1)![1]) kept.pop();
  if (kept.length < MIN_DRAWN_POINTS) throw new Error("BAD_OUTLINE: too few points");
  const areaPx = polygonArea(kept);
  if (areaPx < MIN_DRAWN_AREA) throw new Error("BAD_OUTLINE: too small");
  const xs = kept.map(([x]) => x);
  const ys = kept.map(([, y]) => y);
  return {
    id,
    phrase,
    box: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) },
    areaPx,
    confidence: null,
    svgPath: `M${kept.map(([x, y]) => `${x} ${y}`).join("L")}Z`,
    source: "hand",
  };
}

/** The area a polygon encloses, in whole pixels (the shoelace formula; a crossing outline's lobes offset). */
export function polygonArea(points: Array<[number, number]>): number {
  let twice = 0;
  points.forEach(([x, y], i) => {
    const [nextX, nextY] = points[(i + 1) % points.length];
    twice += x * nextY - nextX * y;
  });
  return Math.round(Math.abs(twice) / 2);
}

/** `found` without any whose phrase and box match a candidate already kept. */
export function newCandidates(existing: PricedCandidate[], found: PricedCandidate[]): PricedCandidate[] {
  return found.filter((c) => !existing.some((e) => e.phrase === c.phrase && sameBox(e.box, c.box)));
}

/** How much two boxes overlap: their intersection's area over their union's, 0 to 1. */
export function boxIou(a: PricedBox, b: PricedBox): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = width * height;
  const union = (a.right - a.left) * (a.bottom - a.top) + (b.right - b.left) * (b.bottom - b.top) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * One candidate per object, where two phrases found the same one (a hedge that's also a shrub): a
 * candidate whose box overlaps one already kept of another phrase by `SAME_OBJECT_IOU` or more is
 * dropped, or takes that one's place when SAM was surer of it (no confidence counts as least sure; a
 * tie keeps the earlier). `same` maps each dropped candidate's id to the one kept for its object.
 */
export function distinctCandidates(candidates: PricedCandidate[]): { kept: PricedCandidate[]; same: Map<string, PricedCandidate> } {
  const kept: PricedCandidate[] = [];
  const replacedBy = new Map<string, PricedCandidate>();
  const sureness = (c: PricedCandidate) => c.confidence ?? -1;
  for (const candidate of candidates) {
    const at = kept.findIndex((k) => k.phrase !== candidate.phrase && boxIou(k.box, candidate.box) >= SAME_OBJECT_IOU);
    if (at === -1) {
      kept.push(candidate);
    } else if (sureness(candidate) > sureness(kept[at])) {
      replacedBy.set(kept[at].id, candidate);
      kept[at] = candidate;
    } else {
      replacedBy.set(candidate.id, kept[at]);
    }
  }
  // A candidate dropped for one that was later replaced itself follows it to the one kept.
  const same = new Map<string, PricedCandidate>();
  for (const id of replacedBy.keys()) {
    let survivor = replacedBy.get(id)!;
    while (replacedBy.has(survivor.id)) survivor = replacedBy.get(survivor.id)!;
    same.set(id, survivor);
  }
  return { kept, same };
}

/** `regions` with each object of a dropped candidate (a key of `same`) on the candidate kept in its place, once per line. */
export function withKept(regions: PricedRegion[], same: Map<string, PricedCandidate>): PricedRegion[] {
  if (same.size === 0) return regions;
  return regions.map((region) => {
    const objects: PricedRegion["objects"] = [];
    for (const object of region.objects) {
      const survivor = object.candidateId === null ? undefined : same.get(object.candidateId);
      const next = survivor ? regionObject(survivor) : object;
      if (next.candidateId === null || !objects.some((o) => o.candidateId === next.candidateId)) objects.push(next);
    }
    objects.sort((a, b) => b.areaPx - a.areaPx);
    return { ...region, objects, located: objects.length > 0 };
  });
}

/** Whether the middle of `box` lies inside `area` (`right` and `bottom` exclusive). */
export function centeredIn(area: PricedBox, box: PricedBox): boolean {
  const x = (box.left + box.right) / 2;
  const y = (box.top + box.bottom) / 2;
  return x >= area.left && x < area.right && y >= area.top && y < area.bottom;
}

export type Assignment = { candidateId: string; lineIndexes: number[] };

/**
 * Every region's objects as a member assigned them: each candidate on the line it lists, and a candidate
 * not listed on no line. An object is on one line at most: a candidate listed on several (or listed twice)
 * goes on the first line listed for it only. A region's objects run largest first. Throws
 * `UNKNOWN_CANDIDATE` for a candidate the photo doesn't have and `UNKNOWN_LINE` for a line it has no
 * region for.
 */
export function applyAssignments(candidates: PricedCandidate[], regions: PricedRegion[], assignments: Assignment[]): PricedRegion[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const lines = new Map<number, PricedCandidate[]>(regions.map((r) => [r.lineIndex, []]));
  const placed = new Set<string>();
  for (const { candidateId, lineIndexes } of assignments) {
    const candidate = byId.get(candidateId);
    if (!candidate) throw new Error(`UNKNOWN_CANDIDATE: ${candidateId}`);
    for (const lineIndex of lineIndexes) {
      const kept = lines.get(lineIndex);
      if (!kept) throw new Error(`UNKNOWN_LINE: ${lineIndex}`);
      if (placed.has(candidateId)) continue;
      kept.push(candidate);
      placed.add(candidateId);
    }
  }
  return regions.map((region) => {
    const objects = lines.get(region.lineIndex)!.sort((a, b) => b.areaPx - a.areaPx).map(regionObject);
    return { ...region, objects, located: objects.length > 0 };
  });
}

/** `regions` with the candidate off every line (but the line at `except`, when given). */
export function offLines(regions: PricedRegion[], candidateId: string, except?: number): PricedRegion[] {
  return regions.map((region) => {
    if (region.lineIndex === except || !region.objects.some((o) => o.candidateId === candidateId)) return region;
    const objects = region.objects.filter((o) => o.candidateId !== candidateId);
    return { ...region, objects, located: objects.length > 0 };
  });
}

/**
 * `regions` with `added` on the line at `lineIndex` (once), largest first, and off any other line it was
 * on: an object is on one line at most. Throws `UNKNOWN_LINE` for a line it has no region for.
 */
export function addToLine(regions: PricedRegion[], lineIndex: number, added: PricedCandidate[]): PricedRegion[] {
  if (!regions.some((r) => r.lineIndex === lineIndex)) throw new Error(`UNKNOWN_LINE: ${lineIndex}`);
  const elsewhere = added.reduce((moved, candidate) => offLines(moved, candidate.id, lineIndex), regions);
  return elsewhere.map((region) => {
    if (region.lineIndex !== lineIndex) return region;
    const more = added.filter((c) => !region.objects.some((o) => o.candidateId === c.id)).map(regionObject);
    const objects = [...region.objects, ...more].sort((a, b) => b.areaPx - a.areaPx);
    return { ...region, objects, located: objects.length > 0 };
  });
}
