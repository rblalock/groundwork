import { z } from "zod";
import { addTeamMember, listTeam, removeTeamMember, setForwardingEmail, updateTeamMember, type ForwardingResult, type TeamMember } from "../../core/team";
import { languageSchema } from "../../core/tool-schemas";
import { HttpError, memberCaller, type AppCaller } from "../guards";
import { pageCopyFor } from "../page-copy";
import { privilegedActor, refuse } from "./access";

/** The team page, for owners and admins (and super admins looking). */
export async function teamFor(caller: AppCaller): Promise<TeamMember[]> {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  return listTeam(caller.orgId);
}

export const addMemberSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(1).max(40),
    role: z.enum(["member", "admin"]).default("member"),
    language: languageSchema.optional(),
  })
  .strict();

export type AddMemberResult = {
  member: { id: string; name: string; role: string };
  alreadyActive: boolean;
  roleKept: boolean;
  /** The text to forward; null when they're already on the team and texting. */
  invite: string | null;
  line: string | null;
};

/**
 * Adds someone through the same path as add_member: their phone is registered with Photon and the
 * invite comes back to forward. Nothing texts them, and here nothing texts the asker either: the
 * page shows the invite.
 */
export async function addMemberFromApp(
  caller: AppCaller,
  input: z.infer<typeof addMemberSchema>,
): Promise<AddMemberResult> {
  const actor = privilegedActor(caller);
  const errors = pageCopyFor(caller.language).team.errors;
  try {
    const added = await addTeamMember(actor, input, { postInvite: false });
    return {
      member: { id: added.member.id, name: added.member.name, role: added.member.role },
      alreadyActive: added.alreadyActive,
      roleKept: added.roleChange === "unchanged_owner",
      invite: added.invite,
      line: added.assignedLine,
    };
  } catch (error) {
    refuse(error, { INVALID_PHONE: [400, errors.invalidPhone], PHONE_IN_USE: [409, errors.phoneInUse], NOT_PRIVILEGED: [403, errors.outranked] });
  }
}

/** Removes someone below the caller through `removeTeamMember`, which keeps the last owner. */
export async function removeMemberFromApp(caller: AppCaller, memberId: string): Promise<void> {
  const actor = privilegedActor(caller);
  const errors = pageCopyFor(caller.language).team.errors;
  try {
    await removeTeamMember(actor, memberId);
  } catch (error) {
    refuse(error, { MEMBER_NOT_FOUND: [404, errors.notFound], LAST_OWNER: [409, errors.lastOwner], NOT_PRIVILEGED: [403, errors.outranked] });
  }
}

export const memberEmailSchema = z.object({ email: z.string().trim().max(200) }).strict();

/** A change to someone's name, language, or role from the Team page; anything left out stays. */
export const memberUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    language: languageSchema.optional(),
    role: z.enum(["member", "admin"]).optional(),
  })
  .strict();

/** The Account page's change to the member's own name or language. */
export const ownProfileSchema = memberUpdateSchema.omit({ role: true });

const updateErrors = (caller: AppCaller) => {
  const errors = pageCopyFor(caller.language).team.errors;
  return {
    MEMBER_NOT_FOUND: [404, errors.notFound],
    NOT_PRIVILEGED: [403, errors.outranked],
    ROLE_OWNER_ONLY: [403, errors.roleOwnerOnly],
    OWN_ROLE: [403, errors.ownRole],
    IS_OWNER: [409, errors.isOwner],
  } as const;
};

export type UpdatedMember = { id: string; name: string; role: string; language: string };

/**
 * An owner or admin changes someone's name, language, or role through `updateTeamMember`: name and
 * language for themself or anyone below them, and roles only by the owner.
 */
export async function updateMemberFromApp(
  caller: AppCaller,
  memberId: string,
  update: z.infer<typeof memberUpdateSchema>,
): Promise<UpdatedMember> {
  const actor = privilegedActor(caller);
  try {
    const member = await updateTeamMember(actor, memberId, update);
    return { id: member.id, name: member.name, role: member.role, language: member.language };
  } catch (error) {
    refuse(error, updateErrors(caller));
  }
}

/** A signed-in member changes their own name or language. */
export async function updateOwnProfileFromApp(caller: AppCaller, update: z.infer<typeof ownProfileSchema>): Promise<UpdatedMember> {
  const member = memberCaller(caller);
  try {
    const updated = await updateTeamMember(member, member.memberId, update);
    return { id: updated.id, name: updated.name, role: updated.role, language: updated.language };
  } catch (error) {
    refuse(error, updateErrors(caller));
  }
}

const emailErrors = (caller: AppCaller) => {
  const errors = pageCopyFor(caller.language).team.errors;
  return {
    INVALID_EMAIL: [400, errors.invalidEmail],
    EMAIL_IN_USE: [409, errors.emailInUse],
    EMAIL_IS_CUSTOMER: [409, errors.emailIsCustomer],
    MEMBER_NOT_FOUND: [404, errors.notFound],
    NOT_PRIVILEGED: [403, errors.emailOutranked],
    EMAIL_NO_INBOX: [409, errors.emailNoInbox],
    EMAIL_CLAIM_LIMIT: [429, errors.emailClaimLimit],
  } as const;
};

export type ForwardingJson = {
  id: string;
  /** The address that's on. */
  email: string | null;
  /** The address waiting on its code. `code` only for the member themself. */
  pending: { address: string; inbox: string; expiresAt: string; code?: string } | null;
  codeTexted: boolean;
};

const forwardingJson = (result: ForwardingResult): ForwardingJson => ({
  id: result.member.id,
  email: result.member.email,
  pending: result.pending && { ...result.pending, expiresAt: result.pending.expiresAt.toISOString() },
  codeTexted: result.codeTexted,
});

/**
 * An owner or admin asks for the address a member forwards emails from (blank removes it): only for
 * someone they outrank. The code goes to that member by text and never comes back here, unless the member
 * is the caller (`setForwardingEmail`).
 */
export async function setMemberEmailFromApp(caller: AppCaller, memberId: string, email: string): Promise<ForwardingJson> {
  const actor = privilegedActor(caller);
  try {
    return forwardingJson(await setForwardingEmail(actor, memberId, email || null));
  } catch (error) {
    refuse(error, emailErrors(caller));
  }
}

/** A signed-in member asks for their own forwarding address; the page shows them its code once. */
export async function setOwnEmailFromApp(caller: AppCaller, email: string): Promise<ForwardingJson> {
  const member = memberCaller(caller);
  try {
    return forwardingJson(await setForwardingEmail(member, member.memberId, email || null));
  } catch (error) {
    refuse(error, emailErrors(caller));
  }
}
