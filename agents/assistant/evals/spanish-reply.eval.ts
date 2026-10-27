import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import type config from "./evals.config";
import { SCREENS, WINDOWS } from "./seed";

/** True when `text` names the price `$<dollars>`, whole: "$2" is not in "$12" or "$25". */
const namesPrice = (text: string, dollars: number) => new RegExp(`\\$${dollars}(?![\\d])`).test(text);

export default defineEval<typeof config>({
  description: "A question in Spanish gets a Spanish answer that lists the saved prices.",
  async test(t) {
    await t.context.seed.priced();

    const turn = await t.send("¿cuáles son mis precios?");
    t.succeeded();
    // The prices are checked here, not by the judge: it sees only the reply, not what was saved.
    const reply = turn.message ?? "";
    t.check(namesPrice(reply, 12), equals(true)).label("lists $12");
    t.check(namesPrice(reply, 2), equals(true)).label("lists $2");
    // Saved item names stay as saved (instructions.md), so a Spanish reply can carry English names. Told
    // nothing, the judge read those names as English and failed the same reply it passed on other runs.
    t.judge({
      type: "boolean",
      instructions: {
        question: "Is the reply written in Spanish?",
        savedItemNames: [WINDOWS, SCREENS],
        note:
          "The saved item names are the business's own labels and are quoted as saved, even when they are English; they don't count against the reply. Unit words and abbreviations such as \"c/u\" (cada uno) are Spanish.",
      },
    }).gate(0.7);
  },
});
