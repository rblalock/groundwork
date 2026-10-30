// The work's checklist: one item per line of its quote, for the crew to tick off as they go. Made from
// the quote's current revision when the work's first visit is booked, or when someone reads it and it has
// none yet. Each item's text is built here from the line's name, quantity, and unit, in the reader's
// language: never the model's words, and never a price. An item is "outlined in the photo" when the
// quote's priced photo found that line. Anyone on the team ticks an item or unticks it; the tick that
// finishes the list marks the work's open visit done, once its day has come, as "done at Oak St" would.
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { checklistItems, members, serviceJobs } from "../schema/schema";
import type { LineResult, PricedRegion } from "../schema/types";
import { storeInboundAttachment } from "./blob";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import type { Language } from "./language";
import { crewCopy, pricedPhotosFor, type PricedPhoto } from "./priced-photo";
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

/** What a new item is made from: a quote line, and whether the priced photo outlines it. */
export type ItemSeed = Pick<ChecklistItemView, "lineIndex" | "name" | "quantity" | "unitLabel" | "located">;

const OUTLINED: Record<Language, string> = { en: "outlined in the photo", es: "marcada en la foto" };
const DONE_MARK = "✓";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const quantityText = (quantity: number) => String(Number(quantity.toFixed(2)));

/** One item per quote line, in line order; located when the priced photo's region for that line is. */
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

/** "Mulch installed, 3 cubic yards (outlined in the photo)". */
export function itemText(item: Pick<ItemSeed, "name" | "quantity" | "unitLabel" | "located">, language: Language): string {
  const unit = pluralUnit(item.quantity, oneLine(item.unitLabel), language);
  return `${oneLine(item.name)}, ${quantityText(item.quantity)}${unit ? ` ${unit}` : ""}${item.located ? ` (${OUTLINED[language]})` : ""}`;
}

/** The list as lines to send, numbered, each done item marked: "1. Mulch installed, 3 cubic yards ✓". */
export function checklistText(items: Array<Pick<ChecklistItemView, "name" | "quantity" | "unitLabel" | "located" | "doneAt">>, language: Language): string {
  return items.map((item, index) => `${index + 1}. ${itemText(item, language)}${item.doneAt ? ` ${DONE_MARK}` : ""}`).join("\n");
}

export function checklistCounts(items: Array<Pick<ChecklistItemView, "doneAt">>): { done: number; total: number } {
  return { done: items.filter((item) => item.doneAt).length, total: items.length };
}

/** The list as tools return it: each item's text and whether, by whom, and when it was ticked; `text` is ready to send. */
export function checklistForTool(items: ChecklistItemView[], timeZone: string, language: Language) {
  const { done, total } = checklistCounts(items);
  return {
    items: items.map((item, index) => ({
      itemId: item.itemId,
      number: index + 1,
      text: itemText(item, language),
      done: Boolean(item.doneAt),
      ...(item.doneAt ? { doneBy: item.doneByName, doneAt: `${dayText(wallClock(item.doneAt, timeZone).date, language)}, ${timeText(item.doneAt, timeZone, language)}` } : {}),
    })),
    done,
    total,
    allDone: done === total,
    text: checklistText(items, language),
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

/** The priced photo the list's outlined items are on: the newest made from the quote's own photo. */
export async function checklistPhoto(orgId: string, quoteId: string): Promise<PricedPhoto | null> {
  return (await pricedPhotosFor(orgId, quoteId)).find((photo) => photo.sourceKind === "quote_attachment") ?? null;
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
  const photo = await checklistPhoto(orgId, quote.quoteId);
  const seeds = itemsFromLines(quote.lines, photo?.regions ?? []);
  await db()
    .insert(checklistItems)
    .values(seeds.map((seed) => ({ id: newId("chk"), orgId, jobId, ...seed })))
    .onConflictDoNothing();
  return checklistFor(orgId, jobId);
}

export type CrewPhoto = { file: { filename: string; mimeType: string; data: Buffer }; fileUrl: string };

/** What booked crew get after the booking line: the list, and the priced photo it points to when there is one. */
export type CrewChecklist = {
  lines: (language: Language) => string;
  /** The priced photo's crew copy in that language (quantities, no prices), drawn and stored once per language. */
  photo: (language: Language) => Promise<CrewPhoto | null>;
};

/** The work's list for a crew text, made first if need be; null for work without a quote or an empty one. */
export async function crewChecklist(orgId: string, jobId: string): Promise<CrewChecklist | null> {
  const items = await ensureChecklist(orgId, jobId);
  if (!items.length) return null;
  const [job] = await db()
    .select({ quoteId: serviceJobs.quoteId })
    .from(serviceJobs)
    .where(and(eq(serviceJobs.orgId, orgId), eq(serviceJobs.id, jobId)));
  const priced = job?.quoteId ? await checklistPhoto(orgId, job.quoteId) : null;
  const drawn = new Map<Language, Promise<CrewPhoto | null>>();
  const draw = async (language: Language): Promise<CrewPhoto | null> => {
    const png = priced ? await crewCopy(priced, language) : null;
    if (!png) return null;
    const filename = "priced-photo.png";
    const fileUrl = await storeInboundAttachment(filename, "image/png", png);
    return { file: { filename, mimeType: "image/png", data: Buffer.from(png) }, fileUrl };
  };
  return {
    lines: (language) => checklistText(items, language),
    photo: (language) => {
      // A photo that can't be drawn or stored leaves the text to go on its own.
      if (!drawn.has(language)) drawn.set(language, draw(language).catch(() => null));
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
