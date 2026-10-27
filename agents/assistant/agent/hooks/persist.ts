import { defineHook } from "eve/hooks";
import { persistEvent } from "../../../../core/conversation-events";

// Every session's stream, kept in Postgres per conversation (core/conversation-events.ts): what
// members sent, what the assistant answered, which tools ran and how they went, and how turns ended.
// Observe-only: a failure here loses the record, never the turn.
export default defineHook({
  events: {
    async "*"(event, ctx) {
      await persistEvent(event, { id: ctx.session.id, auth: ctx.session.auth.current, parent: ctx.session.parent });
    },
  },
});
