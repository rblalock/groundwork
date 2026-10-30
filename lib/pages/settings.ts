import { and, desc, eq } from "drizzle-orm";
import { events } from "../../schema/schema";
import { agentMailMode } from "../../core/agentmail";
import { db } from "../../core/db";
import { glossarySchema, listGlossary, replaceGlossary, type GlossaryTerm } from "../../core/glossary";
import { getOrganization } from "../../core/organizations";
import { assertMayPatchProfile, getProfile, updateProfile, type Profile, type ProfilePatch } from "../../core/profile";
import { profilePatchSchema } from "../../core/tool-schemas";
import type { SettingsValues } from "../../components/pages/settings-form";
import { HttpError, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { privilegedActor, refuse } from "./access";

export { profilePatchSchema };

/** The settings form's values, from the business profile. */
export function settingsValues(profile: Profile): SettingsValues {
  return {
    name: profile.name,
    phone: profile.phone,
    email: profile.email,
    address: profile.address,
    licenseNumber: profile.licenseNumber,
    timeZone: profile.timeZone,
    quietStartHour: profile.quietStartHour,
    quietEndHour: profile.quietEndHour,
    quoteValidityDays: profile.quoteValidityDays,
    followUpDays: profile.followUpDays,
    minimumChargeCents: profile.minimumChargeCents,
    taxRateBp: profile.taxRateBp,
    paymentTermsDays: profile.paymentTermsDays,
    depositPercent: profile.depositPercent,
    customerLinePrices: profile.customerLinePrices,
    language: profile.language === "es" ? "es" : "en",
    townMph: profile.townMph,
    roadFactorBp: profile.roadFactorBp,
    minDriveMinutes: profile.minDriveMinutes,
    capacityBp: profile.capacityBp,
    yard: { status: profile.yardGeocodeStatus, label: profile.yardPlaceLabel },
  };
}

/** The business profile, for owners and admins. */
export async function settingsFor(caller: AppCaller): Promise<Profile> {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  return getProfile(caller.orgId);
}

const FIELDS = [
  "name",
  "phone",
  "email",
  "address",
  "licenseNumber",
  "timeZone",
  "quietStartHour",
  "quietEndHour",
  "quoteValidityDays",
  "followUpDays",
  "minimumChargeCents",
  "taxRateBp",
  "paymentTermsDays",
  "depositPercent",
  "customerLinePrices",
  "language",
  "townMph",
  "roadFactorBp",
  "minDriveMinutes",
  "capacityBp",
] as const satisfies readonly (keyof ProfilePatch)[];

/**
 * Saves the fields that differ from what's stored, through `updateProfile` (the same as update_profile).
 * Saving an unchanged form changes nothing, so the profile's version, which marks quotes stale, holds.
 */
export async function updateSettingsFromApp(
  caller: AppCaller,
  patch: ProfilePatch,
): Promise<{ profile: Profile; changed: string[] }> {
  const actor = privilegedActor(caller);
  const current = await getProfile(caller.orgId);
  const changes = Object.fromEntries(
    FIELDS.filter((field) => patch[field] !== undefined && patch[field] !== current[field]).map((field) => [field, patch[field]]),
  ) as ProfilePatch;
  const changed = Object.keys(changes);
  if (changed.length === 0) return { profile: current, changed };
  try {
    assertMayPatchProfile(actor.role, changes);
  } catch (error) {
    refuse(error, { OWNER_ONLY: [403, pageCopyFor(caller.language).settings.errors.ownerOnly] });
  }
  return { profile: await updateProfile(caller.orgId, changes, actor.memberId), changed };
}

/** The business's glossary, for owners and admins. */
export async function glossaryFor(caller: AppCaller): Promise<GlossaryTerm[]> {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  return listGlossary(caller.orgId);
}

/** Replaces the glossary with the Settings page's list, through `replaceGlossary` (the same checks as by text). */
export async function replaceGlossaryFromApp(caller: AppCaller, body: unknown): Promise<GlossaryTerm[]> {
  const actor = privilegedActor(caller);
  const errors = pageCopyFor(caller.language).settings.glossary.errors;
  const parsed = glossarySchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "GLOSSARY_INVALID", errors.GLOSSARY_INVALID);
  try {
    return await replaceGlossary(actor, parsed.data.terms);
  } catch (error) {
    refuse(error, { GLOSSARY_DUPLICATE: [400, errors.GLOSSARY_DUPLICATE], GLOSSARY_INVALID: [400, errors.GLOSSARY_INVALID] });
  }
}

export type EmailForwarding = {
  /** Whether the app has AgentMail set up at all (its keys, or the fake). */
  available: boolean;
  fake: boolean;
  /** The business's inbox, once a super admin has made it. */
  address: string | null;
};

/** An email that was dropped, as Settings → Email lists it: never its body, only who, what about, and why. */
export type DroppedEmail = { id: string; at: string; from: string | null; subject: string; reason: string };

const DROPPED_SHOWN = 50;

/**
 * The business's latest dropped emails (`email.dropped` events, core/email-intake.ts), for owners
 * and admins: when, from what address, the subject, and the reason code. Nothing for crew.
 */
export async function droppedEmailsFor(caller: AppCaller): Promise<DroppedEmail[]> {
  if (caller.role === "member") return [];
  const rows = await db()
    .select({ id: events.id, at: events.createdAt, data: events.data })
    .from(events)
    .where(and(eq(events.orgId, caller.orgId), eq(events.kind, "email.dropped")))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(DROPPED_SHOWN);
  return rows.map(({ id, at, data }) => ({
    id,
    at: at.toISOString(),
    from: typeof data.from === "string" ? data.from.slice(0, 200) : null,
    subject: typeof data.subject === "string" ? data.subject.slice(0, 120) : "",
    reason: typeof data.reason === "string" ? data.reason : "unknown",
  }));
}

/** Where the business's members forward emails, for Settings and the Account page. */
export async function emailForwardingFor(orgId: string): Promise<EmailForwarding> {
  const mode = agentMailMode();
  const org = await getOrganization(orgId);
  return { available: mode !== null, fake: mode === "fake", address: org?.inboxAddress ?? null };
}
