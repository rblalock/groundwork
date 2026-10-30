// Zod schemas shared by more than one tool. Money is integer cents; percentages are basis points.
import { z } from "zod";

export const cents = z.number().int().min(0);

export const unitKindSchema = z
  .enum(["each", "sqft", "linear_ft", "hour", "visit", "flat", "other"])
  .describe("each (per piece), sqft, linear_ft, hour, visit, flat (one price for the job), or other.");

export const ruleKindSchema = z.enum(["pricing_modifier", "scope", "exclusion", "process", "other"]);

export const ruleEffectSchema = z
  .object({
    op: z
      .enum(["add_fixed", "add_per_unit", "percent"])
      .describe("add_fixed: cents added once. add_per_unit: cents added per unit of the matching lines. percent: basis points of the matching lines."),
    amount: z.number().int().describe("Cents for add_fixed and add_per_unit ($50 → 5000); basis points for percent (10% → 1000). Negative for a discount."),
    appliesTo: z
      .union([z.literal("any"), z.array(z.string()).min(1)])
      .describe('"any", or the pricebook item ids it applies to.'),
  })
  .describe("Only for a pricing modifier with a clear amount. Leave it out when the statement has no number.");

export const lineSchema = z.object({
  itemId: z.string().optional().describe("Pricebook item id. Its saved price is used."),
  name: z.string().optional().describe("The member's words for the work. Required without itemId."),
  unitLabel: z.string().optional().describe("Unit in the member's words, for a line without itemId."),
  quantity: z.number().positive(),
  unitCents: cents
    .optional()
    .describe("Integer cents per unit ($12 → 1200; $12.50 → 1250). Only a price the member stated for this job. Omit to use the saved price, or to leave a new item unpriced."),
});

export const adjustmentSchema = z.object({
  kind: z.enum(["override", "discount"]).describe("override: the member set the total before tax. discount: an amount off."),
  amountCents: cents.describe("Integer cents ($375 → 37500; $40 off → 4000)."),
  reason: z.string().min(1).describe("The member's words, like 'just call it 400'."),
});

export const languageSchema = z.enum(["en", "es"]);

export const quoteStatusSchema = z.enum(["draft", "needs_owner", "approved", "sent", "won", "lost", "void"]);

export const createQuoteSchema = z.object({
  title: z.string().min(1).describe("The address or the member's phrase for the job."),
  customerId: z.string().optional().describe("From find_customer or save_customer."),
  propertyId: z.string().optional().describe("One of the customer's property ids."),
  customer: z
    .object({
      name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().optional(),
      address: z.string().optional(),
      language: languageSchema.optional(),
    })
    .optional()
    .describe(
      "The customer when find_customer found nobody: their name and anything else the member stated (phone, email, address). It is saved as a new customer, the address as their property, and the quote is theirs. Never pass a customer you did not look up first. Ignored with customerId.",
    ),
  lines: z.array(lineSchema).min(1).max(50),
  ruleIds: z
    .array(z.string())
    .optional()
    .describe("Active rule ids whose condition this job meets. You judge the condition; the code does the math."),
  adjustments: z.array(adjustmentSchema).max(5).optional(),
  customerLanguage: languageSchema.optional().describe("The PDF's language. Defaults to the customer's."),
  customerNotes: z.string().optional().describe("Printed on the PDF for the customer: write them in the quote's customer language."),
  privateNotes: z.string().optional().describe("Never shown to the customer."),
});

export const reviseQuoteSchema = createQuoteSchema.partial().extend({
  quoteId: z.string(),
  lines: z
    .array(lineSchema)
    .min(1)
    .max(50)
    .optional()
    .describe("Replaces every line, so pass the full list with your change (get_quote has the current lines). Omit to keep them."),
  adjustments: z
    .array(adjustmentSchema)
    .max(5)
    .optional()
    .describe("Replaces every adjustment. Pass [] to remove an override. Omit to keep them."),
  ruleIds: z
    .array(z.string())
    .optional()
    .describe("Replaces the applied rules. Omit to keep them."),
  removePhotoIds: z
    .array(z.string())
    .max(20)
    .optional()
    .describe("Photo ids from get_quote's attachments to take off the quote and its PDF."),
});

const validTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const hour = z.number().int().min(0).max(23);
const fact = z.string().trim().min(1).nullable().optional();

/** The business facts update_profile and the web app's settings change. null clears a fact. */
export const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    phone: fact,
    email: fact,
    address: fact,
    licenseNumber: fact,
    timeZone: z.string().refine(validTimeZone, "Use an IANA time zone like America/Chicago.").optional(),
    quietStartHour: hour.optional(),
    quietEndHour: hour.optional(),
    quoteValidityDays: z.number().int().min(1).max(365).optional(),
    followUpDays: z.number().int().min(1).max(60).optional(),
    minimumChargeCents: cents.nullable().optional().describe("Minimum charge per visit ($150 → 15000)."),
    taxRateBp: z.number().int().min(0).max(10_000).nullable().optional().describe("Only a rate the owner stated."),
    paymentTermsDays: z
      .number()
      .int()
      .min(0)
      .max(120)
      .optional()
      .describe("Days from an invoice's date to its due date (\"net 15\" is 15). 0 is due on receipt."),
    depositPercent: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("The share of a quote's total a customer pays as a deposit when they approve it on its link (\"25% down\" is 25). 0 asks none."),
    customerLinePrices: z
      .boolean()
      .optional()
      .describe("Whether customers see each line's price on the quote link, its PDF, and the priced photo. false shows them each line's quantity and only the total."),
    language: languageSchema.optional(),
    townMph: z
      .number()
      .int()
      .min(5)
      .max(65)
      .optional()
      .describe("How fast the crew drive around town, for drive times between jobs (\"we drive about 25 mph around here\" is 25). Default 28."),
    roadFactorBp: z
      .number()
      .int()
      .min(10_000)
      .max(30_000)
      .optional()
      .describe("How much longer the roads are than a straight line, in basis points: 13000 is 1.3, the default. Slow or winding roads are higher (1.5 is 15000)."),
    minDriveMinutes: z.number().int().min(0).max(60).optional().describe("The shortest drive between two places, in minutes. Default 5."),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), "Pass at least one fact.");
