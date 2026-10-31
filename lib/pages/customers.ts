import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { notes, serviceJobs, workPhotos } from "../../schema/schema";
import { db } from "../../core/db";
import {
  archiveCustomer,
  customerCursor,
  customerHistory,
  getCustomer,
  likelySameCustomers,
  listCustomers,
  mergeCustomers,
  removeContact,
  removeProperty,
  restoreCustomer,
  saveContact,
  saveCustomer,
  saveProperty,
  searchCustomers,
  type CustomerChange,
  type CustomerCursor,
  type CustomerListRow,
  type CustomerWithProperties,
} from "../../core/customers";
import { isPrivileged } from "../../core/members";
import { listQuotes, type QuoteSummary } from "../../core/quotes";
import { languageSchema } from "../../core/tool-schemas";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { notFound, privilegedActor, refuse } from "./access";

/** The business's customers, for everyone on the team. */
export function customersFor(caller: AppCaller, query?: string): Promise<CustomerListRow[]> {
  return listCustomers(caller.orgId, { query });
}

/** Customers per page of the list. */
export const CUSTOMER_PAGE_SIZE = 50;

/** A customer cursor from a page link (`?before=` / `?after=`), `<last activity>~<id>`, or nothing for anything malformed. */
export function parseCustomerCursor(value: unknown): CustomerCursor | undefined {
  const match = typeof value === "string" ? value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~(cus_[\w-]{1,64})$/) : null;
  if (!match || Number.isNaN(Date.parse(match[1]))) return undefined;
  return { at: match[1], id: match[2] };
}

export const formatCustomerCursor = (cursor: CustomerCursor) => `${cursor.at}~${cursor.id}`;

export type CustomerList = {
  customers: CustomerListRow[];
  /** Whether there are customers past this page: less recently active ones, and more recently active ones. */
  hasOlder: boolean;
  hasNewer: boolean;
  /** Whether the business has any customers at all, so an empty search or page isn't taken for none. */
  any: boolean;
};

/**
 * One page of the business's customers, most recently active first, paged from a customer (`before` it
 * for older ones, `after` it for newer). A search shows its top matches, with no pages.
 */
export async function customerListFor(
  caller: AppCaller,
  filter: { query?: string; before?: CustomerCursor; after?: CustomerCursor },
): Promise<CustomerList> {
  const { orgId } = caller;
  if (filter.query?.trim()) {
    const [customers, first] = await Promise.all([listCustomers(orgId, { query: filter.query }), listCustomers(orgId, { limit: 1 })]);
    return { customers, hasOlder: false, hasNewer: false, any: first.length > 0 };
  }
  const newer = filter.after !== undefined && filter.before === undefined;
  const fetched = await listCustomers(orgId, { before: newer ? undefined : filter.before, after: newer ? filter.after : undefined, limit: CUSTOMER_PAGE_SIZE + 1 });
  const more = fetched.length > CUSTOMER_PAGE_SIZE;
  // Newer pages come back most recent first, so their extra customer is the first.
  const customers = more ? (newer ? fetched.slice(1) : fetched.slice(0, CUSTOMER_PAGE_SIZE)) : fetched;
  const paged = filter.before !== undefined || filter.after !== undefined;
  const first = customers[0];
  const last = customers.at(-1);
  const [ahead, behind, anyAtAll] = await Promise.all([
    !newer && paged && first ? listCustomers(orgId, { after: customerCursor(first), limit: 1 }) : Promise.resolve([]),
    newer && last ? listCustomers(orgId, { before: customerCursor(last), limit: 1 }) : Promise.resolve([]),
    paged && customers.length === 0 ? listCustomers(orgId, { limit: 1 }) : Promise.resolve(customers),
  ]);
  return {
    customers,
    hasOlder: newer ? behind.length > 0 : more,
    hasNewer: newer ? more : ahead.length > 0,
    any: anyAtAll.length > 0,
  };
}

/**
 * How many notes and work photos a customer has, for their page's tabs: counted, so only the open tab's
 * records are read.
 */
export async function customerTabCounts(caller: AppCaller, customerId: string): Promise<{ notes: number; photos: number }> {
  const count = sql<number>`count(*)::int`;
  const [[noteRow], [photoRow]] = await Promise.all([
    db()
      .select({ n: count })
      .from(notes)
      .where(and(eq(notes.orgId, caller.orgId), eq(notes.customerId, customerId), isNull(notes.archivedAt))),
    db()
      .select({ n: count })
      .from(workPhotos)
      .innerJoin(serviceJobs, and(eq(serviceJobs.orgId, caller.orgId), eq(serviceJobs.id, workPhotos.jobId)))
      .where(and(eq(workPhotos.orgId, caller.orgId), eq(serviceJobs.customerId, customerId), isNull(workPhotos.removedAt))),
  ]);
  return { notes: noteRow?.n ?? 0, photos: photoRow?.n ?? 0 };
}

export type CustomerPage = {
  customer: CustomerWithProperties;
  quotes: QuoteSummary[];
  /** Owners and admins only: crew see no one's changes. */
  history: CustomerChange[];
  /** The customer this one was merged into, when it was. */
  mergedInto: { id: string; name: string } | null;
};

/**
 * One customer and their quotes, or a 404. Archived customers still open, so their quotes and invoices
 * lead back to them.
 */
export async function customerFor(caller: AppCaller, customerId: string): Promise<CustomerPage> {
  const customer = await getCustomer(caller.orgId, customerId);
  if (!customer) throw notFound();
  const quotes = await listQuotes(caller.orgId, { customerId, limit: 50 });
  const [history, into] = await Promise.all([
    isPrivileged(caller.role) ? customerHistory(caller.orgId, customerId) : Promise.resolve([]),
    customer.mergedIntoId ? getCustomer(caller.orgId, customer.mergedIntoId) : Promise.resolve(null),
  ]);
  return { customer, quotes, history, mergedInto: into ? { id: into.id, name: into.name } : null };
}

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const revision = z.number().int().min(1);

/** What the customer page can change. A phone or email is added to the preferred contact; an address becomes a property. */
export const customerPatchSchema = z
  .object({
    name: z.preprocess(blankToUndefined, z.string().trim().min(1).max(200).optional()),
    phone: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    email: z.preprocess(blankToUndefined, z.string().trim().email().max(200).optional()),
    language: languageSchema.optional(),
    notes: z.string().max(2000).optional(),
    address: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()),
    /** The revision the page showed: a change made on a stale page is refused. */
    expectedRevision: revision.optional(),
  })
  .strict();

function errorsFor(caller: AppCaller) {
  const errors = pageCopyFor(caller.language).customers.errors;
  return {
    CUSTOMER_NOT_FOUND: [404, "That isn't here."],
    CONTACT_NOT_FOUND: [404, "That isn't here."],
    PROPERTY_NOT_FOUND: [404, "That isn't here."],
    INVALID_PHONE: [400, errors.invalidPhone],
    INVALID_EMAIL: [400, errors.invalidEmail],
    NAME_REQUIRED: [400, errors.nameRequired],
    CONTACT_NAME_REQUIRED: [400, errors.contactNameRequired],
    REVISION_CHANGED: [409, errors.revisionChanged],
    CUSTOMER_ARCHIVED: [409, errors.archived],
    CUSTOMER_MERGED: [409, errors.merged],
    SAME_CUSTOMER: [400, errors.sameCustomer],
  } as const;
}

export const newCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    phone: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    email: z.preprocess(blankToUndefined, z.string().trim().email().max(200).optional()),
    address: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()),
    language: languageSchema.optional(),
  })
  .strict();

/**
 * Anyone on the team adds a customer through `saveCustomer`, as the assistant's `save_customer` does: the
 * phone and email go on their preferred contact, and the address becomes a property and is placed.
 */
export async function createCustomerFromApp(caller: AppCaller, input: z.infer<typeof newCustomerSchema>): Promise<CustomerWithProperties> {
  const actor = memberCaller(caller);
  try {
    return await saveCustomer(caller.orgId, input, actor.memberId);
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

/** Customers already saved who may be the one being added, a few fields each, for the new-customer form. */
export async function sameCustomersFor(caller: AppCaller, input: { name?: string; phone?: string; email?: string }) {
  const found = await likelySameCustomers(caller.orgId, input);
  return found.map((c) => ({ id: c.id, name: c.name }));
}

/** An owner or admin edits a customer through `saveCustomer`, as the assistant does. */
export async function updateCustomerFromApp(
  caller: AppCaller,
  customerId: string,
  patch: z.infer<typeof customerPatchSchema>,
): Promise<CustomerWithProperties> {
  const actor = memberCaller(caller);
  const { expectedRevision, ...fields } = patch;
  try {
    return await saveCustomer(caller.orgId, { ...fields, customerId }, actor.memberId, { expectedRevision });
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

const phoneList = z.array(z.string().max(40)).max(10);
const emailList = z.array(z.string().max(200)).max(10);

export const contactBodySchema = z
  .object({
    name: z.preprocess(blankToUndefined, z.string().trim().max(160).optional()),
    role: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(80).nullable().optional()),
    addPhones: phoneList.optional(),
    removePhones: phoneList.optional(),
    addEmails: emailList.optional(),
    removeEmails: emailList.optional(),
    preferred: z.boolean().optional(),
    expectedRevision: revision,
  })
  .strict();

/** An owner or admin adds a contact (no contactId) or changes one. */
export async function saveContactFromApp(
  caller: AppCaller,
  customerId: string,
  contactId: string | undefined,
  body: z.infer<typeof contactBodySchema>,
): Promise<CustomerWithProperties> {
  const actor = memberCaller(caller);
  const { expectedRevision, ...fields } = body;
  try {
    return (await saveContact(caller.orgId, { customerId, contactId, ...fields }, actor.memberId, { expectedRevision })).customer;
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

export async function removeContactFromApp(caller: AppCaller, customerId: string, contactId: string, expectedRevision: number): Promise<CustomerWithProperties> {
  const actor = memberCaller(caller);
  try {
    return await removeContact(caller.orgId, { customerId, contactId }, actor.memberId, { expectedRevision });
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

export const propertyBodySchema = z
  .object({
    address: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()),
    notes: z.string().max(2000).nullable().optional(),
    expectedRevision: revision,
  })
  .strict();

/** An owner or admin corrects a property's address or changes its notes. */
export async function savePropertyFromApp(
  caller: AppCaller,
  customerId: string,
  propertyId: string,
  body: z.infer<typeof propertyBodySchema>,
): Promise<CustomerWithProperties> {
  const actor = memberCaller(caller);
  const { expectedRevision, ...fields } = body;
  try {
    return await saveProperty(caller.orgId, { customerId, propertyId, ...fields }, actor.memberId, { expectedRevision });
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

/** An owner or admin removes a property no quote, job, invoice, or note is on. */
export async function removePropertyFromApp(caller: AppCaller, customerId: string, propertyId: string, expectedRevision: number): Promise<CustomerWithProperties> {
  const actor = memberCaller(caller);
  try {
    return await removeProperty(caller.orgId, { customerId, propertyId }, actor.memberId, { expectedRevision });
  } catch (error) {
    const inUse = error instanceof Error ? /^PROPERTY_IN_USE:(\d+)$/.exec(error.message) : null;
    if (inUse) throw new HttpError(409, "PROPERTY_IN_USE", pageCopyFor(caller.language).customers.errors.addressInUse(Number(inUse[1])));
    refuse(error, errorsFor(caller));
  }
}

export const archiveBodySchema = z.object({ archived: z.boolean(), expectedRevision: revision }).strict();

/** An owner or admin archives a customer, or brings one back. */
export async function setArchivedFromApp(caller: AppCaller, customerId: string, body: z.infer<typeof archiveBodySchema>): Promise<CustomerWithProperties> {
  const actor = privilegedActor(caller);
  try {
    return body.archived
      ? (await archiveCustomer(caller.orgId, customerId, actor.memberId, { expectedRevision: body.expectedRevision })).customer
      : await restoreCustomer(caller.orgId, customerId, actor.memberId, { expectedRevision: body.expectedRevision });
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

export const mergeBodySchema = z.object({ otherId: z.string().min(1).max(64), expectedRevision: revision, otherRevision: revision }).strict();

/** An owner or admin merges another customer into this one, which stays. */
export async function mergeFromApp(caller: AppCaller, customerId: string, body: z.infer<typeof mergeBodySchema>) {
  const actor = privilegedActor(caller);
  try {
    return await mergeCustomers(caller.orgId, { keepId: customerId, mergeId: body.otherId }, actor.memberId, {
      expectedRevisions: { keep: body.expectedRevision, merge: body.otherRevision },
    });
  } catch (error) {
    refuse(error, errorsFor(caller));
  }
}

/** Customers to merge into another: an owner's or admin's search, a few fields each. */
export async function mergeCandidatesFor(caller: AppCaller, query: string, excludeId?: string) {
  privilegedActor(caller);
  const found = await searchCustomers(caller.orgId, query, { limit: 8 });
  return found
    .filter((c) => c.id !== excludeId)
    .map((c) => ({ id: c.id, name: c.name, revision: c.revision, phones: c.phones, emails: c.emails, address: c.properties[0]?.address ?? null }));
}
