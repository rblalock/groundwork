import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// Every tool decides what a forwarded email's turn may do with it (`refuseFromEmail` in
// core/tool-context.ts). Drafting, creating new records, and reading are fine from an email;
// changing or finalizing what's on record (money, the team, prices and rules, schedules, anything
// customer-facing) needs the member's own turn. A new tool fails here until it's put in one list.

/** Refused outright on an email's turn. */
const GATED: Record<string, string> = {
  add_member: "team",
  apply_proposal: "moves booked visits",
  approve_quote: "approves money",
  archive_customer: "changes a customer on record",
  change_visit_status: "completes or cancels a booked visit",
  close_job: "closes an existing job",
  close_service_job: "closes work on record",
  continue_job: "a job's turns would run without the email's mark",
  declare_delay: "re-plans a crew's day on record",
  drop_proposal: "decides a proposal on record",
  email_quote: "sends to the customer",
  merge_customers: "changes customers on record",
  plan_route_days: "puts a proposal to move booked visits to the owners",
  record_payment: "money",
  remove_member: "team",
  remove_payment: "money",
  remove_time_off: "changes the schedule on record",
  request_owner_approval: "puts a quote to the owners for approval",
  reschedule_visit: "moves a booked visit",
  retire_rule: "rules",
  revise_quote: "changes a quote on record",
  save_glossary_term: "the business's glossary, which customer-facing translations follow",
  save_contact: "changes the contacts of a customer on record (a new customer's come with save_customer)",
  save_pricebook_items: "prices",
  save_rule: "rules",
  send_invoice: "sends money owed",
  set_followup: "changes a quote's reminder",
  set_invoice_photos: "what a customer-facing invoice shows",
  set_logo: "the logo on customer-facing PDFs",
  set_member_email: "team: decides whose emails reach the assistant",
  set_quote_outcome: "customer-facing status",
  set_recurrence: "changes how work on record repeats",
  set_work_hours: "team schedule",
  start_job: "a job's turns would run without the email's mark",
  start_visit: "marks a booked visit started",
  tick_checklist: "changes the work's checklist on record, and can mark a visit done",
  update_branding: "how customer-facing PDFs look",
  update_invoice_lines: "money",
  update_member: "team",
  update_pricebook_item: "prices",
  update_profile: "business details, tax, and minimums",
  void_invoice: "money",
};

/** Allowed for new records, refused for changes to existing ones (or, for invoices, for sending). */
const CONDITIONAL: Record<string, string> = {
  create_invoice: "a draft is fine; send true issues it",
  save_customer: "a new customer is fine; customerId or contactId changes one on record",
  save_note: "a new note is fine; noteId changes one on record",
};

/** Changed on an email's turn so nothing reaches anyone but the member. */
const ADJUSTED: Record<string, string> = {
  book_visit: "only pencils a visit in, texts no crew, and doesn't make the work recurring",
  create_service_job: "new work to schedule, without making it recurring",
};

/** Never refused for coming from an email. */
const ALLOWED: Record<string, string> = {
  add_time_off: "creates a new time-off block",
  attach_work_photos: "adds only photos the member texted the line, never an email's",
  create_quote: "a new draft quote",
  find_availability: "reads",
  find_customer: "reads",
  get_invoice: "reads",
  get_quote: "reads",
  list_invoices: "reads",
  list_jobs: "reads",
  list_quotes: "reads",
  make_post: "draws the before-and-after for the member's own thread; nothing reaches the customer",
  next_stop: "reads",
  no_reply: "no effect",
  price_photo: "draws the quote's own photo and lines; nothing reaches the customer until the quote is sent",
  repeat_quote: "reads a past quote and prices it today; creates nothing",
  react: "a tapback on the member's own message; never on an email",
  read_business: "reads",
  read_checklist: "reads; makes the work's list from its quote when it has none",
  read_note: "reads",
  read_schedule: "reads",
  search_records: "reads",
  set_aside_document: "keeps the email's own attachments off quotes",
};

const UNCONDITIONAL = /^\s*refuseFromEmail\(ctx\);$/m;
const CONDITIONED = /^\s*if \([^)]+\) refuseFromEmail\(ctx\);$/m;

test("every tool is gated on an email's turn, or listed with a reason why not", async () => {
  const dir = join(import.meta.dirname, "..", "agents", "assistant", "agent", "tools");
  const tools = (await readdir(dir)).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort();
  const listed = [...Object.keys(GATED), ...Object.keys(CONDITIONAL), ...Object.keys(ADJUSTED), ...Object.keys(ALLOWED)].sort();
  assert.deepEqual(listed, tools, "each tool in agents/assistant/agent/tools is in exactly one list, and no list names a tool that's gone");
  for (const tool of tools) {
    const source = await readFile(join(dir, `${tool}.ts`), "utf8");
    if (tool in GATED) assert.match(source, UNCONDITIONAL, `${tool} calls refuseFromEmail(ctx) first`);
    else if (tool in CONDITIONAL) assert.match(source, CONDITIONED, `${tool} calls refuseFromEmail(ctx) under its condition`);
    else if (tool in ADJUSTED) assert.match(source, /isEmailTurn\(ctx\.session\.auth\.current\)/, `${tool} checks for an email's turn`);
    else assert.doesNotMatch(source, /refuseFromEmail/, `${tool} is allowed, so it isn't gated`);
  }
});
