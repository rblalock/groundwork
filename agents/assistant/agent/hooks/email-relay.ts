import { defineHook } from "eve/hooks";
import { relayEmailTurn } from "../../../../core/email-relay";

// An email's turn runs in its own thread, so its reply is texted from here (core/email-relay.ts).
export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      await relayEmailTurn(event, ctx.session);
    },
    async "turn.failed"(event, ctx) {
      await relayEmailTurn(event, ctx.session);
    },
  },
});
