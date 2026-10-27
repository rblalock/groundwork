import { and, eq } from "drizzle-orm";
import { quotes } from "../../schema/schema";
import { readStoredFile, storeInboundAttachment } from "../../core/blob";
import { db } from "../../core/db";
import { invoicesForJobs, type InvoiceRef } from "../../core/invoices";
import { isPrivileged } from "../../core/members";
import { pricedPhotosForCustomer } from "../../core/priced-photo";
import { getServiceJob, type ServiceJobView } from "../../core/scheduling";
import { addUploadedWorkPhoto, listWorkPhotos, removeWorkPhoto, workPhoto, type WorkPhotoView } from "../../core/work-photos";
import { sniffImage } from "../../core/logo";
import { memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, refuse } from "./access";
import { preparePhoto } from "./photo-upload";
import { pricedPhotoHref, type StoredFile } from "./quotes";

// A piece of work (a service job) on its own page: its customer, quote, invoice, visits, and photos.
// Everyone on the team sees it and adds photos; the invoice opens for owners and admins only.

export type WorkPage = {
  job: ServiceJobView;
  quote: { id: string; title: string } | null;
  /** Its invoice's number and status for anyone; `canOpen` only for owners and admins. */
  invoice: (Pick<InvoiceRef, "invoiceId" | "label" | "status"> & { canOpen: boolean }) | null;
  photos: Array<WorkPhotoView & { canRemove: boolean }>;
  canAddPhotos: boolean;
};

export async function workFor(caller: AppCaller, jobId: string): Promise<WorkPage> {
  const job = await getServiceJob(caller, jobId);
  if (!job) throw notFound();
  const [quote, invoices, photos] = await Promise.all([
    job.quoteId
      ? db()
          .select({ id: quotes.id, title: quotes.title })
          .from(quotes)
          .where(and(eq(quotes.orgId, caller.orgId), eq(quotes.id, job.quoteId)))
          .then((rows) => rows[0] ?? null)
      : null,
    invoicesForJobs(caller.orgId, [job.id]),
    listWorkPhotos(caller.orgId, { jobId: job.id }),
  ]);
  const invoice = invoices.get(job.id);
  const privileged = isPrivileged(caller.role);
  return {
    job,
    quote,
    invoice: invoice ? { invoiceId: invoice.invoiceId, label: invoice.label, status: invoice.status, canOpen: privileged } : null,
    photos: photos.map((photo) => ({ ...photo, canRemove: caller.memberId !== null && (privileged || photo.addedByMemberId === caller.memberId) })),
    canAddPhotos: caller.memberId !== null,
  };
}

/** The photos on a customer's work, newest first, for their page. */
export function customerWorkPhotos(caller: AppCaller, customerId: string): Promise<WorkPhotoView[]> {
  return listWorkPhotos(caller.orgId, { customerId }, 24);
}

/** The priced photos on a customer's quotes, newest first: their price guide, served by the app. */
export async function customerPriceGuide(caller: AppCaller, customerId: string): Promise<Array<{ id: string; quoteId: string; quoteTitle: string; createdAt: Date; href: string }>> {
  const photos = await pricedPhotosForCustomer(caller.orgId, customerId, 12);
  return photos.map((photo) => ({ id: photo.id, quoteId: photo.quoteId, quoteTitle: photo.quoteTitle, createdAt: photo.createdAt, href: pricedPhotoHref(photo) }));
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
