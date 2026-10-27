import assert from "node:assert/strict";
import { test } from "node:test";
import type { VisitJson } from "./pages/schedule";
import { crewAfterMove, draggable, moveRequest, snap } from "./schedule-presentation";

const TZ = "America/Chicago";

function visit(overrides: Partial<VisitJson> = {}): VisitJson {
  return {
    visitId: "v1",
    jobId: "j1",
    title: "Example job",
    status: "scheduled",
    jobStatus: "open",
    // 9:00–10:30 in Chicago (CDT, UTC-5).
    startAt: "2026-10-20T14:00:00.000Z",
    endAt: "2026-10-20T15:30:00.000Z",
    crew: [
      { memberId: "m_a", name: "A Example" },
      { memberId: "m_b", name: "B Example" },
    ],
    ...overrides,
  } as VisitJson;
}

test("dragging: snaps to quarter hours", () => {
  assert.deepEqual([snap(7), snap(8), snap(52), snap(53), snap(600)], [0, 15, 45, 60, 600]);
});

test("dragging: a lane change swaps that one person; a lane already on the visit keeps the crew", () => {
  assert.deepEqual(crewAfterMove(visit(), "m_a", "m_c"), ["m_c", "m_b"]);
  assert.deepEqual(crewAfterMove(visit(), "m_a", "m_b"), ["m_a", "m_b"]);
  assert.deepEqual(crewAfterMove(visit(), "m_a", "m_a"), ["m_a", "m_b"]);
});

test("dragging: a drop asks for the day, time, and crew, keeping the length; no move is no request", () => {
  const v = visit();
  assert.equal(moveRequest(v, "m_a", { visitId: "v1", date: "2026-10-20", memberId: "m_a", minute: 540 }, TZ), null);
  assert.equal(moveRequest(v, "m_a", { visitId: "v1", date: "2026-10-20", memberId: "m_b", minute: 540 }, TZ), null);
  const move = moveRequest(v, "m_a", { visitId: "v1", date: "2026-10-21", memberId: "m_c", minute: 630 }, TZ);
  assert.ok(move);
  assert.deepEqual(
    { date: move.date, time: move.time, memberIds: move.memberIds, durationMinutes: move.durationMinutes },
    { date: "2026-10-21", time: "10:30", memberIds: ["m_c", "m_b"], durationMinutes: 90 },
  );
});

test("dragging: only open visits on open work, within one day", () => {
  assert.equal(draggable(visit(), TZ), true);
  assert.equal(draggable(visit({ status: "proposed" }), TZ), true);
  assert.equal(draggable(visit({ status: "completed" }), TZ), false);
  assert.equal(draggable(visit({ status: "cancelled" }), TZ), false);
  assert.equal(draggable(visit({ jobStatus: "completed" } as Partial<VisitJson>), TZ), false);
  assert.equal(draggable(visit({ endAt: "2026-10-21T15:00:00.000Z" }), TZ), false, "runs into the next day");
});
