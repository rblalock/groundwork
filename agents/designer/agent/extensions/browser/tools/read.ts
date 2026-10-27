import { read } from "@agent-browser/eve/tools";
import { defineTool } from "eve/tools";
import { publicSite } from "../../../lib/public-site";

// Reading by URL fetches it, so it gets navigate's rule: public websites only (lib/public-site.ts).
export default defineTool({
  ...read,
  async execute(input, ctx) {
    return read.execute(input.url === undefined ? input : { ...input, url: await publicSite(input.url) }, ctx);
  },
});
