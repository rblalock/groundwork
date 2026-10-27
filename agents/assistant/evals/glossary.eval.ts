import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { upsertThread } from "../../../core/conversations";
import { listGlossary } from "../../../core/glossary";
import type config from "./evals.config";

// The glossary by text: an owner tells the assistant the business's own Spanish word for a term, and
// it's saved as said (then taken off again); crew are told the owner or an admin does that.
export default [
  defineEval<typeof config>({
    description: "An owner's \"in Spanish call the 'screen' 'malla'\" saves a glossary term, and taking it back removes it.",
    async test(t) {
      const business = await t.context.seed.priced();

      const saved = await t.send("in Spanish call the 'screen' 'malla'");
      t.succeeded();
      saved.calledTool("save_glossary_term");
      saved.notCalledTool("save_pricebook_items");
      saved.notCalledTool("update_pricebook_item");
      t.check(
        (await listGlossary(business.orgId)).map((term) => `${term.term.toLowerCase()}=${term.spanish.toLowerCase()}`),
        equals(["screen=malla"]),
      ).label("glossary saved");
      t.judge("The reply confirms in a line or two that in Spanish the business says malla for screen. It doesn't change a price or quote anything. No markdown.").gate(0.7);

      const removed = await saved.session.send("actually, take malla off the glossary");
      t.succeeded();
      removed.calledTool("save_glossary_term");
      t.check((await listGlossary(business.orgId)).length, equals(0)).label("glossary empty");
    },
  }),

  defineEval<typeof config>({
    description: "A crew member's glossary word isn't saved; they're told the owner or an admin does that.",
    async test(t) {
      const business = await t.context.seed.scheduled();
      const session = await t.session();
      await upsertThread(business.orgId, business.crew.carlos.memberId, session.sessionId);

      await session.send("in Spanish we call the screen 'malla', put that in the glossary");
      t.succeeded();
      t.check((await listGlossary(business.orgId)).length, equals(0)).label("glossary unchanged");
      t.judge(
        "The reply tells the crew member, briefly, that the owner or an admin changes the glossary (or the business's words), so they should ask them. It does not say the word was saved.",
      ).gate(0.7);
    },
  }),
];
