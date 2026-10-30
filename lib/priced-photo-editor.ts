import type { Language } from "../core/language";

// Editing a priced photo by hand: which of the objects SAM found in the photo goes with which quote line,
// asking SAM to look again in one spot or for the one thing in a box, and outlining what it never finds.
// The routes are under /api/quotes/[id]/priced/[pricedId]; the pure helpers below keep the screen's
// regions in step with a change before the server answers.

import type { PricedBox, PricedCandidate, PricedPhotoEditorState, PricedRegion } from "../schema/types";

export type { PricedBox, PricedCandidate, PricedPhotoEditorState, PricedRegion };

export type Assignment = { candidateId: string; lineIndexes: number[] };

/**
 * One ask of SAM: a phrase, kept inside `box` when one is given; or, with no phrase, the one object `box`
 * and `points` name (a `negative` point is off it), in place of `replace`, what an earlier ask of the
 * box found.
 */
export type FindRequest = { phrase?: string; box?: PricedBox; points?: Array<Point & { negative?: boolean }>; lineIndex?: number; replace?: string };

/** The routes, as the editor calls them. A thin seam: the editor takes another implementation to try it without a server. */
export type PricedPhotoApi = {
  load: () => Promise<PricedPhotoEditorState>;
  save: (assignments: Assignment[]) => Promise<PricedPhotoEditorState>;
  find: (request: FindRequest) => Promise<PricedPhotoEditorState & { found: number; candidateIds: string[] }>;
  draw: (request: { points: Point[]; lineIndex?: number }) => Promise<PricedPhotoEditorState & { candidateId: string; added: boolean }>;
  removeDrawn: (candidateId: string) => Promise<PricedPhotoEditorState>;
};

export type Point = { x: number; y: number };

/** A route's refusal: its status and its short text. */
export class PricedPhotoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const base = (quoteId: string, pricedId: string) => `/api/quotes/${encodeURIComponent(quoteId)}/priced/${encodeURIComponent(pricedId)}`;

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new PricedPhotoError(response.status, (await response.text().catch(() => "")).trim() || response.statusText);
  return (await response.json()) as T;
}

export const fetchEditorState = (quoteId: string, pricedId: string) => call<PricedPhotoEditorState>(`${base(quoteId, pricedId)}/regions`, "GET");

/** Sends the whole set: a candidate left out is on no line. */
export const saveAssignments = (quoteId: string, pricedId: string, assignments: Assignment[]) =>
  call<PricedPhotoEditorState>(`${base(quoteId, pricedId)}/regions`, "PUT", { assignments });

/** One SAM call (`FindRequest`); what it finds goes on `lineIndex` when given. `candidateIds` is what it found, as the photo keeps it. */
export const findInPhoto = (quoteId: string, pricedId: string, request: FindRequest) =>
  call<PricedPhotoEditorState & { found: number; candidateIds: string[] }>(`${base(quoteId, pricedId)}/find`, "POST", request);

/** An outline drawn by hand, in the photo's pixels, onto `lineIndex` when given; no SAM call. */
export const drawInPhoto = (quoteId: string, pricedId: string, request: { points: Point[]; lineIndex?: number }) =>
  call<PricedPhotoEditorState & { candidateId: string; added: boolean }>(`${base(quoteId, pricedId)}/candidates`, "POST", request);

/** Takes an outline drawn by hand, on no line, off the photo. */
export const removeDrawn = (quoteId: string, pricedId: string, candidateId: string) =>
  call<PricedPhotoEditorState>(`${base(quoteId, pricedId)}/candidates/${encodeURIComponent(candidateId)}`, "DELETE");

export const pricedPhotoApi = (quoteId: string, pricedId: string): PricedPhotoApi => ({
  load: () => fetchEditorState(quoteId, pricedId),
  save: (assignments) => saveAssignments(quoteId, pricedId, assignments),
  find: (request) => findInPhoto(quoteId, pricedId, request),
  draw: (request) => drawInPhoto(quoteId, pricedId, request),
  removeDrawn: (candidateId) => removeDrawn(quoteId, pricedId, candidateId),
});

/** Where the quote page opens the editor on one of its priced photos: from the chat's quote card or the price guide. */
export const pricedPhotoEditHref = (quoteId: string, pricedId: string) =>
  `/quotes/${encodeURIComponent(quoteId)}?edit=${encodeURIComponent(pricedId)}#priced-photo`;

/** Which lines each candidate is on, in the order the candidates first appear; objects with no candidate are left out. */
export function assignmentsOf(regions: PricedRegion[]): Assignment[] {
  const lines = new Map<string, Set<number>>();
  for (const region of regions) {
    for (const object of region.objects) {
      if (object.candidateId === null) continue;
      const on = lines.get(object.candidateId) ?? new Set<number>();
      on.add(region.lineIndex);
      lines.set(object.candidateId, on);
    }
  }
  return [...lines].map(([candidateId, on]) => ({ candidateId, lineIndexes: [...on].sort((a, b) => a - b) }));
}

/** The regions with one candidate put on (or taken off) one line; an unknown candidate changes nothing. */
export function applyAssignment(regions: PricedRegion[], candidates: PricedCandidate[], candidateId: string, lineIndex: number, on: boolean): PricedRegion[] {
  const candidate = candidates.find((c) => c.id === candidateId);
  if (!candidate) return regions;
  return regions.map((region) => {
    if (region.lineIndex !== lineIndex) return region;
    const others = region.objects.filter((object) => object.candidateId !== candidateId);
    const objects = on ? [...others, { candidateId, box: candidate.box, areaPx: candidate.areaPx, confidence: candidate.confidence }] : others;
    return { ...region, objects, located: objects.length > 0 };
  });
}

/**
 * The outline being drawn, as an SVG path: through each point, then to where the pointer is (`at`), and
 * back to the first point once it's `closed`. Empty with no point yet.
 */
export function sketchPath(points: Point[], at: Point | null, closed: boolean): string {
  const through = closed || !at ? points : [...points, at];
  if (through.length === 0) return "";
  return `M${through.map(({ x, y }) => `${round(x)} ${round(y)}`).join("L")}${closed ? "Z" : ""}`;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Whether `at` lands within `reach` of the first point of an outline that has enough points to close. */
export function closesAt(points: Point[], at: Point, reach: number): boolean {
  if (points.length < 3) return false;
  return Math.hypot(at.x - points[0].x, at.y - points[0].y) <= reach;
}

/** "5 minutes ago", for who last edited the photo. */
export function editedAgo(iso: string, language: Language, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Infinity],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), "year");
}
