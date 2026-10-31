import { and, asc, count, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  conversations,
  customerChanges,
  customerContacts,
  customers,
  invoices,
  members,
  notes,
  properties,
  quotes,
  serviceJobs,
  visitCrew,
  visits,
} from "../schema/schema";
import { db, newId, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import { normalizeE164 } from "./members";
import type { Language } from "./language";
import { placeProperty } from "./places";
import { businessLanguage } from "./profile";

export type Customer = typeof customers.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type Contact = typeof customerContacts.$inferSelect;
export type CustomerWithProperties = Customer & { properties: Property[]; contacts: Contact[] };

const SEARCH_LIMIT = 20;

// Accented letters folded to ASCII, used by both the SQL prefilter (translate) and `fold`.
const SPECIAL: Record<string, string> = { ł: "l", ø: "o", đ: "d", ð: "d" };
const ACCENTED = "àáâãäåāăąçćčďèéêëēėęěìíîïīįñńňòóôõöōőřśšşťùúûüūůűųýÿźżžłøđð";
const fromChars = ACCENTED + ACCENTED.toUpperCase();
const toChars = [...ACCENTED]
  .map((c) => SPECIAL[c] ?? c.normalize("NFD")[0])
  .join("")
  .repeat(2);

/** Lowercase and strip diacritics. */
export function fold(text: string): string {
  return [...text.normalize("NFC").toLowerCase()]
    .map((c) => SPECIAL[c] ?? c.normalize("NFD").replace(/\p{Diacritic}/gu, ""))
    .join("");
}

/** `fold` in SQL: lowercase, with the accented letters `fold` knows turned to ASCII. */
export function foldedSql(expr: SQL | SQL.Aliased | typeof customers.name | typeof properties.address): SQL {
  return sql`lower(translate(${expr}, ${fromChars}, ${toChars}))`;
}

/** An address reduced to compare with another: folded, no punctuation, single spaces. */
export function addressKey(address: string): string {
  return fold(address).replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Preferred contact first, then oldest first. */
const contactOrder = [desc(customerContacts.preferred), asc(customerContacts.createdAt), asc(customerContacts.id)];

async function withDetails(orgId: string, rows: Customer[], executor: Db | Tx = db()): Promise<CustomerWithProperties[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [props, people] = await Promise.all([
    executor
      .select()
      .from(properties)
      .where(and(eq(properties.orgId, orgId), inArray(properties.customerId, ids)))
      .orderBy(asc(properties.createdAt), asc(properties.id)),
    executor
      .select()
      .from(customerContacts)
      .where(and(eq(customerContacts.orgId, orgId), inArray(customerContacts.customerId, ids)))
      .orderBy(...contactOrder),
  ]);
  return rows.map((row) => ({
    ...row,
    properties: props.filter((p) => p.customerId === row.id),
    contacts: people.filter((c) => c.customerId === row.id),
  }));
}

/**
 * The WHERE conditions for a search: every word of the query must match the name, a contact's name,
 * role, or email, or a property address; a query of only digits and phone punctuation matches any
 * contact's phone by digits. Null when the query can match nothing.
 */
function searchConditions(orgId: string, query: string): SQL[] | null {
  const trimmed = query.trim();
  if (/^[\d\s()+.-]+$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    if (!digits) return null;
    return [
      sql`exists (
        select 1 from ${customerContacts}
        where ${customerContacts.customerId} = ${customers.id}
          and ${customerContacts.orgId} = ${orgId}
          and regexp_replace(array_to_string(${customerContacts.phones}, ' '), '\\D', '', 'g') like ${`%${escapeLike(digits)}%`}
      )`,
    ];
  }
  return fold(trimmed)
    .split(/\s+/)
    .map((token) => {
      const pattern = `%${escapeLike(token)}%`;
      return sql`(
        ${foldedSql(customers.name)} like ${pattern}
        or exists (
          select 1 from ${customerContacts}
          where ${customerContacts.customerId} = ${customers.id}
            and ${customerContacts.orgId} = ${orgId}
            and (
              ${foldedSql(sql`${customerContacts.name}`)} like ${pattern}
              or ${foldedSql(sql`coalesce(${customerContacts.role}, '')`)} like ${pattern}
              or ${foldedSql(sql`array_to_string(${customerContacts.emails}, ' ')`)} like ${pattern}
            )
        )
        or exists (
          select 1 from ${properties}
          where ${properties.customerId} = ${customers.id}
            and ${properties.orgId} = ${orgId}
            and ${foldedSql(properties.address)} like ${pattern}
        )
      )`;
    });
}

/**
 * Case- and accent-insensitive search over name, contacts (names, roles, phones, emails), and property
 * addresses. Every word of the query must match somewhere. A query that is only digits and phone
 * punctuation matches phone numbers by digits. Best matches first by name, at most 20. Archived
 * customers are left out unless `includeArchived`.
 */
export async function searchCustomers(
  orgId: string,
  query: string,
  options: { includeArchived?: boolean; limit?: number } = {},
): Promise<CustomerWithProperties[]> {
  if (!query.trim()) return [];
  const conditions = searchConditions(orgId, query);
  if (!conditions) return [];
  const rows = await db()
    .select()
    .from(customers)
    .where(and(eq(customers.orgId, orgId), options.includeArchived ? undefined : isNull(customers.archivedAt), ...conditions))
    .orderBy(asc(customers.name), asc(customers.id))
    .limit(Math.min(Math.max(Math.trunc(options.limit ?? SEARCH_LIMIT), 1), 50));
  return withDetails(orgId, rows);
}

export type CustomerListRow = Customer & { quoteCount: number; lastActivityAt: Date };

/**
 * Customers for the web app's list, most recently active first: an optional search (as
 * `searchCustomers`), each with how many quotes they have and when they or a quote last changed.
 * Archived customers are left out.
 */
export async function listCustomers(
  orgId: string,
  options: { query?: string; limit?: number } = {},
): Promise<CustomerListRow[]> {
  const conditions = options.query?.trim() ? searchConditions(orgId, options.query) : [];
  if (!conditions) return [];
  const quoteCount = sql<number>`count(${quotes.id})::int`;
  const lastQuoteAt = sql<Date | null>`max(${quotes.updatedAt})`.mapWith(quotes.updatedAt);
  const rows = await db()
    .select({ customer: customers, quoteCount, lastQuoteAt })
    .from(customers)
    .leftJoin(
      quotes,
      and(eq(quotes.orgId, orgId), eq(quotes.customerId, customers.id)),
    )
    .where(
      and(
        eq(customers.orgId, orgId),
        isNull(customers.archivedAt),
        ...conditions,
      ),
    )
    .groupBy(customers.id)
    .orderBy(desc(sql`greatest(${customers.updatedAt}, max(${quotes.updatedAt}))`), asc(customers.id))
    .limit(Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 200));
  return rows.map(({ customer, quoteCount, lastQuoteAt }) => ({
    ...customer,
    quoteCount,
    lastActivityAt: lastQuoteAt && lastQuoteAt > customer.updatedAt ? lastQuoteAt : customer.updatedAt,
  }));
}

/** One customer, archived or not, with their properties and contacts. */
export async function getCustomer(orgId: string, id: string, executor: Db | Tx = db()): Promise<CustomerWithProperties | null> {
  const [row] = await executor
    .select()
    .from(customers)
    .where(and(eq(customers.orgId, orgId), eq(customers.id, id)));
  if (!row) return null;
  return (await withDetails(orgId, [row], executor))[0];
}

// ---------------------------------------------------------------------------------------------
// Changes

export type ContactView = { id: string; name: string; role: string | null; phones: string[]; emails: string[]; preferred: boolean };

export function contactView(contact: Contact): ContactView {
  return {
    id: contact.id,
    name: contact.name,
    role: contact.role,
    phones: contact.phones,
    emails: contact.emails,
    preferred: contact.preferred,
  };
}

type Fields = { name: string; language: string; notes: string | null };
const fieldsOf = (c: Customer): Fields => ({ name: c.name, language: c.language, notes: c.notes });

async function recordChange(
  tx: Tx,
  input: { orgId: string; customerId: string; memberId: string | null; kind: string; before?: object | null; after?: object | null },
): Promise<void> {
  await tx.insert(customerChanges).values({
    id: newId("cch"),
    orgId: input.orgId,
    customerId: input.customerId,
    memberId: input.memberId,
    kind: input.kind,
    before: (input.before ?? null) as Record<string, unknown> | null,
    after: (input.after ?? null) as Record<string, unknown> | null,
    // A transaction's now() is one instant; the clock keeps a change's steps in order.
    createdAt: sql`clock_timestamp()`,
  });
}

/**
 * Locks the customer for a change. Throws `CUSTOMER_NOT_FOUND`; `REVISION_CHANGED` when the caller read
 * an older revision than the one saved; `CUSTOMER_ARCHIVED` for an archived one unless `allowArchived`.
 */
async function lockCustomer(
  tx: Tx,
  orgId: string,
  id: string,
  options: { expectedRevision?: number; allowArchived?: boolean } = {},
): Promise<Customer> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.orgId, orgId), eq(customers.id, id)))
    .for("update");
  if (!row) throw new Error("CUSTOMER_NOT_FOUND");
  if (options.expectedRevision !== undefined && row.revision !== options.expectedRevision) throw new Error("REVISION_CHANGED");
  if (row.archivedAt && !options.allowArchived) throw new Error("CUSTOMER_ARCHIVED");
  return row;
}

async function bumpRevision(tx: Tx, orgId: string, id: string, set: Partial<typeof customers.$inferInsert> = {}): Promise<void> {
  await tx
    .update(customers)
    .set({ ...set, revision: sql`${customers.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(customers.orgId, orgId), eq(customers.id, id)));
}

const unique = (values: string[]) => [...new Set(values)];

/**
 * Sets the customer's `phones` and `emails` to every contact's, preferred contact first. Always after the
 * contacts change, never before: the database files a value no contact holds under the preferred contact.
 */
export async function syncContactMirror(tx: Tx, orgId: string, customerId: string): Promise<void> {
  const people = await tx
    .select()
    .from(customerContacts)
    .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.customerId, customerId)))
    .orderBy(...contactOrder);
  await tx
    .update(customers)
    .set({ phones: unique(people.flatMap((c) => c.phones)), emails: unique(people.flatMap((c) => c.emails)) })
    .where(and(eq(customers.orgId, orgId), eq(customers.id, customerId)));
}

function cleanPhone(input: string): string {
  const phone = normalizeE164(input);
  if (!phone) throw new Error("INVALID_PHONE");
  return phone;
}

function cleanEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("INVALID_EMAIL");
  return email;
}

async function contactsOf(tx: Tx, orgId: string, customerId: string): Promise<Contact[]> {
  return tx
    .select()
    .from(customerContacts)
    .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.customerId, customerId)))
    .orderBy(...contactOrder);
}

/**
 * Adds phones and emails to one of the customer's contacts: `contactId`, else the preferred one, else a
 * new preferred contact named after the customer. Records the change. Returns whether anything was new.
 */
async function addToContact(
  tx: Tx,
  input: { orgId: string; customer: Customer; contactId?: string; phones: string[]; emails: string[]; memberId: string | null },
): Promise<boolean> {
  const { orgId, customer } = input;
  if (input.phones.length === 0 && input.emails.length === 0) return false;
  const people = await contactsOf(tx, orgId, customer.id);
  const target = input.contactId ? people.find((c) => c.id === input.contactId) : people[0];
  if (input.contactId && !target) throw new Error("CONTACT_NOT_FOUND");
  if (!target) {
    const [created] = await tx
      .insert(customerContacts)
      .values({
        id: newId("cont"),
        orgId,
        customerId: customer.id,
        name: customer.name,
        phones: unique(input.phones),
        emails: unique(input.emails),
        preferred: true,
      })
      .returning();
    await recordChange(tx, { orgId, customerId: customer.id, memberId: input.memberId, kind: "contact.added", after: contactView(created) });
    return true;
  }
  const phones = unique([...target.phones, ...input.phones]);
  const emails = unique([...target.emails, ...input.emails]);
  if (phones.length === target.phones.length && emails.length === target.emails.length) return false;
  const [updated] = await tx
    .update(customerContacts)
    .set({ phones, emails, updatedAt: new Date() })
    .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.id, target.id)))
    .returning();
  await recordChange(tx, {
    orgId,
    customerId: customer.id,
    memberId: input.memberId,
    kind: "contact.updated",
    before: contactView(target),
    after: contactView(updated),
  });
  return true;
}

export type PropertyView = { id: string; address: string; notes: string | null };

const propertyView = (p: Property): PropertyView => ({ id: p.id, address: p.address, notes: p.notes });

/**
 * Changes one of the customer's properties: its address, its notes (null or blank clears them), or both.
 * A new address is unplaced until the caller places it again. Records the change. Returns whether the
 * address changed, null when nothing did.
 */
async function changeProperty(
  tx: Tx,
  input: { orgId: string; customer: Customer; propertyId: string; address?: string; notes?: string | null; memberId: string | null },
): Promise<{ moved: boolean } | null> {
  const { orgId, customer } = input;
  const [existing] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.orgId, orgId), eq(properties.customerId, customer.id), eq(properties.id, input.propertyId)));
  if (!existing) throw new Error("PROPERTY_NOT_FOUND");
  const address = input.address?.trim() || existing.address;
  const notes = input.notes === undefined ? existing.notes : input.notes?.trim() || null;
  const moved = address !== existing.address;
  if (!moved && notes === existing.notes) return null;
  const [saved] = await tx
    .update(properties)
    .set({
      address,
      notes,
      // A place found for the old address isn't this one's; placing runs again once it's saved.
      ...(moved ? { lat: null, lng: null, placeLabel: null, geocodeStatus: "pending" as const, geocodedAt: null } : {}),
    })
    .where(and(eq(properties.orgId, orgId), eq(properties.id, existing.id)))
    .returning();
  await recordChange(tx, {
    orgId,
    customerId: customer.id,
    memberId: input.memberId,
    kind: "property.changed",
    before: propertyView(existing),
    after: propertyView(saved),
  });
  return { moved };
}

/**
 * Creates (no customerId; name required) or updates a customer. A phone or email is added to a contact
 * (`contactId`, else the preferred one, else a new one named after the customer); an address becomes a
 * property when that customer does not have it yet, or with `propertyId` replaces that property's address.
 * Every change is kept in the customer's history and moves its revision on. `expectedRevision` refuses a
 * change made from an older read.
 * Throws `NAME_REQUIRED`, `INVALID_PHONE`, `INVALID_EMAIL`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`,
 * `CONTACT_NOT_FOUND`, `PROPERTY_NOT_FOUND`, or `REVISION_CHANGED`.
 */
export async function saveCustomer(
  orgId: string,
  input: {
    customerId?: string;
    name?: string;
    phone?: string;
    email?: string;
    language?: Language;
    address?: string;
    notes?: string;
    contactId?: string;
    /** With `address`: the property whose address this is, in place of a new one. */
    propertyId?: string;
  },
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<CustomerWithProperties> {
  const phone = input.phone === undefined || input.phone.trim() === "" ? undefined : cleanPhone(input.phone);
  const email = input.email === undefined || input.email.trim() === "" ? undefined : cleanEmail(input.email);
  const address = input.address?.trim() || undefined;

  const toPlace: string[] = [];
  const id = await db().transaction(async (tx) => {
    let customer: Customer;
    let changed = false;
    if (input.customerId) {
      customer = await lockCustomer(tx, orgId, input.customerId, options);
      const before = fieldsOf(customer);
      const after: Fields = {
        name: input.name?.trim() || before.name,
        language: input.language ?? before.language,
        notes: input.notes !== undefined ? input.notes.trim() || null : before.notes,
      };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await tx
          .update(customers)
          .set({ name: after.name, language: after.language as Language, notes: after.notes })
          .where(and(eq(customers.orgId, orgId), eq(customers.id, customer.id)));
        await recordChange(tx, { orgId, customerId: customer.id, memberId, kind: "customer.updated", before, after });
        changed = true;
      }
    } else {
      if (!input.name?.trim()) throw new Error("NAME_REQUIRED");
      [customer] = await tx
        .insert(customers)
        .values({
          id: newId("cus"),
          orgId,
          name: input.name.trim(),
          language: input.language ?? (await businessLanguage(orgId, tx)),
          notes: input.notes?.trim() || null,
        })
        .returning();
      await recordChange(tx, { orgId, customerId: customer.id, memberId, kind: "customer.created", after: fieldsOf(customer) });
    }

    if (await addToContact(tx, { orgId, customer, contactId: input.contactId, phones: phone ? [phone] : [], emails: email ? [email] : [], memberId })) {
      changed = true;
    }

    if (address && input.propertyId) {
      const result = await changeProperty(tx, { orgId, customer, propertyId: input.propertyId, address, memberId });
      if (result?.moved) toPlace.push(input.propertyId);
      if (result) changed = true;
    } else if (address) {
      const existing = await tx
        .select()
        .from(properties)
        .where(and(eq(properties.orgId, orgId), eq(properties.customerId, customer.id)));
      if (!existing.some((p) => addressKey(p.address) === addressKey(address))) {
        const [property] = await tx.insert(properties).values({ id: newId("prop"), orgId, customerId: customer.id, address }).returning();
        await recordChange(tx, { orgId, customerId: customer.id, memberId, kind: "property.added", after: { id: property.id, address } });
        toPlace.push(property.id);
        changed = true;
      }
    }
    if (input.customerId && changed) await bumpRevision(tx, orgId, customer.id);
    await syncContactMirror(tx, orgId, customer.id);
    await recordEvent(
      { orgId, kind: input.customerId ? "customer.updated" : "customer.created", refId: customer.id, memberId },
      tx,
    );
    return customer.id;
  });
  // A new or moved property is placed for drive times once it's saved; a failure leaves it unplaced and saves anyway.
  for (const propertyId of toPlace) await placeProperty(orgId, propertyId);
  return (await getCustomer(orgId, id)) as CustomerWithProperties;
}

export type ContactInput = {
  customerId: string;
  /** Omit to add a contact. */
  contactId?: string;
  name?: string;
  /** Their part, in the member's word ("tenant", "property manager"); null clears it. */
  role?: string | null;
  addPhones?: string[];
  removePhones?: string[];
  addEmails?: string[];
  removeEmails?: string[];
  /** The contact quotes and emails go to first. */
  preferred?: boolean;
};

/**
 * Adds a contact to a customer (no `contactId`; a name is required) or changes one. Phones and emails are
 * added and removed by value; making one preferred makes the others not. The first contact is always
 * preferred. Throws `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`, `CONTACT_NOT_FOUND`, `CONTACT_NAME_REQUIRED`,
 * `INVALID_PHONE`, `INVALID_EMAIL`, or `REVISION_CHANGED`.
 */
export async function saveContact(
  orgId: string,
  input: ContactInput,
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<{ customer: CustomerWithProperties; contact: ContactView }> {
  const addPhones = (input.addPhones ?? []).filter((p) => p.trim()).map(cleanPhone);
  const removePhones = new Set((input.removePhones ?? []).map((p) => normalizeE164(p) ?? p.trim()));
  const addEmails = (input.addEmails ?? []).filter((e) => e.trim()).map(cleanEmail);
  const removeEmails = new Set((input.removeEmails ?? []).map((e) => e.trim().toLowerCase()));
  const role = input.role === undefined ? undefined : input.role?.trim() || null;

  const contactId = await db().transaction(async (tx) => {
    const customer = await lockCustomer(tx, orgId, input.customerId, options);
    const people = await contactsOf(tx, orgId, customer.id);
    const existing = input.contactId ? people.find((c) => c.id === input.contactId) : undefined;
    if (input.contactId && !existing) throw new Error("CONTACT_NOT_FOUND");
    if (!existing && !input.name?.trim()) throw new Error("CONTACT_NAME_REQUIRED");

    const preferred = input.preferred === true || people.length === 0 || (existing?.preferred ?? false);
    if (input.preferred === true) {
      await tx
        .update(customerContacts)
        .set({ preferred: false })
        .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.customerId, customer.id), ne(customerContacts.id, existing?.id ?? "")));
    }
    const phones = unique([...(existing?.phones ?? []).filter((p) => !removePhones.has(p)), ...addPhones]);
    const emails = unique([...(existing?.emails ?? []).filter((e) => !removeEmails.has(e)), ...addEmails]);

    let saved: Contact;
    if (existing) {
      [saved] = await tx
        .update(customerContacts)
        .set({
          name: input.name?.trim() || existing.name,
          role: role === undefined ? existing.role : role,
          phones,
          emails,
          preferred,
          updatedAt: new Date(),
        })
        .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.id, existing.id)))
        .returning();
      if (JSON.stringify(contactView(existing)) === JSON.stringify(contactView(saved))) return saved.id;
    } else {
      [saved] = await tx
        .insert(customerContacts)
        .values({ id: newId("cont"), orgId, customerId: customer.id, name: (input.name as string).trim(), role: role ?? null, phones, emails, preferred })
        .returning();
    }
    await recordChange(tx, {
      orgId,
      customerId: customer.id,
      memberId,
      kind: existing ? "contact.updated" : "contact.added",
      before: existing ? contactView(existing) : null,
      after: contactView(saved),
    });
    await bumpRevision(tx, orgId, customer.id);
    await syncContactMirror(tx, orgId, customer.id);
    return saved.id;
  });
  const customer = (await getCustomer(orgId, input.customerId)) as CustomerWithProperties;
  return { customer, contact: contactView(customer.contacts.find((c) => c.id === contactId) as Contact) };
}

/**
 * Removes one of a customer's contacts; their history keeps it. When it was the preferred one, the
 * oldest remaining contact becomes preferred. Throws `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`,
 * `CONTACT_NOT_FOUND`, or `REVISION_CHANGED`.
 */
export async function removeContact(
  orgId: string,
  input: { customerId: string; contactId: string },
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<CustomerWithProperties> {
  await db().transaction(async (tx) => {
    const customer = await lockCustomer(tx, orgId, input.customerId, options);
    const [removed] = await tx
      .delete(customerContacts)
      .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.customerId, customer.id), eq(customerContacts.id, input.contactId)))
      .returning();
    if (!removed) throw new Error("CONTACT_NOT_FOUND");
    if (removed.preferred) {
      const [next] = await contactsOf(tx, orgId, customer.id);
      if (next) {
        await tx
          .update(customerContacts)
          .set({ preferred: true })
          .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.id, next.id)));
      }
    }
    await recordChange(tx, { orgId, customerId: customer.id, memberId, kind: "contact.removed", before: contactView(removed) });
    await bumpRevision(tx, orgId, customer.id);
    await syncContactMirror(tx, orgId, customer.id);
  });
  return (await getCustomer(orgId, input.customerId)) as CustomerWithProperties;
}

/**
 * Changes one of a customer's properties: a corrected address (placed again for drive times once it's
 * saved), its notes (null or blank clears them), or both. Throws `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`,
 * `PROPERTY_NOT_FOUND`, or `REVISION_CHANGED`.
 */
export async function saveProperty(
  orgId: string,
  input: { customerId: string; propertyId: string; address?: string; notes?: string | null },
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<CustomerWithProperties> {
  const moved = await db().transaction(async (tx) => {
    const customer = await lockCustomer(tx, orgId, input.customerId, options);
    const result = await changeProperty(tx, { orgId, customer, propertyId: input.propertyId, address: input.address, notes: input.notes, memberId });
    if (!result) return false;
    await bumpRevision(tx, orgId, customer.id);
    return result.moved;
  });
  if (moved) await placeProperty(orgId, input.propertyId);
  return (await getCustomer(orgId, input.customerId)) as CustomerWithProperties;
}

/**
 * Removes one of a customer's properties; their history keeps it. One that a quote, a job, an invoice, or a
 * note is on stays: `PROPERTY_IN_USE:<count>`, so the records keep their address. Throws
 * `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`, `PROPERTY_NOT_FOUND`, `PROPERTY_IN_USE`, or `REVISION_CHANGED`.
 */
export async function removeProperty(
  orgId: string,
  input: { customerId: string; propertyId: string },
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<CustomerWithProperties> {
  await db().transaction(async (tx) => {
    const customer = await lockCustomer(tx, orgId, input.customerId, options);
    const [property] = await tx
      .select()
      .from(properties)
      .where(and(eq(properties.orgId, orgId), eq(properties.customerId, customer.id), eq(properties.id, input.propertyId)));
    if (!property) throw new Error("PROPERTY_NOT_FOUND");
    let uses = 0;
    for (const table of [quotes, serviceJobs, invoices, notes] as const) {
      const [row] = await tx
        .select({ n: count() })
        .from(table)
        .where(and(eq(table.orgId, orgId), eq(table.propertyId, property.id)));
      uses += row?.n ?? 0;
    }
    if (uses > 0) throw new Error(`PROPERTY_IN_USE:${uses}`);
    await tx.delete(properties).where(and(eq(properties.orgId, orgId), eq(properties.id, property.id)));
    await recordChange(tx, { orgId, customerId: customer.id, memberId, kind: "property.removed", before: propertyView(property) });
    await bumpRevision(tx, orgId, customer.id);
  });
  return (await getCustomer(orgId, input.customerId)) as CustomerWithProperties;
}

export type CustomerFootprint = { quotes: number; invoices: number; serviceJobs: number; notes: number; properties: number; contacts: number };

/** How much is on record for a customer: what an archive keeps and a merge moves. */
export async function customerFootprint(orgId: string, customerId: string, executor: Db | Tx = db()): Promise<CustomerFootprint> {
  const counted = async (table: typeof quotes | typeof invoices | typeof serviceJobs | typeof notes | typeof properties | typeof customerContacts) => {
    const [row] = await executor
      .select({ n: count() })
      .from(table)
      .where(and(eq(table.orgId, orgId), eq(table.customerId, customerId)));
    return row?.n ?? 0;
  };
  const [q, i, j, n, p, c] = await Promise.all([
    counted(quotes),
    counted(invoices),
    counted(serviceJobs),
    counted(notes),
    counted(properties),
    counted(customerContacts),
  ]);
  return { quotes: q, invoices: i, serviceJobs: j, notes: n, properties: p, contacts: c };
}

/**
 * Takes a customer off every list and search. Their quotes, invoices, work, and notes stay, still theirs,
 * and the customer page still opens from them. Throws `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`, or
 * `REVISION_CHANGED`.
 */
export async function archiveCustomer(
  orgId: string,
  customerId: string,
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<{ customer: CustomerWithProperties; kept: CustomerFootprint }> {
  await db().transaction(async (tx) => {
    await lockCustomer(tx, orgId, customerId, options);
    const at = new Date();
    await bumpRevision(tx, orgId, customerId, { archivedAt: at, archivedByMemberId: memberId });
    await recordChange(tx, { orgId, customerId, memberId, kind: "customer.archived", after: { archivedAt: at.toISOString() } });
    await recordEvent({ orgId, kind: "customer.archived", refId: customerId, memberId }, tx);
  });
  const [customer, kept] = await Promise.all([getCustomer(orgId, customerId), customerFootprint(orgId, customerId)]);
  return { customer: customer as CustomerWithProperties, kept };
}

/** Puts an archived customer back on the lists. One merged into another stays archived (`CUSTOMER_MERGED`). */
export async function restoreCustomer(
  orgId: string,
  customerId: string,
  memberId: string,
  options: { expectedRevision?: number } = {},
): Promise<CustomerWithProperties> {
  await db().transaction(async (tx) => {
    const customer = await lockCustomer(tx, orgId, customerId, { ...options, allowArchived: true });
    if (customer.mergedIntoId) throw new Error("CUSTOMER_MERGED");
    if (!customer.archivedAt) return;
    await bumpRevision(tx, orgId, customerId, { archivedAt: null, archivedByMemberId: null });
    await recordChange(tx, { orgId, customerId, memberId, kind: "customer.restored", before: { archivedAt: customer.archivedAt.toISOString() } });
  });
  return (await getCustomer(orgId, customerId)) as CustomerWithProperties;
}

export type MergeResult = {
  customer: CustomerWithProperties;
  merged: { id: string; name: string };
  moved: { quotes: number; invoices: number; serviceJobs: number; notes: number; conversations: number; properties: number; contacts: number };
};

/**
 * Merges `mergeId` into `keepId`, in one transaction: its quotes, invoices, work, notes, and job
 * conversations become the kept customer's; its properties move over, and one at an address the kept
 * customer already has folds into that one (everything on it moves too); its contacts move over, and
 * its own contact (named as it is) folds into the kept customer's own, as does any contact with the same
 * name. Its notes text is added to the kept customer's. Then it is archived, pointing at the kept one,
 * and both histories record the merge. Throws `SAME_CUSTOMER`, `CUSTOMER_NOT_FOUND`, `CUSTOMER_ARCHIVED`,
 * or `REVISION_CHANGED` (with `expectedRevisions`).
 */
export async function mergeCustomers(
  orgId: string,
  input: { keepId: string; mergeId: string },
  memberId: string,
  options: { expectedRevisions?: { keep?: number; merge?: number } } = {},
): Promise<MergeResult> {
  if (input.keepId === input.mergeId) throw new Error("SAME_CUSTOMER");
  const result = await db().transaction(async (tx) => {
    // Locked in id order, so two merges of the same pair can't deadlock.
    const order = [input.keepId, input.mergeId].sort();
    const locked = new Map<string, Customer>();
    for (const id of order) {
      const expected = id === input.keepId ? options.expectedRevisions?.keep : options.expectedRevisions?.merge;
      locked.set(id, await lockCustomer(tx, orgId, id, { expectedRevision: expected }));
    }
    const keep = locked.get(input.keepId) as Customer;
    const gone = locked.get(input.mergeId) as Customer;
    const before = { keep: await customerFootprint(orgId, keep.id, tx), merge: await customerFootprint(orgId, gone.id, tx) };

    // Properties: fold duplicates by address, move the rest.
    const keepProps = await tx.select().from(properties).where(and(eq(properties.orgId, orgId), eq(properties.customerId, keep.id)));
    const goneProps = await tx.select().from(properties).where(and(eq(properties.orgId, orgId), eq(properties.customerId, gone.id)));
    for (const prop of goneProps) {
      const twin = keepProps.find((p) => addressKey(p.address) === addressKey(prop.address));
      if (!twin) continue;
      for (const table of [quotes, serviceJobs, invoices, notes] as const) {
        await tx
          .update(table)
          .set({ propertyId: twin.id })
          .where(and(eq(table.orgId, orgId), eq(table.propertyId, prop.id)));
      }
      if (prop.notes?.trim() && prop.notes.trim() !== twin.notes?.trim()) {
        await tx
          .update(properties)
          .set({ notes: [twin.notes?.trim(), prop.notes.trim()].filter(Boolean).join("\n\n") })
          .where(and(eq(properties.orgId, orgId), eq(properties.id, twin.id)));
      }
      await tx.delete(properties).where(and(eq(properties.orgId, orgId), eq(properties.id, prop.id)));
    }
    await tx
      .update(properties)
      .set({ customerId: keep.id })
      .where(and(eq(properties.orgId, orgId), eq(properties.customerId, gone.id)));

    // Everything else that names the customer.
    const moveAll = async (table: typeof quotes | typeof invoices | typeof serviceJobs | typeof notes) =>
      (
        await tx
          .update(table)
          .set({ customerId: keep.id })
          .where(and(eq(table.orgId, orgId), eq(table.customerId, gone.id)))
          .returning({ id: table.id })
      ).length;
    const movedQuotes = await moveAll(quotes);
    const movedInvoices = await moveAll(invoices);
    const movedJobs = await moveAll(serviceJobs);
    const movedNotes = await moveAll(notes);
    const movedConversations = (
      await tx
        .update(conversations)
        .set({ customerId: keep.id })
        .where(and(eq(conversations.orgId, orgId), eq(conversations.customerId, gone.id)))
        .returning({ id: conversations.id })
    ).length;

    // Contacts: fold the merged customer's own contact and same-named ones, move the rest.
    const keepPeople = await contactsOf(tx, orgId, keep.id);
    const gonePeople = await contactsOf(tx, orgId, gone.id);
    const self = (c: Contact, owner: Customer) => fold(c.name.trim()) === fold(owner.name.trim());
    let movedContacts = 0;
    for (const person of gonePeople) {
      const twin =
        keepPeople.find((k) => fold(k.name.trim()) === fold(person.name.trim())) ??
        (self(person, gone) ? keepPeople.find((k) => self(k, keep)) : undefined);
      if (twin) {
        const phones = unique([...twin.phones, ...person.phones]);
        const emails = unique([...twin.emails, ...person.emails]);
        const [updated] = await tx
          .update(customerContacts)
          .set({ phones, emails, role: twin.role ?? person.role, updatedAt: new Date() })
          .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.id, twin.id)))
          .returning();
        twin.phones = updated.phones;
        twin.emails = updated.emails;
        await tx.delete(customerContacts).where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.id, person.id)));
      } else {
        await tx
          .update(customerContacts)
          .set({ customerId: keep.id, preferred: keepPeople.length === 0 && person.preferred, updatedAt: new Date() })
          .where(and(eq(customerContacts.orgId, orgId), eq(customerContacts.id, person.id)));
        movedContacts++;
      }
    }

    const notesText =
      gone.notes?.trim() && gone.notes.trim() !== keep.notes?.trim() ? [keep.notes?.trim(), gone.notes.trim()].filter(Boolean).join("\n\n") : keep.notes;
    const at = new Date();
    await bumpRevision(tx, orgId, keep.id, { notes: notesText });
    await bumpRevision(tx, orgId, gone.id, { archivedAt: at, archivedByMemberId: memberId, mergedIntoId: keep.id });
    await syncContactMirror(tx, orgId, keep.id);
    await syncContactMirror(tx, orgId, gone.id);

    const moved = {
      quotes: movedQuotes,
      invoices: movedInvoices,
      serviceJobs: movedJobs,
      notes: movedNotes,
      conversations: movedConversations,
      properties: goneProps.length,
      contacts: movedContacts,
    };
    await recordChange(tx, {
      orgId,
      customerId: keep.id,
      memberId,
      kind: "customer.merged",
      before: { ...fieldsOf(keep), footprint: before.keep },
      after: { from: { id: gone.id, ...fieldsOf(gone) }, moved },
    });
    await recordChange(tx, {
      orgId,
      customerId: gone.id,
      memberId,
      kind: "customer.merged_into",
      before: { ...fieldsOf(gone), footprint: before.merge },
      after: { into: { id: keep.id, name: keep.name } },
    });
    await recordEvent({ orgId, kind: "customer.merged", refId: keep.id, memberId, data: { mergedId: gone.id, moved } }, tx);
    return { merged: { id: gone.id, name: gone.name }, moved };
  });
  return { customer: (await getCustomer(orgId, input.keepId)) as CustomerWithProperties, ...result };
}

export type CustomerChange = {
  id: string;
  kind: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  memberName: string | null;
  createdAt: Date;
};

/** A customer's history, newest first. */
export async function customerHistory(orgId: string, customerId: string, limit = 50): Promise<CustomerChange[]> {
  const rows = await db()
    .select({ change: customerChanges, memberName: members.name })
    .from(customerChanges)
    .leftJoin(members, and(eq(members.orgId, orgId), eq(members.id, customerChanges.memberId)))
    .where(and(eq(customerChanges.orgId, orgId), eq(customerChanges.customerId, customerId)))
    .orderBy(desc(customerChanges.createdAt), desc(customerChanges.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(({ change, memberName }) => ({
    id: change.id,
    kind: change.kind,
    before: change.before ?? null,
    after: change.after ?? null,
    memberName,
    createdAt: change.createdAt,
  }));
}

/** A customer as the assistant's tools return it. */
export function customerForTool(c: CustomerWithProperties) {
  return {
    id: c.id,
    name: c.name,
    language: c.language,
    notes: c.notes,
    revision: c.revision,
    archived: c.archivedAt !== null,
    ...(c.mergedIntoId ? { mergedIntoId: c.mergedIntoId } : {}),
    contacts: c.contacts.map(contactView),
    properties: c.properties.map((p) => ({ id: p.id, address: p.address })),
  };
}
