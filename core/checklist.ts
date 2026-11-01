// The work's checklist: one item per line of its quote, for the crew to tick off as they go. Made from
// the quote's current revision when the work's first visit is booked, or when someone reads it and it has
// none yet. Each item's text is built here from the line's name, quantity, and unit, in the reader's
// language: never the model's words, and never a price. An item is outlined when any of the quote's
// priced photos found that line: "outlined in the photo" with one, "outlined in photo 2" or "outlined in
// photos 1 and 3" with several, numbered in attachment order as the crew get them. Anyone on the team
// ticks an item or unticks it; the tick that
// finishes the list marks the work's open visit done, once its day has come, as "done at Oak St" would.
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { checklistItems, members, serviceJobs } from "../schema/schema";
import type { LineResult, PricedRegion } from "../schema/types";
import { storeInboundAttachment } from "./blob";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import type { Language } from "./language";
import { crewCopy, numberList, photoPlaces, quotePricedPhotos, type PhotoPlace, type PricedPhoto } from "./priced-photo";
import { getProfile } from "./profile";
import { getQuote, type Poster } from "./quotes";
import { changeVisitStatus, getServiceJob, type Actor, type VisitView } from "./scheduling";
import { dayText, timeText, wallClock } from "./scheduling-time";
import { pluralUnit } from "./units";

export type ChecklistItemView = {
  itemId: string;
  lineIndex: number;
  name: string;
  quantity: number;
  unitLabel: string;
  located: boolean;
  doneAt: Date | null;
  doneByName: string | null;
};

/** What a new item is made from: a quote line, and whether a priced photo outlines it. */
export type ItemSeed = Pick<ChecklistItemView, "lineIndex" | "name" | "quantity" | "unitLabel" | "located">;

/** How many priced photos the quote has, and the numbers of those that outline each line, by line index. */
export type Outlines = { count: number; byLine: Map<number, number[]> };

const OUTLINED: Record<Language, { one: string; some: string; numbered: (numbers: number[]) => string }> = {
  en: {
    one: "outlined in the photo",
    some: "outlined in the photos",
    numbered: (numbers) => `outlined in ${numbers.length > 1 ? "photos" : "photo"} ${numberList(numbers, "en")}`,
  },
  es: {
    one: "marcada en la foto",
    some: "marcada en las fotos",
    numbered: (numbers) => `marcada en ${numbers.length > 1 ? "las fotos" : "la foto"} ${numberList(numbers, "es")}`,
  },
};
const DONE_MARK = "✓";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const quantityText = (quantity: number) => String(Number(quantity.toFixed(2)));

/** One item per quote line, in line order; located when any priced photo's region for that line is (`regions` from all of them). */
export function itemsFromLines(
  lines: Array<Pick<LineResult, "name" | "quantity" | "unitLabel">>,
  regions: Array<Pick<PricedRegion, "lineIndex" | "located">>,
): ItemSeed[] {
  return lines.map((line, lineIndex) => ({
    lineIndex,
    name: line.name,
    quantity: line.quantity,
    unitLabel: line.unitLabel,
    located: regions.some((region) => region.lineIndex === lineIndex && region.located),
  }));
}

/** The quote's priced photos as the list points to them. Pure. */
export function outlinesOf(photos: Array<Pick<PricedPhoto, "regions">>): Outlines {
  return { count: photos.length, byLine: photoPlaces(photos)[0]?.locatedIn ?? new Map() };
}

type TextItem = Pick<ItemSeed, "name" | "quantity" | "unitLabel" | "located"> & { lineIndex?: number };

/**
 * "Mulch installed, 3 cubic yards (outlined in the photo)", or "(outlined in photos 1 and 3)" when the
 * quote has several priced photos (`outlines`); "(outlined in the photos)" when none of them shows it now.
 */
export function itemText(item: TextItem, language: Language, outlines?: Outlines): string {
  const unit = pluralUnit(item.quantity, oneLine(item.unitLabel), language);
  return `${oneLine(item.name)}, ${quantityText(item.quantity)}${unit ? ` ${unit}` : ""}${item.located ? ` (${outlinedText(item.lineIndex, language, outlines)})` : ""}`;
}

function outlinedText(lineIndex: number | undefined, language: Language, outlines: Outlines | undefined): string {
  const copy = OUTLINED[language];
  if (!outlines || outlines.count <= 1) return copy.one;
  const numbers = lineIndex === undefined ? [] : (outlines.byLine.get(lineIndex) ?? []);
  return numbers.length ? copy.numbered(numbers) : copy.some;
}

/**
 * Whether items say "outlined in the photo": only when some are and some aren't, so the mark tells
 * them apart. A list with every item outlined, or none, says nothing on each line.
 */
export function markOutlined(items: Array<Pick<ChecklistItemView, "located">>): boolean {
  return items.some((item) => item.located) && items.some((item) => !item.located);
}

/** The list as lines to send, numbered, each done item marked: "1. Mulch installed, 3 cubic yards ✓". */
export function checklistText(items: Array<TextItem & Pick<ChecklistItemView, "doneAt">>, language: Language, outlines?: Outlines): string {
  const mark = markOutlined(items);
  return items.map((item, index) => `${index + 1}. ${itemText({ ...item, located: item.located && mark }, language, outlines)}${item.doneAt ? ` ${DONE_MARK}` : ""}`).join("\n");
}

export function checklistCounts(items: Array<Pick<ChecklistItemView, "doneAt">>): { done: number; total: number } {
  return { done: items.filter((item) => item.doneAt).length, total: items.length };
}

/** The list as tools return it: each item's text and whether, by whom, and when it was ticked; `text` is ready to send. */
export function checklistForTool(items: ChecklistItemView[], timeZone: string, language: Language, outlines?: Outlines) {
  const { done, total } = checklistCounts(items);
  const mark = markOutlined(items);
  return {
    items: items.map((item, index) => ({
      itemId: item.itemId,
      number: index + 1,
      text: itemText({ ...item, located: item.located && mark }, language, outlines),
      done: Boolean(item.doneAt),
      ...(item.doneAt ? { doneBy: item.doneByName, doneAt: `${dayText(wallClock(item.doneAt, timeZone).date, language)}, ${timeText(item.doneAt, timeZone, language)}` } : {}),
    })),
    done,
    total,
    allDone: done === total,
    text: checklistText(items, language, outlines),
  };
}

/**
 * The visit a finished list marks done: the work's latest open visit whose local day is today or
 * earlier. Never one still ahead on a later day. Null when there is none.
 */
export function visitToComplete(visits: Array<Pick<VisitView, "visitId" | "status" | "startAt">>, now: Date, timeZone: string): string | null {
  const today = wallClock(now, timeZone).date;
  const due = visits
    .filter((v) => (v.status === "scheduled" || v.status === "proposed") && wallClock(v.startAt, timeZone).date <= today)
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  return due[0]?.visitId ?? null;
}

/** The work's items in line order, with who ticked each. */
export async function checklistFor(orgId: string, jobId: string, executor: Db | Tx = db()): Promise<ChecklistItemView[]> {
  const rows = await executor
    .select({ item: checklistItems, doneByName: members.name })
    .from(checklistItems)
    .leftJoin(members, and(eq(members.orgId, orgId), eq(members.id, checklistItems.doneByMemberId)))
    .where(and(eq(checklistItems.orgId, orgId), eq(checklistItems.jobId, jobId)))
    .orderBy(asc(checklistItems.lineIndex));
  return rows.map(({ item, doneByName }) => ({
    itemId: item.id,
    lineIndex: item.lineIndex,
    name: item.name,
    quantity: item.quantity,
    unitLabel: item.unitLabel,
    located: item.located,
    doneAt: item.doneAt,
    doneByName: item.doneAt ? doneByName : null,
  }));
}

/** The priced photos the list's outlined items are on: those of the quote's own photos, in attachment order. */
export function checklistPhotos(orgId: string, quoteId: string): Promise<Array<PricedPhoto & { place: PhotoPlace }>> {
  return quotePricedPhotos(orgId, quoteId);
}

/** The work's quote's priced photos as its list points to them; none for work without a quote. */
export async function checklistOutlines(orgId: string, jobId: string): Promise<Outlines> {
  const [job] = await db()
    .select({ quoteId: serviceJobs.quoteId })
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, jobId)));
  return outlinesOf(job?.quoteId ? await checklistPhotos(orgId, job.quoteId) : []);
}

/**
 * The work's list, made from its quote's current revision when it has none yet. Nothing is made for work
 * without a quote, or with an empty one: the list comes back empty. Making it twice makes it once.
 */
export async function ensureChecklist(orgId: string, jobId: string): Promise<ChecklistItemView[]> {
  const existing = await checklistFor(orgId, jobId);
  if (existing.length) return existing;
  const [job] = await db()
    .select({ quoteId: serviceJobs.quoteId })
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, jobId)));
  if (!job?.quoteId) return [];
  const quote = await getQuote(orgId, job.quoteId);
  if (!quote?.lines.length) return [];
  const photos = await checklistPhotos(orgId, quote.quoteId);
  const seeds = itemsFromLines(quote.lines, photos.flatMap((photo) => photo.regions));
  await db()
    .insert(checklistItems)
    .values(seeds.map((seed) => ({ id: newId("chk"), orgId, jobId, ...seed })))
    .onConflictDoNothing();
  return checklistFor(orgId, jobId);
}

export type CrewPhoto = { file: { filename: string; mimeType: string; data: Buffer }; fileUrl: string };

/** What booked crew get after the booking line: the list, and the priced photos it points to. */
export type CrewChecklist = {
  lines: (language: Language) => string;
  /**
   * The crew copies of the quote's priced photos in that language (quantities, no prices), in attachment
   * order, drawn and stored once per language. A photo that can't be drawn or stored is left out.
   */
  photos: (language: Language) => Promise<CrewPhoto[]>;
};

/** The work's list for a crew text, made first if need be; null for work without a quote or an empty one. */
export async function crewChecklist(orgId: string, jobId: string): Promise<CrewChecklist | null> {
  const items = await ensureChecklist(orgId, jobId);
  if (!items.length) return null;
  const [job] = await db()
    .select({ quoteId: serviceJobs.quoteId })
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, jobId)));
  const priced = job?.quoteId ? await checklistPhotos(orgId, job.quoteId) : [];
  const outlines = outlinesOf(priced);
  const drawn = new Map<Language, Promise<CrewPhoto[]>>();
  const drawOne = async (photo: (typeof priced)[number], language: Language): Promise<CrewPhoto | null> => {
    const png = await crewCopy(photo, language, photo.place);
    if (!png) return null;
    const filename = priced.length > 1 ? `priced-photo-${photo.place.number}.png` : "priced-photo.png";
    const fileUrl = await storeInboundAttachment(filename, "image/png", png);
    return { file: { filename, mimeType: "image/png", data: Buffer.from(png) }, fileUrl };
  };
  const draw = async (language: Language): Promise<CrewPhoto[]> => {
    const out: CrewPhoto[] = [];
    for (const photo of priced) {
      // A photo that can't be drawn or stored leaves the rest, and the text, to go on.
      const one = await drawOne(photo, language).catch((error: unknown) => {
        console.error("checklist: a priced photo was left off the crew text", { pricedId: photo.id, error });
        return null;
      });
      if (one) out.push(one);
    }
    return out;
  };
  return {
    lines: (language) => checklistText(items, language, outlines),
    photos: (language) => {
      if (!drawn.has(language)) drawn.set(language, draw(language));
      return drawn.get(language)!;
    },
  };
}

export type TickResult = {
  items: ChecklistItemView[];
  allDone: boolean;
  /** The visit this tick marked done, when it finished the list. */
  visitCompleted: VisitView | null;
  openVisitsOnJob: number | null;
};

/**
 * Ticks items done by the actor (or, with `undo`, unticks them), anyone on the team. An item already
 * ticked keeps who ticked it first. When this tick finishes the list, the work's open visit from today or
 * earlier is marked done through `changeVisitStatus`, as a member saying "done" would. A list that was
 * already finished, or an untick, completes nothing. Throws `SERVICE_JOB_NOT_FOUND`, `NO_CHECKLIST`, or
 * `CHECKLIST_ITEM_NOT_FOUND`.
 */
export async function tickChecklist(
  actor: Actor,
  input: { jobId: string; itemIds: string[]; undo?: boolean },
  deps?: { now?: Date; post?: Poster },
): Promise<TickResult> {
  const { orgId } = actor;
  const now = deps?.now ?? new Date();
  const job = await getServiceJob(actor, input.jobId);
  if (!job) throw new Error("SERVICE_JOB_NOT_FOUND");
  if (!(await ensureChecklist(orgId, job.id)).length) throw new Error("NO_CHECKLIST");
  const ids = [...new Set(input.itemIds)];
  if (ids.length === 0) throw new Error("CHECKLIST_ITEM_NOT_FOUND");
  const finished = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checklist:${orgId}:${job.id}`}))`);
    const before = await checklistFor(orgId, job.id, tx);
    const missing = ids.filter((id) => !before.some((item) => item.itemId === id));
    if (missing.length) throw new Error(`CHECKLIST_ITEM_NOT_FOUND: ${missing.join(", ")}`);
    const mine = and(eq(checklistItems.orgId, orgId), eq(checklistItems.jobId, job.id), inArray(checklistItems.id, ids));
    if (input.undo) {
      await tx.update(checklistItems).set({ doneAt: null, doneByMemberId: null }).where(and(mine, isNotNull(checklistItems.doneAt)));
    } else {
      await tx.update(checklistItems).set({ doneAt: now, doneByMemberId: actor.memberId }).where(and(mine, isNull(checklistItems.doneAt)));
    }
    await recordEvent(
      { orgId, kind: input.undo ? "checklist.unticked" : "checklist.ticked", refId: job.id, memberId: actor.memberId, data: { itemIds: ids } },
      tx,
    );
    const after = await checklistFor(orgId, job.id, tx);
    const wasDone = before.every((item) => item.doneAt);
    const isDone = after.every((item) => item.doneAt);
    return !input.undo && !wasDone && isDone;
  });
  let visitCompleted: VisitView | null = null;
  let openVisitsOnJob: number | null = null;
  if (finished) {
    const { timeZone } = await getProfile(orgId);
    const visitId = visitToComplete(job.visits, now, timeZone);
    if (visitId) {
      // Another member may have marked it done a moment ago; the list is still finished.
      const changed = await changeVisitStatus(actor, { visitId, status: "completed" }, deps).catch((error: unknown) => {
        console.error("checklist: the finished list's visit was not marked done", { jobId: job.id, visitId, error });
        return null;
      });
      visitCompleted = changed?.visit ?? null;
      openVisitsOnJob = changed?.openVisitsOnJob ?? null;
    }
  }
  const items = await checklistFor(orgId, job.id);
  return { items, allDone: items.every((item) => item.doneAt), visitCompleted, openVisitsOnJob };
}
