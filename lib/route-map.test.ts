import assert from "node:assert/strict";
import { test } from "node:test";
import type { Place } from "../core/places";
import type { DayPlanJson, PlanStopJson } from "./pages/schedule";
import { CREW_COLORS, crewColor, mapPoints } from "./route-map";

const at = (lat: number, lng: number, label: string): Place => ({ lat, lng, label });
const yard = at(26.9, -80.1, "100 Bridge Rd");
const oak = at(26.95, -80.1, "412 Oak St");
const pine = at(27.0, -80.05, "7 Pine Ave");
const elm = at(27.05, -80.15, "4 Elm Rd");

function stop(visitId: string, place: Place | null, extra: Partial<PlanStopJson> = {}): PlanStopJson {
  return { visitId, title: place?.label ?? "Unplaced Ln", place, status: "scheduled", lateMinutes: 0, ...extra } as PlanStopJson;
}

function plan(memberId: string, stops: PlanStopJson[], extra: Partial<DayPlanJson> = {}): DayPlanJson {
  return { memberId, name: memberId, stops, suggestedOrder: null, atRisk: false, ...extra } as DayPlanJson;
}

test("route map: the yard, each placed stop numbered as in the list, and a line from the yard and back", () => {
  const map = mapPoints([plan("m_a", [stop("v1", oak), stop("v2", null), stop("v3", pine)])], yard);
  assert.deepEqual(map.yard, { at: [26.9, -80.1], label: "100 Bridge Rd" });
  assert.deepEqual(
    map.markers.map((m) => [m.visitId, m.number, m.at]),
    [
      ["v1", 1, [26.95, -80.1]],
      ["v3", 3, [27.0, -80.05]],
    ],
  );
  assert.deepEqual(map.lines, [
    {
      memberId: "m_a",
      color: CREW_COLORS[0],
      points: [
        [26.9, -80.1],
        [26.95, -80.1],
        [27.0, -80.05],
        [26.9, -80.1],
      ],
      dashed: false,
    },
  ]);
  assert.deepEqual(map.bounds, [
    [26.9, -80.1],
    [27.0, -80.05],
  ]);
});

test("route map: each crew member's color is their place in the crew, so it stays the same on any day", () => {
  const crew = ["m_a", "m_b", "m_c"];
  const map = mapPoints([plan("m_c", [stop("v1", oak)]), plan("m_b", [stop("v2", pine)])], yard, crew);
  assert.deepEqual(
    map.markers.map((m) => m.color),
    [CREW_COLORS[2], CREW_COLORS[1]],
  );
  assert.equal(crewColor("m_z", crew), CREW_COLORS[3], "someone not in the list gets the next color");
  assert.equal(crewColor("m_a", [...Array(CREW_COLORS.length).fill("x"), "m_a"]), CREW_COLORS[0], "the colors wrap around");
});

test("route map: the shorter order is a second, dashed line through the same stops", () => {
  const map = mapPoints(
    [
      plan("m_a", [stop("v1", oak), stop("v2", elm), stop("v3", pine)], {
        suggestedOrder: [
          { visitId: "v1", title: "412 Oak St" },
          { visitId: "v3", title: "7 Pine Ave" },
          { visitId: "v2", title: "4 Elm Rd" },
        ],
      }),
    ],
    yard,
  );
  assert.deepEqual(
    map.lines.map((l) => [l.dashed, l.points.slice(1, -1)]),
    [
      [false, [[26.95, -80.1], [27.05, -80.15], [27.0, -80.05]]],
      [true, [[26.95, -80.1], [27.0, -80.05], [27.05, -80.15]]],
    ],
  );
});

test("route map: a stop they'd reach late, or the last of a day at risk, is flagged; a done one isn't", () => {
  const map = mapPoints(
    [
      plan("m_a", [stop("v1", oak, { status: "completed", lateMinutes: 15 }), stop("v2", pine, { lateMinutes: 20 })]),
      plan("m_b", [stop("v3", oak), stop("v4", elm)], { atRisk: true }),
    ],
    yard,
  );
  assert.deepEqual(
    map.markers.map((m) => [m.visitId, m.done, m.warn]),
    [
      ["v1", true, false],
      ["v2", false, true],
      ["v3", false, false],
      ["v4", false, true],
    ],
  );
});

test("route map: without a placed yard the line runs stop to stop; nothing placed draws nothing", () => {
  const map = mapPoints([plan("m_a", [stop("v1", oak), stop("v2", pine)]), plan("m_b", [stop("v3", elm)])], null);
  assert.equal(map.yard, null);
  assert.deepEqual(
    map.lines.map((l) => [l.memberId, l.points.length]),
    [["m_a", 2]],
    "one stop and no yard is a marker, not a line",
  );
  const empty = mapPoints([plan("m_a", [stop("v1", null)])], null);
  assert.deepEqual(empty, { yard: null, markers: [], lines: [], bounds: null });
  assert.deepEqual(mapPoints([plan("m_a", [stop("v1", null)])], yard).lines, [], "the yard alone is no line");
});
