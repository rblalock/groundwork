import { defineHook } from "eve/hooks";
import { reservationOf } from "./usage";
import { markTurnRunning, settleTurn } from "./usage-limits";

// An admitted turn's reservation (core/usage-limits.ts) follows the turn: running once eve starts
// it, settled when it ends, however it ends. Observe-only: a failure here leaves the reservation to
// its 15-minute lease, never the turn.
const orgOf = (auth: { attributes?: Record<string, unknown> } | null | undefined) =>
  typeof auth?.attributes?.orgId === "string" ? auth.attributes.orgId : null;

async function settle(ctx: { session: { id: string; auth: { current?: { attributes?: Record<string, unknown> } | null } } }) {
  const auth = ctx.session.auth.current;
  const orgId = orgOf(auth);
  const reservationId = reservationOf(auth as never);
  if (!orgId || !reservationId) return;
  try {
    await settleTurn(orgId, reservationId);
  } catch (error) {
    console.error("usage: a turn's reservation was not settled", { orgId, reservationId, error });
  }
}

export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      const auth = ctx.session.auth.current;
      const orgId = orgOf(auth);
      const reservationId = reservationOf(auth as never);
      if (!orgId || !reservationId) return;
      try {
        await markTurnRunning(orgId, reservationId, { eveSessionId: ctx.session.id, turnId: event.data.turnId });
      } catch (error) {
        console.error("usage: a turn's start was not recorded on its reservation", { orgId, reservationId, error });
      }
    },
    "turn.completed": (_event, ctx) => settle(ctx),
    "turn.failed": (_event, ctx) => settle(ctx),
    "turn.cancelled": (_event, ctx) => settle(ctx),
  },
});
