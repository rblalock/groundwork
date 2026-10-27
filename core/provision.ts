import { z } from "zod";
import { addPhone, createMember, findMemberByPhone, normalizeE164, setPhonePhoton, type Role } from "./members";
import {
  createOrganization,
  findOrganizationBySlug,
  getOrganization,
  slugify,
  type Organization,
} from "./organizations";
import type { PhotonAdmin } from "./photon-admin";
import { updateProfile } from "./profile";

// Setting up a business after the sales call. `scripts/provision.ts` and the web app's admin page both
// come here, so a business is never created any other way: `getProfile` would otherwise make a
// placeholder "This business" profile for it.

const text = z.string().trim().min(1);
const language = z.enum(["en", "es"]);
const phone = z
  .string()
  .transform((value, ctx) => {
    const normalized = normalizeE164(value);
    if (!normalized) ctx.addIssue({ code: "custom", message: `"${value}" is not a phone number` });
    return normalized ?? value;
  });
const hour = z.number().int().min(0).max(23);
const timeZone = text.refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a valid IANA time zone (for example America/New_York)" },
);

/**
 * The sales-call setup: only the business name, time zone, and the owner are required (spec 4.1).
 * `orgSlug` names the business in the app; it defaults to one made from the business name.
 */
export const provisionSchema = z
  .object({
    orgSlug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, digits, and single dashes, like example-services")
      .optional(),
    profile: z.object({
      name: text,
      timeZone,
      phone: text.optional(),
      email: text.optional(),
      address: text.optional(),
      licenseNumber: text.optional(),
      language: language.optional(),
      quietStartHour: hour.optional(),
      quietEndHour: hour.optional(),
      quoteValidityDays: z.number().int().positive().optional(),
      followUpDays: z.number().int().positive().optional(),
    }),
    owner: z.object({ name: text, phone, email: text.optional(), language: language.optional() }),
    members: z
      .array(
        z.object({
          name: text,
          role: z.enum(["admin", "member"]),
          phone,
          email: text.optional(),
          language: language.optional(),
        }),
      )
      .default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of [config.owner, ...config.members].entries()) {
      if (seen.has(entry.phone)) {
        ctx.addIssue({
          code: "custom",
          path: index === 0 ? ["owner", "phone"] : ["members", index - 1, "phone"],
          message: `${entry.phone} is listed more than once`,
        });
      }
      seen.add(entry.phone);
    }
  });
export type Provision = z.infer<typeof provisionSchema>;

export type ProvisionRow = { name: string; role: Role; phone: string; assignedLine: string };
export type ProvisionDeps = {
  admin: PhotonAdmin;
  /** Only create a new business: refuse one whose slug or phones exist already (the admin page's "New business"). */
  createOnly?: boolean;
};

type Person = { name: string; role: Role; phone: string; email?: string; language?: "en" | "es" };

/**
 * The business to provision: the one `orgSlug` names, else the one the listed phones already belong
 * to (a rerun), else a new one. Throws before anything is written when a phone belongs to another
 * business, since a phone is how an inbound text finds its business.
 */
async function resolveOrganization(config: Provision, people: Person[], createOnly: boolean): Promise<Organization> {
  const phoneOrgs = new Set<string>();
  for (const person of people) {
    const found = await findMemberByPhone(person.phone);
    if (found) phoneOrgs.add(found.member.orgId);
  }
  if (phoneOrgs.size > 1) throw new Error("the listed phones belong to different businesses");
  const [phoneOrgId] = phoneOrgs;
  if (createOnly) {
    if (phoneOrgId) throw new Error("a listed phone already belongs to a business");
    const slug = config.orgSlug ?? slugify(config.profile.name);
    if (await findOrganizationBySlug(slug)) {
      throw new Error(`a business with the slug "${slug}" already exists. Choose another slug`);
    }
    return createOrganization({ name: config.profile.name, slug });
  }
  if (config.orgSlug) {
    const named = await findOrganizationBySlug(config.orgSlug);
    if (phoneOrgId && phoneOrgId !== named?.id) throw new Error("a listed phone already belongs to another business");
    return named ?? createOrganization({ name: config.profile.name, slug: config.orgSlug });
  }
  const existing = phoneOrgId ? await getOrganization(phoneOrgId) : null;
  if (existing) return existing;
  const slug = slugify(config.profile.name);
  if (await findOrganizationBySlug(slug)) {
    throw new Error(`a business with the slug "${slug}" already exists. Set orgSlug to choose another`);
  }
  return createOrganization({ name: config.profile.name, slug });
}

/**
 * Creates or updates the business: its organization and profile, the owner and any listed members,
 * each phone registered with Photon and its assigned line stored. Safe to rerun: existing phones keep
 * their member and status.
 */
export async function provision(
  config: Provision,
  deps: ProvisionDeps,
): Promise<{ org: Organization; rows: ProvisionRow[] }> {
  const people: Person[] = [{ ...config.owner, role: "owner" }, ...config.members];
  const org = await resolveOrganization(config, people, deps.createOnly ?? false);

  const rows: ProvisionRow[] = [];
  let ownerId: string | undefined;
  for (const person of people) {
    const existing = await findMemberByPhone(person.phone);
    const member =
      existing?.member ??
      (await createMember({
        orgId: org.id,
        name: person.name,
        role: person.role,
        language: person.language,
        addedByMemberId: ownerId,
      }));
    const phoneRow = existing?.phone ?? (await addPhone(org.id, member.id, person.phone));
    if (person.role === "owner") ownerId = member.id;

    const user = await deps.admin.ensureSharedUser({
      e164: person.phone,
      firstName: person.name.split(/\s+/)[0],
      email: person.email,
    });
    await setPhonePhoton(org.id, phoneRow.id, { photonUserId: user.id, assignedLine: user.assignedLine });
    rows.push({ name: member.name, role: member.role, phone: person.phone, assignedLine: user.assignedLine });
  }

  await updateProfile(org.id, config.profile, ownerId!);
  return { org: (await getOrganization(org.id)) ?? org, rows };
}

