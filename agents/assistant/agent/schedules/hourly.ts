import { defineSchedule } from "eve/schedules";
import { pruneConversationEvents } from "../../../../core/conversation-events";
import { pruneDeliveries } from "../../../../core/deliveries";
import { hourlyTick } from "../../../../core/followups";
import { pruneTranslations } from "../../../../core/translation";
import { pruneTurnTraces } from "../../../../core/turn-traces";

// Follow-up nudges and the morning line are deterministic posts, so there is no channel hand-off.
// Vercel Hobby only runs daily crons. Each run also drops conversation events and turn traces, handled
// inbound deliveries past their retention, and cached translations.
export default defineSchedule({
  cron: "0 * * * *",
  run({ waitUntil }) {
    waitUntil(
      Promise.all([
        hourlyTick(),
        pruneConversationEvents().catch((error) => console.error("conversation events: prune failed", error)),
        pruneTurnTraces().catch((error) => console.error("turn traces: prune failed", error)),
        pruneDeliveries().catch((error) => console.error("deliveries: prune failed", error)),
        pruneTranslations().catch((error) => console.error("translations: prune failed", error)),
      ]),
    );
  },
});
