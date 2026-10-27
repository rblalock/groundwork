import { navigate } from "@agent-browser/eve/tools";
import { defineTool } from "eve/tools";
import { publicSite } from "../../../lib/public-site";

// Only public websites (lib/public-site.ts): never a private network, a metadata address, or a bare IP.
export default defineTool({
  ...navigate,
  async execute(input, ctx) {
    if (input.action === "goto" && input.url !== undefined) return navigate.execute({ ...input, url: await publicSite(input.url) }, ctx);
    return navigate.execute(input, ctx);
  },
});
