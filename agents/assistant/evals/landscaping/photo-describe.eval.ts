import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineEval } from "eve/evals";
import type config from "../evals.config";

// A generated photo of a front yard (fixtures/generate-yard-photo.ts): two mulched beds with hedges along
// the house, a palm, lawn, and a driveway. The assistant says what it sees and proposes quantities for the
// owner to confirm, and prices nothing until they do.
const PHOTO = resolve(process.cwd(), "agents/assistant/evals/fixtures/yard-front.jpg");

export default defineEval<typeof config>({
  description: "A yard photo with a bed cleanup and mulch request gets what's visible and proposed quantities, not a quote.",
  tags: ["landscaping"],
  async test(t) {
    if (!existsSync(PHOTO)) return t.skip("fixtures/yard-front.jpg is missing; run fixtures/generate-yard-photo.ts");
    await t.context.seed.landscaping();
    const session = await t.session();

    const turn = await session.sendFile("quote this bed cleanup and mulch", PHOTO, "image/jpeg");
    t.succeeded();
    turn.notCalledTool("create_quote");
    t.judge(
      "Describes what is visible in the photo and proposes quantities (bed length or mulch yards) for the owner to confirm.",
    ).gate(0.6);
  },
});
