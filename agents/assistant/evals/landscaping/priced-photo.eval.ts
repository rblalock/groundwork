import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { logWebInbound } from "../../../../core/channel-dispatch";
import { pricedPhotosFor } from "../../../../core/priced-photo";
import { listQuotes } from "../../../../core/quotes";
import type config from "../evals.config";

// The yard photo (fixtures/generate-yard-photo.ts) with every quantity given: the quote is made with the
// photo on it, then the photo is priced, SAM finding the beds, the hedge, and the lawn. The web chat would
// have stored the photo and logged it as the owner's message; an eval talks to the agent directly, so the
// eval logs it the same way, pointing at the fixture, and sends the image along so the model sees it.
const PHOTO = resolve(process.cwd(), "agents/assistant/evals/fixtures/yard-front.jpg");
const LOOKED_FOR = ["Mulch installed", "Hedge trimming", "Lawn mowing"];

export default defineEval<typeof config>({
  description: "A yard photo with mulch, hedge, and mowing gets a quote and a priced photo with at least two of those lines located.",
  tags: ["landscaping"],
  async test(t) {
    if (!existsSync(PHOTO)) return t.skip("fixtures/yard-front.jpg is missing; run fixtures/generate-yard-photo.ts");
    const business = await t.context.seed.landscaping();
    await logWebInbound({
      caller: business.owner,
      attachment: { type: "image", url: pathToFileURL(PHOTO).href, name: "yard-front.jpg", mimeType: "image/jpeg" },
    });
    const session = await t.session();

    const turn = await session.sendFile("Maria at 412 Oak St: 3 yards of mulch in the beds, trim the hedge about 1 hour, and mow the front", PHOTO, "image/jpeg");
    // With a photo, the assistant may confirm what it sees before quoting; the owner says go.
    if (!turn.toolCalls.some((call) => call.name === "create_quote")) await session.send("yes, quote it");
    t.succeeded();
    t.calledTool("create_quote");
    t.calledTool("price_photo");
    t.judge("Tells the owner the photo is priced and which lines were located.").gate(0.6);

    const [quote] = await listQuotes(business.orgId, {});
    const [priced] = quote ? await pricedPhotosFor(business.orgId, quote.quoteId) : [];
    const located = (priced?.regions ?? []).filter((region) => region.located && LOOKED_FOR.includes(region.name)).map((region) => region.name);
    t.check(located, satisfies((names: string[]) => names.length >= 2, "two or more of mulch, hedge, and mowing located")).label("located lines");
  },
});
