// Proving a forwarding address is the member's before their emails count as theirs. Setting an address,
// by the member or by someone above them, only makes it pending, with a short code texted to the member.
// The address turns on when an email that verifies as sent from it (core/email-auth.ts) reaches the
// business's inbox with exactly the code as its subject, and is neither a reply nor a forward
// (core/email-intake.ts). The body is never read for it. So nobody can claim an address they can't
// send from: a crew member can't make the owner's Gmail land in their own thread, not even by getting the
// owner to forward them an email with the code in it. When an address turns on, the owners hear too.
//
// Only a keyed hash of the code is stored, it expires in a day, a claim locks after a few wrong codes,
// and a member can start only a few claims a day.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, gte, ne, sql } from "drizzle-orm";
import { emailClaims, members } from "../schema/schema";
import { db, newId } from "./db";

export const CLAIM_TTL_MS = 24 * 60 * 60_000;
/** Wrong codes before a claim locks; setting the address again starts over. */
export const CLAIM_MAX_ATTEMPTS = 5;
/** Claims one member can start in a day (each texts a code). */
export const CLAIMS_PER_DAY = 5;

export type EmailClaim = typeof emailClaims.$inferSelect;
export type StartedClaim = { claimId: string; address: string; code: string; expiresAt: Date };

// No 0/O, 1/I/L: read off a phone and typed into a subject line.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A code like `K7QM-4ZPX`: about 40 bits. */
export function newClaimCode(): string {
  const pick = () => ALPHABET[randomInt(0, ALPHABET.length)];
  const half = () => Array.from({ length: 4 }, pick).join("");
  return `${half()}-${half()}`;
}

function hashKey(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) return secret;
  if (process.env.VERCEL_ENV === "production") throw new Error("BETTER_AUTH_SECRET must be set.");
  return "local-dev-email-claim-key";
}

/** Keyed by the auth secret and bound to the claim, so a leaked table can't be checked offline or reused. */
const hashCode = (claimId: string, code: string) => createHmac("sha256", hashKey()).update(`email-claim:${claimId}:${code}`).digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The code an email's subject is, when it's exactly one (`k7qm-4zpx` reads as `K7QM-4ZPX`), else null.
 * Nothing else counts: not a code inside a longer subject, a `Fwd:` or `Re:` in front, or the body.
 */
export function subjectCode(subject: string | null | undefined): string | null {
  const trimmed = (subject ?? "").trim().toUpperCase();
  return new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`).test(trimmed) ? trimmed : null;
}

/** The member's live pending claim (not expired), if any. */
export async function pendingClaimOf(orgId: string, memberId: string, now: Date = new Date()): Promise<EmailClaim | null> {
  const [row] = await db()
    .select()
    .from(emailClaims)
    .where(and(eq(emailClaims.orgId, orgId), eq(emailClaims.memberId, memberId), eq(emailClaims.status, "pending"), gt(emailClaims.expiresAt, now)));
  return row ?? null;
}

/** The live pending claim on `address` in this business, if any: what a confirming email is checked against. */
export async function pendingClaimFor(orgId: string, address: string, now: Date = new Date()): Promise<EmailClaim | null> {
  const [row] = await db()
    .select()
    .from(emailClaims)
    .where(and(eq(emailClaims.orgId, orgId), eq(emailClaims.address, address.toLowerCase()), eq(emailClaims.status, "pending"), gt(emailClaims.expiresAt, now)));
  return row ?? null;
}

/** True when another member of the business has a live claim on `address`. */
export async function claimedByAnother(orgId: string, memberId: string, address: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db()
    .select({ id: emailClaims.id })
    .from(emailClaims)
    .where(
      and(
        eq(emailClaims.orgId, orgId),
        eq(emailClaims.address, address.toLowerCase()),
        ne(emailClaims.memberId, memberId),
        eq(emailClaims.status, "pending"),
        gt(emailClaims.expiresAt, now),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Cancels the member's pending claims: a new one replaces them, and clearing the address ends them. */
export async function cancelClaims(orgId: string, memberId: string): Promise<void> {
  await db()
    .update(emailClaims)
    .set({ status: "cancelled" })
    .where(and(eq(emailClaims.orgId, orgId), eq(emailClaims.memberId, memberId), eq(emailClaims.status, "pending")));
}

/**
 * Starts a claim on `address` for the member, replacing any pending one, and returns its code: the only
 * time it exists in the clear. Throws `EMAIL_CLAIM_LIMIT` past the day's claims.
 */
export async function startClaim(
  input: { orgId: string; memberId: string; address: string; setByMemberId: string },
  now: Date = new Date(),
): Promise<StartedClaim> {
  const [{ value: today }] = await db()
    .select({ value: count() })
    .from(emailClaims)
    .where(and(eq(emailClaims.orgId, input.orgId), eq(emailClaims.memberId, input.memberId), gte(emailClaims.createdAt, new Date(now.getTime() - CLAIM_TTL_MS))));
  if (today >= CLAIMS_PER_DAY) throw new Error("EMAIL_CLAIM_LIMIT");
  await cancelClaims(input.orgId, input.memberId);
  const claimId = newId("ecl");
  const code = newClaimCode();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS);
  await db()
    .insert(emailClaims)
    .values({
      id: claimId,
      orgId: input.orgId,
      memberId: input.memberId,
      address: input.address.toLowerCase(),
      codeHash: hashCode(claimId, code),
      setByMemberId: input.setByMemberId,
      expiresAt,
      createdAt: now,
    });
  return { claimId, address: input.address.toLowerCase(), code, expiresAt };
}

export type ClaimResult = "confirmed" | "wrong_code" | "locked" | "expired" | "taken";

/**
 * Checks one code, from a verified email's subject (`subjectCode`), against the claim's. The right one
 * makes the address the member's forwarding email (unless another member took it meanwhile: `taken`); a
 * wrong one counts, and the claim locks at the limit. Serialized on the claim's row.
 */
export async function confirmClaim(claim: Pick<EmailClaim, "id" | "orgId">, code: string, now: Date = new Date()): Promise<ClaimResult> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(emailClaims)
      .where(and(eq(emailClaims.orgId, claim.orgId), eq(emailClaims.id, claim.id)))
      .for("update");
    if (!row || row.status !== "pending") return "expired";
    if (row.expiresAt <= now) return "expired";
    const match = sameHash(row.codeHash, hashCode(row.id, code));
    if (!match) {
      const attempts = row.attempts + 1;
      await tx
        .update(emailClaims)
        .set({ attempts, ...(attempts >= CLAIM_MAX_ATTEMPTS ? { status: "locked" } : {}) })
        .where(and(eq(emailClaims.orgId, row.orgId), eq(emailClaims.id, row.id)));
      return attempts >= CLAIM_MAX_ATTEMPTS ? "locked" : "wrong_code";
    }
    const [other] = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.orgId, row.orgId), sql`lower(${members.email}) = ${row.address}`, ne(members.id, row.memberId)));
    if (other) {
      await tx.update(emailClaims).set({ status: "cancelled" }).where(and(eq(emailClaims.orgId, row.orgId), eq(emailClaims.id, row.id)));
      return "taken";
    }
    await tx
      .update(members)
      .set({ email: row.address, emailSetByMemberId: row.setByMemberId, emailSetAt: now })
      .where(and(eq(members.orgId, row.orgId), eq(members.id, row.memberId)));
    await tx
      .update(emailClaims)
      .set({ status: "confirmed", confirmedAt: now })
      .where(and(eq(emailClaims.orgId, row.orgId), eq(emailClaims.id, row.id)));
    return "confirmed";
  });
}
