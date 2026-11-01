import { and, eq } from "drizzle-orm";
import { quotes } from "../../schema/schema";
import { readStoredFile, storeInboundAttachment } from "../../core/blob";
import { pairOf } from "../../core/before-after";
import { checklistCounts, checklistFor, checklistPhotos, itemText, outlineMarks, outlinesOf, tickChecklist } from "../../core/checklist";
import { db } from "../../core/db";
import { invoicesForJobs, type InvoiceRef } from "../../core/invoices";
import { isPrivileged } from "../../core/members";
import { crewCopy, DRAWN_TYPE, pricedPhotosForCustomer, renderTag } from "../../core/priced-photo";
import { getServiceJob, type ServiceJobView } from "../../core/scheduling";
import { addUploadedWorkPhoto, listWorkPhotos, removeWorkPhoto, workPhoto, type WorkPhotoView } from "../../core/work-photos";
import { sniffImage } from "../../core/logo";
import { memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, refuse } from "./access";
import { preparePhoto } from "./photo-upload";
import { beforeAfterHref, pricedPhotoHref, type StoredFile } from "./quotes";

// A piece of work (a service job) on its own page: its customer, quote, invoice, visits, checklist, and
// photos. Everyone on the team sees it, ticks its checklist, and adds photos; the invoice opens for owners
// and admins only.

export type WorkPage = {
  job: ServiceJobView;
  quote: { id: string; title: string } | null;
  /** Its invoice's number and status for anyone; `canOpen` only for owners and admins. */
  invoice: (Pick<InvoiceRef, "invoiceId" | "label" | "status"> & { canOpen: boolean }) | null;
  photos: Array<WorkPhotoView & { canRemove: boolean }>;
  canAddPhotos: boolean;
  /** Its quote's lines to tick, each item's text in the viewer's language, with the priced photos they point to (in attachment order); null when it has no list. */
  checklist: {
    items: Array<{ itemId: string; text: string; doneAt: Date | null; doneByName: string | null }>;
    done: number;
    total: number;
    photoHrefs: string[];
    canTick: boolean;
  } | null;
};

export async function workFor(caller: AppCaller, jobId: string): Promise<WorkPage> {
  const job = await getServiceJob(caller, jobId);
  if (!job) throw notFound();
  const [quote, invoices, photos, items] = await Promise.all([
    job.quoteId
      ? db()
          .select({ id: quotes.id, title: quotes.title })
          .from(quotes)
          .where(and(eq(quotes.orgId, caller.orgId), eq(quotes.id, job.quoteId)))
          .then((rows) => rows[0] ?? null)
      : null,
    invoicesForJobs(caller.orgId, [job.id]),
    listWorkPhotos(caller.orgId, { jobId: job.id }),
    checklistFor(caller.orgId, job.id),
  ]);
  const invoice = invoices.get(job.id);
  const priced = items.length && job.quoteId ? await checklistPhotos(caller.orgId, job.quoteId) : [];
  const outlines = outlinesOf(priced);
  const privileged = isPrivileged(caller.role);
  return {
    job,
    quote,
    invoice: invoice ? { invoiceId: invoice.invoiceId, label: invoice.label, status: invoice.status, canOpen: privileged } : null,
    photos: photos.map((photo) => ({ ...photo, canRemove: caller.memberId !== null && (privileged || photo.addedByMemberId === caller.memberId) })),
    canAddPhotos: caller.memberId !== null,
    checklist: items.length
      ? {
          items: outlineMarks(items, outlines).map((item) => ({
            itemId: item.itemId,
            text: itemText(item, caller.language, outlines),
            doneAt: item.doneAt,
            doneByName: item.doneByName,
          })),
          ...checklistCounts(items),
          // The crew copies: quantities only, no prices, whoever is looking. Each render's tag changes
          // when it's drawn again, for an edit of its own or a change on another photo.
          photoHrefs: priced.map((photo) => `/api/work/${encodeURIComponent(job.id)}/checklist/photo?n=${photo.place.number}&v=${renderTag(photo.url)}`),
          canTick: caller.memberId !== null,
        }
      : null,
  };
}

/**
 * One of the checklist's priced photos as crew see it (quantities, no prices), in the viewer's language:
 * the `number`th in attachment order. Null when there's no such photo.
 */
export async function checklistPhotoFile(caller: AppCaller, jobId: string, number = 1): Promise<StoredFile | null> {
  const job = await getServiceJob(caller, jobId);
  if (!job) throw notFound();
  const priced = job.quoteId ? (await checklistPhotos(caller.orgId, job.quoteId))[number - 1] : undefined;
  const jpeg = priced ? await crewCopy(priced, caller.language, priced.place) : null;
  return jpeg ? { filename: priced!.place.count > 1 ? `priced-photo-${number}.jpg` : "priced-photo.jpg", contentType: DRAWN_TYPE, bytes: jpeg } : null;
}

/** Ticks a checklist item done, or unticks it, for anyone on the team; the last tick marks today's visit done. */
export async function tickChecklistFromApp(caller: AppCaller, jobId: string, itemIds: string[], undo: boolean): Promise<{ allDone: boolean; visitCompleted: boolean }> {
  const actor = memberCaller(caller);
  const e = pageCopyFor(caller.language).work.errors;
  try {
    const ticked = await tickChecklist(actor, { jobId, itemIds, undo });
    return { allDone: ticked.allDone, visitCompleted: ticked.visitCompleted !== null };
  } catch (error) {
    refuse(error, {
      SERVICE_JOB_NOT_FOUND: [404, "That isn't here."],
      NO_CHECKLIST: [404, e.itemGone],
      CHECKLIST_ITEM_NOT_FOUND: [404, e.itemGone],
    });
  }
}

/** The photos on a customer's work, newest first, for their page. */
export function customerWorkPhotos(caller: AppCaller, customerId: string): Promise<WorkPhotoView[]> {
  return listWorkPhotos(caller.orgId, { customerId }, 24);
}

/** One photo in a customer's price guide. `editId` is the priced photo its Edit link opens: its own, or a before-and-after's after photo. */
export type PriceGuideTile = { id: string; quoteId: string; quoteTitle: string; createdAt: Date; href: string; beforeAfter: boolean; editId: string };

/**
 * The priced photos on a customer's quotes, newest first: their price guide, served by the app. A quote
 * with a priced photo from before the job and one after shows its before-and-after in their place, where
 * the newer of the two would be.
 */
export async function customerPriceGuide(caller: AppCaller, customerId: string): Promise<PriceGuideTile[]> {
  const photos = await pricedPhotosForCustomer(caller.orgId, customerId, 12);
  const pairs = new Map([...new Set(photos.map((photo) => photo.quoteId))].map((quoteId) => [quoteId, pairOf(photos.filter((photo) => photo.quoteId === quoteId))]));
  const shown = new Set<string>();
  return photos.flatMap((photo): PriceGuideTile[] => {
    const pair = pairs.get(photo.quoteId);
    const tile = { id: photo.id, quoteId: photo.quoteId, quoteTitle: photo.quoteTitle, createdAt: photo.createdAt };
    if (!pair || (photo.id !== pair.before.id && photo.id !== pair.after.id)) return [{ ...tile, href: pricedPhotoHref(photo), beforeAfter: false, editId: photo.id }];
    if (shown.has(photo.quoteId)) return [];
    shown.add(photo.quoteId);
    return [
      { ...tile, id: `${photo.quoteId}:before-after`, href: beforeAfterHref({ quoteId: photo.quoteId, version: pair.version }), beforeAfter: true, editId: pair.after.id },
    ];
  });
}

/** A photo uploaded on the work's page, stored and added, optionally on one of its visits. */
export async function addWorkPhotoFromApp(caller: AppCaller, jobId: string, file: { name: string; bytes: Uint8Array }, visitId?: string): Promise<WorkPhotoView> {
  const actor = memberCaller(caller);
  const e = pageCopyFor(caller.language);
  if (!(await getServiceJob(caller, jobId))) throw notFound();
  const photo = await preparePhoto(file, e.quotes.errors);
  const url = await storeInboundAttachment(photo.name, photo.mimeType, photo.bytes);
  try {
    return await addUploadedWorkPhoto(actor, { jobId, visitId: visitId || null }, { url, name: photo.name, mimeType: photo.mimeType });
  } catch (error) {
    refuse(error, {
      TOO_MANY_PHOTOS: [409, e.work.errors.photoLimit],
      VISIT_NOT_FOUND: [400, e.work.errors.visitGone],
      SERVICE_JOB_NOT_FOUND: [404, "That isn't here."],
    });
  }
}

/** Takes a photo off the work: whoever added it, or an owner or admin. */
export async function removeWorkPhotoFromApp(caller: AppCaller, jobId: string, photoId: string): Promise<void> {
  const actor = memberCaller(caller);
  const e = pageCopyFor(caller.language).work.errors;
  try {
    await removeWorkPhoto(actor, jobId, photoId);
  } catch (error) {
    refuse(error, { PHOTO_NOT_FOUND: [404, e.photoGone], NOT_PRIVILEGED: [403, e.notYours] });
  }
}

/** One photo's bytes, for anyone on the team. */
export async function workPhotoFile(caller: AppCaller, jobId: string, photoId: string): Promise<StoredFile> {
  if (!(await getServiceJob(caller, jobId))) throw notFound();
  const photo = await workPhoto(caller.orgId, jobId, photoId);
  if (!photo) throw notFound();
  const bytes = await readStoredFile(photo.url);
  if (!bytes) throw notFound();
  const kind = sniffImage(bytes);
  return {
    bytes,
    contentType: kind === "jpeg" ? "image/jpeg" : kind === "png" ? "image/png" : "application/octet-stream",
    filename: (photo.name ?? "photo").replace(/[^\w.-]+/g, "_"),
  };
}
