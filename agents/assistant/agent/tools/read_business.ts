import { defineTool } from "eve/tools";
import { z } from "zod";
import { listMembers } from "../../../../core/members";
import { listGlossary } from "../../../../core/glossary";
import { businessNotes } from "../../../../core/notes";
import { listItems, listRules, versions } from "../../../../core/pricebook";
import { brandingFrom } from "../../../../core/branding";
import { getOrganization } from "../../../../core/organizations";
import { getProfile } from "../../../../core/profile";
import { plain, requireCaller, toolError } from "../../../../core/tool-context";

export default defineTool({
  description:
    "Read who this business is and who you're talking to (you: their name and role; member means crew): its profile (name, contact facts, minimum charge, tax rate, quote validity, follow-up days, invoice payment terms), how its PDFs look (logo, accent color, closing notes, which facts print), the active pricebook items (with what each needs, when saved), the rules (active ones, and crew suggestions waiting on the owner), the members (with what each one's truck carries), the business notes (how the business does things: procedures, policies, warranty terms, crew instructions; long ones are cut short, so read_note them when they matter), and the glossary (its own Spanish words for its English terms). Site notes on customers and kept documents aren't here: find them with search_records. Call it at the start of a conversation and whenever prices or rules might have changed. Money is integer cents; tax and percent rules are basis points (700 = 7%).",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    try {
      const caller = await requireCaller(ctx);
      const { orgId } = caller;
      const [profile, items, rules, current, people, notes, glossary, org] = await Promise.all([
        getProfile(orgId),
        listItems(orgId),
        listRules(orgId, { includeSuggested: true }),
        versions(orgId),
        listMembers(orgId),
        businessNotes(orgId),
        listGlossary(orgId),
        getOrganization(orgId),
      ]);
      const branding = brandingFrom(profile, org?.logo ?? null);
      return plain({
        you: { memberId: caller.memberId, name: caller.name, role: caller.role },
        profile: {
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
          language: profile.language,
        },
        items: items.map((i) => ({
          id: i.id,
          name: i.name,
          unitKind: i.unitKind,
          unitLabel: i.unitLabel,
          priceCents: i.priceCents,
          taxable: i.taxable,
          group: i.group,
          notes: i.notes,
          ...(i.equipment.length ? { equipment: i.equipment } : {}),
          ...(i.weatherSensitive ? { weatherSensitive: true } : {}),
        })),
        rules: rules.map((r) => ({ id: r.id, text: r.text, kind: r.kind, effect: r.effect, status: r.status })),
        pdf: {
          hasLogo: branding.logoUrl !== null,
          accentColor: branding.accentColor,
          quoteFooter: branding.quoteFooter,
          invoiceFooter: branding.invoiceFooter,
          showOnPdf: branding.showOnPdf,
        },
        minimumCents: profile.minimumChargeCents,
        versions: current,
        members: people.map((m) => ({ id: m.id, name: m.name, role: m.role, ...(m.equipment.length ? { equipment: m.equipment } : {}) })),
        notes: notes.map((n) => ({
          noteId: n.id,
          kind: n.kind,
          title: n.title,
          text: n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body,
          ...(n.body.length > 300 ? { truncated: true } : {}),
          ...(n.tags.length ? { tags: n.tags } : {}),
        })),
        glossary,
      });
    } catch (error) {
      return toolError(error);
    }
  },
});
