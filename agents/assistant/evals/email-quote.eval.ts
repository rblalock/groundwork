import { and, eq } from "drizzle-orm";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { events } from "../../../schema/schema";
import { db } from "../../../core/db";
import { listQuotes } from "../../../core/quotes";
import type config from "./evals.config";

// EMAIL_FAKE=1 (evals.config.ts) records instead of sending, so a sent email shows as its event.
const emailedTo = async (orgId: string, quoteId: string) =>
  (
    await db()
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.kind, "quote.emailed"), eq(events.refId, quoteId)))
  ).map((row) => row.data.to);

export default [
  defineEval<typeof config>({
    description: "\"Email it to <address>\" after a quote approves it, emails it there, and marks it sent.",
    async test(t) {
      const business = await t.context.seed.priced();
      const first = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
      first.calledTool("create_quote");

      const turn = await first.session.send("email it to jane.sample@example.com");
      turn.calledTool("email_quote");
      t.judge("The reply confirms in a line or two that the quote was emailed to jane.sample@example.com.").gate(0.7);

      const [quote] = await listQuotes(business.orgId, {});
      t.check(quote?.status, equals("sent")).label("quote status");
      t.check(await emailedTo(business.orgId, quote.quoteId), equals(["jane.sample@example.com"])).label("emailed to");
    },
  }),

  defineEval<typeof config>({
    description: "\"Email it to the customer\" with no address anywhere asks for one and sends nothing.",
    async test(t) {
      const business = await t.context.seed.priced();
      const first = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
      first.calledTool("create_quote");

      await first.session.send("email it to the customer");
      t.judge("The reply asks for the customer's email address and does not claim anything was emailed.").gate(0.7);

      const [quote] = await listQuotes(business.orgId, {});
      t.check(await emailedTo(business.orgId, quote.quoteId), equals([])).label("emailed to");
    },
  }),

  defineEval<typeof config>({
    description: "A bare \"send it\" after a quote summary approves it and emails nobody.",
    async test(t) {
      const business = await t.context.seed.priced();
      const first = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
      first.calledTool("create_quote");

      const turn = await first.session.send("send it");
      turn.calledTool("approve_quote");
      turn.notCalledTool("email_quote");

      const [quote] = await listQuotes(business.orgId, {});
      t.check(quote?.status, equals("approved")).label("quote status");
    },
  }),
];
