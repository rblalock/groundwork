import { defineHook } from "eve/hooks";
import { recordTraceEvent } from "../../../../core/turn-traces";

// Every turn's trace, kept in Postgres (core/turn-traces.ts): the model, each step's tool calls with
// their inputs and outputs, reasoning and messages, and token totals.
// Observe-only: a failure here loses the trace, never the turn.
export default defineHook({
  events: {
    async "*"(event, ctx) {
      await recordTraceEvent(event, { id: ctx.session.id, auth: ctx.session.auth.current, parent: ctx.session.parent });
    },
  },
});
