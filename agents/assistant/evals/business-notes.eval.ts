import { defineEval } from "eve/evals";
import { equals, includes, satisfies } from "eve/evals/expect";
import { businessNotes } from "../../../core/notes";
import { listRules } from "../../../core/pricebook";
import type config from "./evals.config";

// How the business works is a business note, not a price or a rule, and the assistant answers from it
// later, in a conversation that never heard it said.
export default [
  defineEval<typeof config>({
    description: "\"Remember we always wipe the sills\" is saved as a business note, and a later conversation answers from it.",
    async test(t) {
      const business = await t.context.seed.priced();

      const saved = await t.send("remember that we always wipe the sills and don't charge for it");
      t.succeeded();
      saved.calledTool("save_note");
      saved.notCalledTool("save_pricebook_items");
      t.judge("The reply confirms in a line or two that it will remember the sills are wiped at no charge. It doesn't quote anything. No markdown.").gate(0.7);

      const notes = await businessNotes(business.orgId);
      t.check(
        notes.map((n) => `${n.title} ${n.body}`.toLowerCase()),
        satisfies((texts: string[]) => texts.length === 1 && /sill/.test(texts[0]) && /(charge|free|no cost|cost)/.test(texts[0]), "one note about sills at no charge"),
      ).label("business note");
      t.check((await listRules(business.orgId, { includeSuggested: true })).length, equals(0)).label("no rule saved");

      // A new conversation: only the saved note can answer this.
      const asked = await t.send("does the customer pay extra if we wipe the sills?");
      t.judge(
        "The reply says wiping the sills is not charged for (it's included at no charge), as the business's own practice. It does not give a price for it.",
      ).gate(0.7);
      t.check(asked.message?.toLowerCase(), satisfies((m: string | undefined) => Boolean(m && /sill/.test(m)), "mentions the sills"));
    },
  }),

  defineEval<typeof config>({
    description: "A gate code is answered from the site note on that address, and one with no note is not made up.",
    async test(t) {
      await t.context.seed.siteNote();

      const turn = await t.send("what's the gate code at 12 Oak St?");
      t.succeeded();
      t.check(turn.message, includes("4821"));
      t.judge("The reply gives gate code 4821 for 12 Oak St, as saved. One or two short lines. No markdown.").gate(0.7);

      const none = await turn.session.send("and the one at 9 Elm St?");
      t.check(
        none.message,
        satisfies((m: string | undefined) => !/\b\d{4}\b/.test((m ?? "").replace(/4821/g, "")), "no other code"),
      ).label("no invented code");
      t.judge(
        "The reply says there's no gate code saved for 9 Elm St (or that it has nothing on record for it) and asks for it or offers to save it. It does not make up a code.",
      ).gate(0.7);
    },
  }),
];
