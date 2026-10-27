import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { reactionTurnText } from "../../../core/inbound";
import { getQuote, listQuotes, quoteSummaryText } from "../../../core/quotes";
import type config from "./evals.config";

// A tapback reaches the agent as an ordinary turn, so these evals send the turn text the channel builds.
// Nothing here is approved by code alone: the model calls approve_quote and the role policy applies.
// Three cases in one file: `eve eval emoji-approval` runs them together.

export default [
  defineEval<typeof config>({
    description: "A thumbs-up tapback on quote B approves B and leaves A a draft.",
    async test(t) {
      const business = await t.context.seed.priced();
      const quoteA = await t.context.seed.draftQuote(business, { title: "100 Example St", windowCount: 20 });
      const quoteB = await t.context.seed.draftQuote(business, { title: "200 Sample Ave", windowCount: 16 });

      // The channel quotes the first 160 characters of the message the tapback landed on. Over HTTP the
      // context line that names the quote cannot be passed, so the quoted summary text carries it.
      const targetBody = quoteSummaryText(quoteB, "en", "owner");
      await t.send(reactionTurnText({ glyph: "👍", targetBody }));
      t.succeeded();
      t.calledTool("approve_quote");

      // Approval must target B. Checked through getQuote after the turn (the test body is async).
      const after = {
        a: (await getQuote(business.orgId, quoteA.quoteId))?.status,
        b: (await getQuote(business.orgId, quoteB.quoteId))?.status,
      };
      t.check(after.b, equals("approved")).label("quote B status");
      t.check(after.a, equals("draft")).label("quote A status");
    },
  }),

  defineEval<typeof config>({
    description: "A bare 👍🏽 text after a quote summary approves that quote.",
    async test(t) {
      const business = await t.context.seed.priced();

      // The HTTP channel has no context block, so the draft's summary has to be the agent's last message.
      const first = await t.send("new one. 310 Coral Way, 16 windows in and out, no screens");
      first.calledTool("create_quote");

      const turn = await first.session.send("👍🏽");
      turn.calledTool("approve_quote");

      const [quote] = await listQuotes(business.orgId, {});
      t.check(quote?.status, equals("approved")).label("quote status");
    },
  }),

  defineEval<typeof config>({
    description: "A thumbs-up tapback on a plain acknowledgment gets no reply and approves nothing.",
    async test(t) {
      const business = await t.context.seed.priced();
      const draft = await t.context.seed.draftQuote(business, { title: "100 Example St", windowCount: 20 });

      const turn = await t.send(reactionTurnText({ glyph: "👍", targetBody: "Saved." }));
      t.succeeded();
      t.notCalledTool("approve_quote");
      t.check(
        { message: turn.message?.trim() ?? "", calledNoReply: turn.toolCalls.some((call) => call.name === "no_reply") },
        satisfies(
          (value: { message: string; calledNoReply: boolean }) => value.calledNoReply || value.message === "",
          "there is no reply text, or the agent called no_reply",
        ),
      );
      t.check((await getQuote(business.orgId, draft.quoteId))?.status, equals("draft")).label("draft quote status");
    },
  }),
];
