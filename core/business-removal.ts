import { and, eq, inArray, is, isNull, sql, type SQL } from "drizzle-orm";
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import * as schema from "../schema/schema";
import { account, authMember, memberPhones, members, organization, session, stripeAccounts, user } from "../schema/schema";
import { agentMailGateway } from "./agentmail";
import { deleteBlob } from "./blob";
import { db } from "./db";
import { setSuspended } from "./organizations";
import { createPhotonAdmin, type PhotonAdmin } from "./photon-admin";

// Deleting a business, for super admins: everything it has here and at the providers. Its phones'
// Photon registrations, its email inbox, its stored files (PDFs, photos, logo), then every row, so
// nothing of it is left to find. Its Stripe account is the business's own (Connect, Standard), so only
// our link to it goes. Eve's own copy of its conversations stays with eve; nothing points to it after.

/** Every table a business owns rows in, each before the tables it references: the order to delete in. */
export const businessTables: Array<{ name: string; table: PgTable; column: PgColumn }> = (() => {
  const owned = (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable) && value !== organization)
    .flatMap((table) => {
      const config = getTableConfig(table);
      const column = config.columns.find((c) => c.name === "org_id" || c.name === "organization_id");
      return column ? [{ name: config.name, table, column, refs: config.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name) }] : [];
    });
  const ordered: typeof owned = [];
  const left = new Set(owned);
  while (left.size) {
    const ready = [...left].filter((t) => ![...left].some((other) => other !== t && other.refs.includes(t.name)));
    if (!ready.length) throw new Error(`business tables reference each other in a cycle: ${[...left].map((t) => t.name).join(", ")}`);
    for (const t of ready) {
      ordered.push(t);
      left.delete(t);
    }
  }
  return ordered.map(({ name, table, column }) => ({ name, table, column }));
})();

/**
 * Where the app saves a stored file's URL, and only there: a URL typed into a note, a text, or an email
 * is someone's words, not a file this business owns, so it's never read from them. Each source lists the
 * URLs it holds for the businesses matching `orgs`.
 */
const FILE_SOURCES: Array<(orgs: SQL) => SQL> = [
  (orgs) => sql`select logo as url from organization where logo is not null and id ${orgs}`,
  (orgs) => sql`select pdf_url as url from quote_revisions where pdf_url is not null and org_id ${orgs}`,
  (orgs) => sql`select pdf_url as url from invoices where pdf_url is not null and org_id ${orgs}`,
  (orgs) => sql`select url from quote_attachments where org_id ${orgs}`,
  (orgs) => sql`select url from work_photos where org_id ${orgs}`,
  (orgs) => sql`select e->>'url' as url from messages, jsonb_array_elements(attachments) e where org_id ${orgs}`,
  (orgs) => sql`select e->>'url' as url from notes, jsonb_array_elements(files) e where org_id ${orgs}`,
];

const STORED = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;

/** The stored files the business's rows point to, less any another business's rows point to too. */
async function filesOf(orgId: string): Promise<string[]> {
  const urls = new Set<string>();
  for (const source of FILE_SOURCES) {
    for (const { url } of await db().execute<{ url: string | null }>(source(sql`= ${orgId}`))) if (url && STORED.test(url)) urls.add(url);
  }
  if (!urls.size) return [];
  const list = [...urls];
  for (const source of FILE_SOURCES) {
    const shared = await db().execute<{ url: string }>(sql`select url from (${source(sql`<> ${orgId}`)}) s where url in (${sql.join(list.map((u) => sql`${u}`), sql`, `)})`);
    for (const { url } of shared) urls.delete(url);
  }
  return [...urls].sort();
}

/** What deleting a business removes, for the super admin to read before they do it. */
export type BusinessFootprint = {
  id: string;
  name: string;
  /** Every row the business owns. */
  records: number;
  members: number;
  /** Its members' numbers (E.164), whose Photon registrations go. */
  phones: string[];
  inboxAddress: string | null;
  /** Its Stripe link's status, when it connected one. */
  stripe: string | null;
  /** Stored files only it points to: quote and invoice PDFs, photos, attachments, note files, the logo. */
  files: string[];
  /** Web sign-ins that belong to no other business, which go with it. */
  signIns: string[];
};

export async function businessFootprint(orgId: string): Promise<BusinessFootprint | null> {
  const [org] = await db().select().from(organization).where(eq(organization.id, orgId));
  if (!org) return null;
  let records = 0;
  for (const { name, column } of businessTables) {
    const [row] = await db().execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(name)} where ${sql.identifier(column.name)} = ${orgId}`);
    records += row.n;
  }
  const memberRows = await db().select({ id: members.id, userId: members.userId }).from(members).where(eq(members.orgId, orgId));
  const phones = await db().select({ e164: memberPhones.e164 }).from(memberPhones).where(eq(memberPhones.orgId, orgId));
  const [stripe] = await db().select({ status: stripeAccounts.status }).from(stripeAccounts).where(eq(stripeAccounts.orgId, orgId));
  return {
    id: org.id,
    name: org.name,
    records,
    members: memberRows.length,
    phones: phones.map((p) => p.e164).sort(),
    inboxAddress: org.inboxAddress,
    stripe: stripe?.status ?? null,
    files: await filesOf(orgId),
    signIns: await signInsOnlyHere(orgId, memberRows.flatMap((m) => (m.userId ? [m.userId] : []))),
  };
}

/** The business's members' sign-ins that no other business has, and that aren't a super admin's. */
async function signInsOnlyHere(orgId: string, userIds: string[]): Promise<string[]> {
  const auth = await db().select({ userId: authMember.userId }).from(authMember).where(eq(authMember.organizationId, orgId));
  const candidates = [...new Set([...userIds, ...auth.map((a) => a.userId)])];
  if (!candidates.length) return [];
  const plain = await db().select({ id: user.id }).from(user).where(and(inArray(user.id, candidates), isNull(user.role)));
  const elsewhere = [
    ...(await db().select({ id: members.userId }).from(members).where(and(inArray(members.userId, candidates), sql`${members.orgId} <> ${orgId}`))),
    ...(await db().select({ id: authMember.userId }).from(authMember).where(and(inArray(authMember.userId, candidates), sql`${authMember.organizationId} <> ${orgId}`))),
  ].map((r) => r.id);
  return plain.map((u) => u.id).filter((id) => !elsewhere.includes(id)).sort();
}

export type RemovalDeps = { photon?: PhotonAdmin; deleteFile?: (url: string) => Promise<void> };

/**
 * Deletes the business. Pauses it first, so nothing new starts, and clears the providers before the
 * rows: if a provider fails, the business is still here (paused) to try again, and each provider step
 * treats what's already gone as done.
 */
export async function deleteBusiness(orgId: string, deps: RemovalDeps = {}): Promise<BusinessFootprint> {
  const before = await businessFootprint(orgId);
  if (!before) throw new Error("NO_SUCH_BUSINESS");
  await setSuspended(orgId, true);
  const [org] = await db().select({ inboxId: organization.inboxId }).from(organization).where(eq(organization.id, orgId));

  const photon = deps.photon ?? createPhotonAdmin();
  for (const e164 of before.phones) await photon.removeSharedUser(e164);
  if (org?.inboxId) await agentMailGateway().deleteInbox(org.inboxId);
  const deleteFile = deps.deleteFile ?? deleteBlob;
  for (const url of before.files) await deleteFile(url);

  await db().transaction(async (tx) => {
    // Locks the business, so a row being added for it now waits, then finds it gone.
    await tx.select({ id: organization.id }).from(organization).where(eq(organization.id, orgId)).for("update");
    const signIns = await signInsOnlyHere(orgId, (await tx.select({ userId: members.userId }).from(members).where(eq(members.orgId, orgId))).flatMap((m) => (m.userId ? [m.userId] : [])));
    for (const { table, column } of businessTables) await tx.delete(table).where(eq(column, orgId));
    if (signIns.length) {
      await tx.delete(session).where(inArray(session.userId, signIns));
      await tx.delete(account).where(inArray(account.userId, signIns));
      await tx.delete(user).where(inArray(user.id, signIns));
    }
    await tx.update(session).set({ activeOrganizationId: null }).where(eq(session.activeOrganizationId, orgId));
    await tx.delete(organization).where(eq(organization.id, orgId));
  });
  console.info("business-removal: deleted a business", {
    orgId,
    records: before.records,
    phones: before.phones.length,
    inbox: Boolean(before.inboxAddress),
    files: before.files.length,
    signIns: before.signIns.length,
  });
  return before;
}
