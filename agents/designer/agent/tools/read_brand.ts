import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { privilegedOnly } from "../../../../core/policies";
import { toolError } from "../../../../core/tool-context";
import { BRAND_SCRIPT } from "../lib/brand-script";
import { browse, capture, openAt } from "../lib/browser";
import { publicSite } from "../lib/public-site";

// A website's brand, read from what its page renders in a real browser: a screenshot of its first screen,
// and the computed colors, type, buttons, design tokens, and logo candidates (lib/brand-script.ts).
export default defineTool({
  description:
    "Look at a website the member named, to match its brand: returns a screenshot of its first screen at desktop width and what the page actually renders (its background and text colors, the colors covering the most of it, its buttons and links, heading and body type, the web fonts that loaded, its CSS design tokens, and logo candidates). Call it first whenever they name a site. For another page of the site, or to scroll further, use the browser tools.",
  inputSchema: z.object({
    url: z.string().trim().min(4).max(500).describe("The site's address, as they gave it."),
  }),
  approval: privilegedOnly("look at websites for the business"),
  async execute({ url }, ctx) {
    try {
      const address = await publicSite(url);
      await openAt(ctx, address, 1440, 900);
      const evaluated = await browse<{ result?: unknown }>(ctx, ["eval", BRAND_SCRIPT]);
      const screenshot = await capture(ctx, { full: false });
      return { url: address, brand: evaluated?.result ?? evaluated, screenshot };
    } catch (error) {
      return toolError(error);
    }
  },
  toModelOutput(output) {
    if (!("screenshot" in output)) return toolOutput.json(output);
    return toolOutput.content([
      toolOutputPart.text(`${output.url}, its first screen at 1440px wide:`),
      toolOutputPart.file(output.screenshot, { mediaType: "image/jpeg" }),
      toolOutputPart.text(`What the page renders: ${JSON.stringify(output.brand)}`),
    ]);
  },
});
