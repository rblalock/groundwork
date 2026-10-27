import { defineSchedule } from "eve/schedules";
import { requestDrain } from "../../../../core/drain";

// The inbound text queue's backstop. The webhook works a member's queue right after it answers
// Photon; this picks up whatever that couldn't finish (an instance stopped mid-way, a retry's wait ran
// out, a stalled lease) within a minute. Only a channel route can hand a turn to a member's eve
// session, so it asks the Photon channel's drain route to do the work, and only when there is some.
// Needs per-minute crons (Vercel Pro).
export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(requestDrain("texts backstop"));
  },
});
