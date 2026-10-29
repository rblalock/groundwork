import type { Language } from "../core/language";

// Editing a priced photo by hand: which of the objects SAM found in the photo goes with which quote line,
// and asking SAM to look again in one spot. The routes are under /api/quotes/[id]/priced/[pricedId]; the
// pure helpers below keep the screen's regions in step with a change before the server answers.

// TODO(merge): these mirror the backend contract; point them at schema/types.ts once it lands there.
export type PricedBox = { left: number; top: number; right: number; bottom: number };

/** Something SAM found in the photo, on a line or not. `svgPath` is in the photo's pixels. */
export type PricedCandidate = { id: string; phrase: string; box: PricedBox; areaPx: number; confidence: number | null; svgPath: string };

/** One quote line on the photo, and the objects outlined for it. */
export type PricedRegion = {
  lineIndex: number;
  itemId: string | null;
  name: string;
  quantity: number;
  unitLabel: string;
  totalCents: number | null;
  phrase: string | null;
  objects: Array<{ candidateId: string | null; box: PricedBox; areaPx: number; confidence: number | null }>;
  located: boolean;
};

export type PricedPhotoEditorState = {
  pricedPhotoId: string;
  /** The photo's pixel size; svgPaths and boxes are in these units. */
  width: number;
  height: number;
  /** The original photo. */
  photoUrl: string;
  /** The priced PNG, cache-busted. */
  renderedUrl: string;
  candidates: PricedCandidate[];
  /** One per quote line, in line order. */
  regions: PricedRegion[];
  lines: Array<{ lineIndex: number; name: string; quantity: number; unitLabel: string; totalCents: number | null; phrase: string | null }>;
  editedAt: string | null;
  editedBy: string | null;
};

export type Assignment = { candidateId: string; lineIndexes: number[] };

/** The routes, as the editor calls them. A thin seam: the editor takes another implementation to try it without a server. */
export type PricedPhotoApi = {
  load: () => Promise<PricedPhotoEditorState>;
  save: (assignments: Assignment[]) => Promise<PricedPhotoEditorState>;
  find: (request: { phrase: string; box?: PricedBox; lineIndex?: number }) => Promise<PricedPhotoEditorState & { found: number }>;
};

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

/** One SAM call for `phrase`, inside `box` when given; what it finds goes on `lineIndex` when given. */
export const findInPhoto = (quoteId: string, pricedId: string, request: { phrase: string; box?: PricedBox; lineIndex?: number }) =>
  call<PricedPhotoEditorState & { found: number }>(`${base(quoteId, pricedId)}/find`, "POST", request);

export const pricedPhotoApi = (quoteId: string, pricedId: string): PricedPhotoApi => ({
  load: () => fetchEditorState(quoteId, pricedId),
  save: (assignments) => saveAssignments(quoteId, pricedId, assignments),
  find: (request) => findInPhoto(quoteId, pricedId, request),
});

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
