import { and, asc, desc, eq, gte, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { customers, members, messages, notes, properties, quotes } from "../schema/schema";
import type { InboundAttachment, NoteFile } from "../schema/types";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { isPrivileged, type Role } from "./members";

// What a business wants remembered beyond prices: how it does things, site notes on a customer, a
// property, or a quote, and documents (files a member texted in and asked to keep).
//
// Who may do what: every member reads every note. Only the owner and admins write business-wide notes;
// anyone adds site notes on a customer, property, or quote. Crew change only notes they wrote.

export type Note = typeof notes.$inferSelect;
export type NoteKind = Note["kind"];
export type NoteActor = { orgId: string; memberId: string; role: Role };
/** Who is looking: a super admin's look-only view has no member, and sees what an owner sees. */
export type NoteViewer = { orgId: string; memberId: string | null; role: Role };

export type NoteView = Note & {
  customerName: string | null;
  propertyAddress: string | null;
  quoteTitle: string | null;
  createdByName: string;
  updatedByName: string;
};

export const NOTE_TITLE_MAX = 160;
export const NOTE_BODY_MAX = 20_000;
const TAG_MAX = 12;

/** A note linked to nothing: how the whole business works. */
export function isBusinessNote(note: Pick<Note, "customerId" | "propertyId" | "quoteId">): boolean {
  return !note.customerId && !note.propertyId && !note.quoteId;
}

const businessWide = sql`(${notes.customerId} is null and ${notes.propertyId} is null and ${notes.quoteId} is null)`;


const createdBy = alias(members, "note_created_by");
const updatedBy = alias(members, "note_updated_by");

function noteQuery(executor: Db | Tx, orgId: string) {
  return executor
    .select({
      note: notes,
      customerName: customers.name,
      propertyAddress: properties.address,
      quoteTitle: quotes.title,
      createdByName: createdBy.name,
      updatedByName: updatedBy.name,
    })
    .from(notes)
    .leftJoin(customers, and(eq(customers.orgId, orgId), eq(customers.id, notes.customerId)))
    .leftJoin(properties, and(eq(properties.orgId, orgId), eq(properties.id, notes.propertyId)))
    .leftJoin(quotes, and(eq(quotes.orgId, orgId), eq(quotes.id, notes.quoteId)))
    .innerJoin(createdBy, eq(createdBy.id, notes.createdByMemberId))
    .innerJoin(updatedBy, eq(updatedBy.id, notes.updatedByMemberId));
}

type NoteRow = Awaited<ReturnType<typeof noteQuery>>[number];
const toView = (row: NoteRow): NoteView => ({
  ...row.note,
  customerName: row.customerName,
  propertyAddress: row.propertyAddress,
  quoteTitle: row.quoteTitle,
  createdByName: row.createdByName,
  updatedByName: row.updatedByName,
});

/** One note the viewer may read, archived or not, or null. */
export async function getNote(viewer: NoteViewer, noteId: string, executor: Db | Tx = db()): Promise<NoteView | null> {
  const [row] = await noteQuery(executor, viewer.orgId).where(and(eq(notes.orgId, viewer.orgId), eq(notes.id, noteId)));
  return row ? toView(row) : null;
}

export type NoteFilter = {
  /** `business`: linked to nothing; `linked`: on a customer, property, or quote. */
  scope?: "business" | "linked";
  /** Notes on this customer, including those on its properties and quotes. */
  customerId?: string;
  propertyId?: string;
  quoteId?: string;
  includeArchived?: boolean;
  /** Only archived notes, for bringing one back. */
  archived?: boolean;
  limit?: number;
};

/** The notes the viewer may read, newest change first. */
export async function listNotes(viewer: NoteViewer, filter: NoteFilter = {}): Promise<NoteView[]> {
  const rows = await noteQuery(db(), viewer.orgId)
    .where(
      and(
        eq(notes.orgId, viewer.orgId),
        filter.archived ? isNotNull(notes.archivedAt) : filter.includeArchived ? undefined : isNull(notes.archivedAt),
        filter.scope === "business" ? businessWide : filter.scope === "linked" ? sql`not ${businessWide}` : undefined,
        filter.customerId ? eq(notes.customerId, filter.customerId) : undefined,
        filter.propertyId ? eq(notes.propertyId, filter.propertyId) : undefined,
        filter.quoteId ? eq(notes.quoteId, filter.quoteId) : undefined,
      ),
    )
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 300));
  return rows.map(toView);
}

/** The business-wide notes, oldest first, for the assistant's look at the business. */
export async function businessNotes(orgId: string, limit = 40): Promise<Note[]> {
  return db()
    .select()
    .from(notes)
    .where(and(eq(notes.orgId, orgId), isNull(notes.archivedAt), businessWide))
    .orderBy(asc(notes.createdAt), asc(notes.id))
    .limit(limit);
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, " ")).filter(Boolean))]
    .map((t) => t.slice(0, 40))
    .slice(0, TAG_MAX);
}

export type NoteInput = {
  /** Omit to add a note. */
  noteId?: string;
  kind?: NoteKind;
  title?: string;
  body?: string;
  tags?: string[];
  /** Null takes the note off it. */
  customerId?: string | null;
  propertyId?: string | null;
  quoteId?: string | null;
  /** Added to the note's files. */
  files?: NoteFile[];
  /** True archives it, false brings it back. */
  archived?: boolean;
};

type Links = { customerId: string | null; propertyId: string | null; quoteId: string | null };

/**
 * Checks the links are this business's and agree: a property sets its customer, a quote its customer and
 * property. Throws `CUSTOMER_NOT_FOUND`, `PROPERTY_NOT_FOUND`, `QUOTE_NOT_FOUND`, or `PROPERTY_MISMATCH`.
 */
async function resolveLinks(tx: Tx, orgId: string, wanted: Links): Promise<Links> {
  const links = { ...wanted };
  if (links.quoteId) {
    const [quote] = await tx
      .select({ customerId: quotes.customerId, propertyId: quotes.propertyId })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), eq(quotes.id, links.quoteId)));
    if (!quote) throw new Error("QUOTE_NOT_FOUND");
    links.customerId ??= quote.customerId;
    links.propertyId ??= quote.propertyId;
  }
  if (links.propertyId) {
    const [property] = await tx
      .select({ customerId: properties.customerId })
      .from(properties)
      .where(and(eq(properties.orgId, orgId), eq(properties.id, links.propertyId)));
    if (!property) throw new Error("PROPERTY_NOT_FOUND");
    if (links.customerId && links.customerId !== property.customerId) throw new Error("PROPERTY_MISMATCH");
    links.customerId = property.customerId;
  }
  if (links.customerId) {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.orgId, orgId), eq(customers.id, links.customerId)));
    if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
  }
  return links;
}

/**
 * Adds a note (no noteId; a title is required) or changes one. Business-wide notes are the owner's and
 * admins'; anyone writes site notes, and crew change only their own.
 * `expectedRevision` refuses a change made from an older read. Throws `NOTE_TITLE_REQUIRED`,
 * `NOTE_NOT_FOUND`, `NOTE_BUSINESS_PRIVILEGED`, `NOTE_NOT_YOURS`, `REVISION_CHANGED`,
 * and the link errors of `resolveLinks`.
 */
export async function saveNote(actor: NoteActor, input: NoteInput, options: { expectedRevision?: number } = {}): Promise<NoteView> {
  const title = input.title?.replace(/\s+/g, " ").trim().slice(0, NOTE_TITLE_MAX);
  const body = input.body === undefined ? undefined : input.body.trim().slice(0, NOTE_BODY_MAX);
  const privileged = isPrivileged(actor.role);

  const id = await db().transaction(async (tx) => {
    let existing: Note | undefined;
    if (input.noteId) {
      [existing] = await tx
        .select()
        .from(notes)
        .where(and(eq(notes.orgId, actor.orgId), eq(notes.id, input.noteId)))
        .for("update");
      if (!existing) throw new Error("NOTE_NOT_FOUND");
      if (!privileged && existing.createdByMemberId !== actor.memberId) {
        throw new Error("NOTE_NOT_YOURS");
      }
      if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) throw new Error("REVISION_CHANGED");
    } else if (!title) {
      throw new Error("NOTE_TITLE_REQUIRED");
    }

    // Links given replace the note's links (a quote brings its customer and property, a property its
    // customer); none given keeps them.
    const changesLinks = input.customerId !== undefined || input.propertyId !== undefined || input.quoteId !== undefined;
    const links = changesLinks
      ? await resolveLinks(tx, actor.orgId, {
          customerId: input.customerId ?? null,
          propertyId: input.propertyId ?? null,
          quoteId: input.quoteId ?? null,
        })
      : { customerId: existing?.customerId ?? null, propertyId: existing?.propertyId ?? null, quoteId: existing?.quoteId ?? null };
    if (!privileged && isBusinessNote(links)) throw new Error("NOTE_BUSINESS_PRIVILEGED");

    const files = [...(existing?.files ?? []), ...(input.files ?? [])].filter(
      (file, i, all) => all.findIndex((f) => f.url === file.url) === i,
    );
    const kind: NoteKind = input.kind ?? (existing?.kind === "document" || files.length > 0 ? "document" : "note");
    const archivedAt = input.archived === undefined ? (existing?.archivedAt ?? null) : input.archived ? (existing?.archivedAt ?? new Date()) : null;
    const values = {
      kind,
      title: title || existing?.title || "",
      body: body ?? existing?.body ?? "",
      tags: input.tags ? cleanTags(input.tags) : (existing?.tags ?? []),
      ...links,
      files,
      archivedAt,
      updatedByMemberId: actor.memberId,
      updatedAt: new Date(),
    };
    let noteId: string;
    if (existing) {
      await tx
        .update(notes)
        .set({ ...values, revision: sql`${notes.revision} + 1` })
        .where(and(eq(notes.orgId, actor.orgId), eq(notes.id, existing.id)));
      noteId = existing.id;
    } else {
      const [row] = await tx
        .insert(notes)
        .values({ id: newId("note"), orgId: actor.orgId, createdByMemberId: actor.memberId, ...values })
        .returning({ id: notes.id });
      noteId = row.id;
    }
    await recordEvent(
      { orgId: actor.orgId, kind: existing ? (input.archived === true ? "note.archived" : "note.updated") : "note.created", refId: noteId, memberId: actor.memberId },
      tx,
    );
    return noteId;
  });
  return (await getNote(actor, id)) as NoteView;
}

/** The half hour the assistant looks back for a file the member texted. */
export const FILE_WINDOW_MS = 30 * 60 * 1000;

/**
 * The files on this member's newest inbound text that has any, from the last half hour: what "keep
 * this" points at. They are set aside as documents, so they never attach to a quote. Empty when there
 * are none.
 */
export async function takeRecentFiles(orgId: string, memberId: string, now: Date = new Date()): Promise<NoteFile[]> {
  return db().transaction(async (tx) => {
    const [message] = await tx
      .select({ id: messages.id, attachments: messages.attachments })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.memberId, memberId),
          eq(messages.direction, "inbound"),
          gte(messages.createdAt, new Date(now.getTime() - FILE_WINDOW_MS)),
          sql`jsonb_array_length(${messages.attachments}) > 0`,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    if (!message) return [];
    const next: InboundAttachment[] = message.attachments.map((a) => (a.document ? a : { ...a, document: true }));
    await tx
      .update(messages)
      .set({ attachments: next })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, message.id)));
    return message.attachments.map((a) => ({
      url: a.url,
      ...(a.name ? { name: a.name } : {}),
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      type: a.type,
    }));
  });
}

/** Where a note belongs, in words, for the assistant and the pages. */
export function noteWhere(note: Pick<NoteView, "customerName" | "propertyAddress" | "quoteTitle">): string | null {
  return [note.customerName, note.propertyAddress, note.quoteTitle ? `quote ${note.quoteTitle}` : null].filter(Boolean).join(", ") || null;
}

/** A note as the assistant's tools return it. */
export function noteForTool(note: NoteView, options: { full?: boolean } = {}) {
  const text = options.full || note.body.length <= 400 ? note.body : `${note.body.slice(0, 400)}…`;
  return {
    noteId: note.id,
    kind: note.kind,
    title: note.title,
    text,
    ...(text !== note.body ? { truncated: true } : {}),
    tags: note.tags,
    businessWide: isBusinessNote(note),
    customerId: note.customerId,
    customerName: note.customerName,
    propertyId: note.propertyId,
    propertyAddress: note.propertyAddress,
    quoteId: note.quoteId,
    quoteTitle: note.quoteTitle,
    files: note.files.map((f) => ({ name: f.name ?? null, url: f.url, mimeType: f.mimeType ?? null })),
    archived: note.archivedAt !== null,
    revision: note.revision,
    writtenBy: note.createdByName,
    updatedBy: note.updatedByName,
    updatedAt: note.updatedAt,
  };
}
