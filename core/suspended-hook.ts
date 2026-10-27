import { defineHook } from "eve/hooks";
import { isSuspended } from "./organizations";

// A paused business runs no turns, whatever started them: a text already queued in eve, a web turn,
// or a job the thread drives. The channels refuse new work too; this stops anything that got through.
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const orgId = ctx.session.auth.current?.attributes?.orgId;
      if (typeof orgId !== "string" || !(await isSuspended(orgId))) return;
      console.warn("suspended: cancelled a turn for a paused business", { orgId, sessionId: ctx.session.id });
      ctx.cancel();
    },
  },
});
