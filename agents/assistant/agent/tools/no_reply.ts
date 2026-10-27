import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { APP_WEB } from "../../../../core/members";

// Ends the turn without a message: a tapback that asks for nothing, or 😂 on a quote. Not on the web,
// where a turn that ends without words looks like nothing happened: there the assistant always answers.
// eve's own `noReply()`, written out here: a tool a dynamic resolver returns has to be authored inline,
// so eve can replay it.
export default defineDynamic({
  events: {
    "turn.started": (_event, resolve) =>
      resolve.session.auth.current?.authenticator === APP_WEB
        ? null
        : defineTool({
            availableInSubagents: false,
            description:
              "End your turn without sending a reply. Use this when nothing needs to be said, such as when an action you already took is the whole answer.",
            endsTurn: true,
            inputSchema: z.object({
              reason: z.string().optional().describe("Why no reply is needed. Kept in the session history and traces; never sent."),
            }),
            execute: () => "No reply was sent.",
          }),
  },
});
