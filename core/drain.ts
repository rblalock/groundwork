import { readyMembers } from "./deliveries";
import { agentRoute } from "./jobs";
import { drainToken } from "./worker-token";

/**
 * Asks the Photon channel's drain route to work through the inbound queue, when anything is ready. Only
 * a channel route can hand a turn to a member's eve session, so the every-minute backstop
 * (agents/assistant/agent/schedules/texts.ts) and the email webhook (app/api/webhooks/agentmail) both come through here.
 * Never throws: whatever it misses, the next backstop picks up.
 */
export async function requestDrain(source: string): Promise<void> {
  try {
    if ((await readyMembers(new Date(), 1)).length === 0) return;
    const response = await fetch(agentRoute("/eve/v1/photon/drain"), {
      method: "POST",
      headers: { authorization: `Bearer ${drainToken()}` },
      redirect: "error",
      signal: AbortSignal.timeout(280_000),
    });
    if (!response.ok) console.error(`${source}: the drain route answered`, { status: response.status });
  } catch (error) {
    console.error(`${source}: the drain did not run`, error);
  }
}
