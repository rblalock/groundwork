import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineEval } from "eve/evals";
import { pricedPhotos } from "../../../../schema/schema";
import { db, newId } from "../../../../core/db";
import { createQuote } from "../../../../core/quotes";
import type config from "../evals.config";

// A quote with a priced photo from before the job and one from after it (both the yard fixture, as
// priced photos already saved): asked for something to post, the assistant makes the post with
// make_post and says where it is. No SAM call: the post is drawn from the two photos.
const PHOTO = resolve(process.cwd(), "agents/assistant/evals/fixtures/yard-front.jpg");

export default defineEval<typeof config>({
  description: "Asked for a post after the job, the assistant calls make_post and says the post and its caption are ready.",
  tags: ["landscaping"],
  async test(t) {
    if (!existsSync(PHOTO)) return t.skip("fixtures/yard-front.jpg is missing; run fixtures/generate-yard-photo.ts");
    const business = await t.context.seed.landscaping();
    const noPost = async () => ({ posted: false as const, reason: "eval" });
    const quote = await createQuote(
      { title: "412 Oak St front yard", lines: [{ itemId: business.itemIdsByName["Mulch installed"], quantity: 3 }] },
      business.owner,
      { post: noPost },
    );
    const region = { lineIndex: 0, itemId: null, name: "Mulch installed", quantity: 3, unitLabel: "cubic yard", totalCents: null, phrase: "mulch bed", objects: [], located: false };
    for (const sourceKind of ["quote_attachment", "work_photo"] as const) {
      await db()
        .insert(pricedPhotos)
        .values({
          id: newId("ppho"),
          orgId: business.orgId,
          quoteId: quote.quoteId,
          revisionNumber: 1,
          sourceKind,
          sourceId: newId("src"),
          sourceUrl: pathToFileURL(PHOTO).href,
          url: pathToFileURL(PHOTO).href,
          width: 1024,
          height: 1024,
          regions: [region],
        });
    }

    await t.send("the Oak St job looks great, make me something to post on instagram");
    t.succeeded();
    t.calledTool("make_post");
    t.judge("Says the post is ready (in the thread, or on the quote page under Share) and gives or points to its caption. States no price.").gate(0.6);
  },
});
