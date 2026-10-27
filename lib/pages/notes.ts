import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { quotes } from "../../schema/schema";
import { storeInboundAttachment } from "../../core/blob";
import { db } from "../../core/db";
import { getNote, listNotes, saveNote, type NoteView, type NoteInput, type NoteViewer } from "../../core/notes";
import { searchRecords } from "../../core/records";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, refuse } from "./access";

// The Notes page and the notes on customer pages. Everyone reads the business-wide notes; owners and
// admins write them. Crew read and add notes on the customers they work with, and change only their own
// (core/notes.ts holds the rules; this only turns them into the page's words).

const viewerOf = (caller: AppCaller): NoteViewer => ({ orgId: caller.orgId, memberId: caller.memberId, role: caller.role });

export type NotesPage = { business: NoteView[]; linked: NoteView[]; query: string };

/** The notes the caller may read: business-wide first, then site notes; with words, the ones that match. */
export async function notesFor(caller: AppCaller, query = ""): Promise<NotesPage> {
  const viewer = viewerOf(caller);
  let notes: NoteView[];
  if (query.trim()) {
    const { results } = await searchRecords(viewer, query, { kinds: ["note"], limit: 30 });
    const found = await Promise.all(results.map((r) => getNote(viewer, r.id)));
    notes = found.filter((n): n is NoteView => n !== null);
  } else {
    notes = await listNotes(viewer, { limit: 300 });
  }
  const business = notes.filter((n) => !n.customerId && !n.propertyId && !n.quoteId);
  return { business, linked: notes.filter((n) => !business.includes(n)), query: query.trim() };
}

/** A customer's notes, on it, its properties, and its quotes. The page has already checked the caller may see the customer. */
export function customerNotesFor(caller: AppCaller, customerId: string): Promise<NoteView[]> {
  return listNotes(viewerOf(caller), { customerId });
}

/** A quote's notes. The page has already checked the caller may see the quote. */
export function quoteNotesFor(caller: AppCaller, quoteId: string): Promise<NoteView[]> {
  return listNotes(viewerOf(caller), { quoteId });
}

/** Whether the caller may change this note: owners and admins any, crew their own. */
export function canEditNote(caller: AppCaller, note: Pick<NoteView, "createdByMemberId">): boolean {
  if (caller.memberId === null) return false;
  return caller.role !== "member" || note.createdByMemberId === caller.memberId;
}

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const noteBodySchema = z
  .object({
    title: z.preprocess(blankToUndefined, z.string().trim().max(160).optional()),
    body: z.string().max(20000).optional(),
    tags: z.array(z.string().max(40)).max(12).optional(),
    customerId: z.string().max(64).nullable().optional(),
    propertyId: z.string().max(64).nullable().optional(),
    quoteId: z.string().max(64).nullable().optional(),
    archived: z.boolean().optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict();

/** Adds a note (no noteId) or changes one, as the signed-in member. */
export async function saveNoteFromApp(caller: AppCaller, noteId: string | undefined, input: z.infer<typeof noteBodySchema>): Promise<NoteView> {
  const actor = memberCaller(caller);
  const { expectedRevision, ...fields } = input;
  return saveAs(caller, { noteId, ...fields }, expectedRevision);
}

/** Saves through `saveNote` as the signed-in member, with its refusals in the page's words. */
async function saveAs(caller: AppCaller, input: NoteInput, expectedRevision?: number): Promise<NoteView> {
  const actor = memberCaller(caller);
  const e = pageCopyFor(caller.language).notes.errors;
  try {
    return await saveNote(actor, input, { expectedRevision });
  } catch (error) {
    refuse(error, {
      NOTE_NOT_FOUND: [404, "That isn't here."],
      CUSTOMER_NOT_FOUND: [404, "That isn't here."],
      PROPERTY_NOT_FOUND: [404, "That isn't here."],
      QUOTE_NOT_FOUND: [404, "That isn't here."],
      PROPERTY_MISMATCH: [400, e.propertyMismatch],
      NOTE_TITLE_REQUIRED: [400, e.titleRequired],
      NOTE_BUSINESS_PRIVILEGED: [403, e.businessPrivileged],
      NOTE_NOT_YOURS: [403, e.notYours],
      REVISION_CHANGED: [409, e.revisionChanged],
    });
  }
}

/** A note the caller may read, or a 404. */
export async function noteFor(caller: AppCaller, noteId: string): Promise<NoteView> {
  const note = await getNote(viewerOf(caller), noteId);
  if (!note) throw notFound();
  return note;
}

/** The most a file kept from the web may be: under what a Vercel function takes in one request. */
export const NOTE_FILE_MAX_BYTES = 4 * 1024 * 1024;

/** What a kept file is, from its first bytes (never its name or the browser's word): a PDF, a JPEG, or a PNG. */
export function keptFileType(bytes: Uint8Array): "application/pdf" | "image/jpeg" | "image/png" | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  return null;
}

/**
 * Keeps a file on a note the caller may change (owners and admins any, crew their own), making it a
 * document. PDFs, JPEGs, and PNGs up to 4 MB, checked by their bytes.
 */
export async function addNoteFileFromApp(caller: AppCaller, noteId: string, file: { name: string; bytes: Uint8Array }): Promise<NoteView> {
  const e = pageCopyFor(caller.language).notes.errors;
  const note = await noteFor(caller, noteId);
  if (!canEditNote(caller, note)) throw new HttpError(403, "NOTE_NOT_YOURS", e.notYours);
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > NOTE_FILE_MAX_BYTES) throw new HttpError(413, "FILE_TOO_LARGE", e.fileSize);
  const mimeType = keptFileType(file.bytes);
  if (!mimeType) throw new HttpError(415, "FILE_TYPE", e.fileType);
  const name = file.name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120) || "file";
  const url = await storeInboundAttachment(name, mimeType, file.bytes);
  return saveAs(caller, { noteId, files: [{ url, name, mimeType, type: mimeType === "application/pdf" ? "file" : "image" }] });
}
