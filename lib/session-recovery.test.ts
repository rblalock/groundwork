import assert from "node:assert/strict";
import { test } from "node:test";
import { probeSaysLost, sendMayHaveLostSession, sessionEnded } from "./session-recovery";

test("a session eve has ended or stranded is ended; a refusal for anything else isn't", () => {
  assert.equal(sessionEnded(404, undefined), true);
  assert.equal(sessionEnded(409, "session_not_active"), true);
  assert.equal(sessionEnded(409, "session_stranded"), true);
  assert.equal(sessionEnded(409, "turn_active"), false);
  assert.equal(sessionEnded(429, undefined), false);
  assert.equal(sessionEnded(500, undefined), false);
});

test("a refused send asks the server again on an ended session or a server error, never on a limit or a refusal", () => {
  assert.equal(sendMayHaveLostSession(500, undefined), true);
  assert.equal(sendMayHaveLostSession(409, "session_stranded"), true);
  assert.equal(sendMayHaveLostSession(429, undefined), false);
  assert.equal(sendMayHaveLostSession(403, "forbidden"), false);
});

test("a probe's server error means the session is lost only in development", () => {
  assert.equal(probeSaysLost(500, undefined, true), true);
  assert.equal(probeSaysLost(500, undefined, false), false);
  assert.equal(probeSaysLost(404, undefined, false), true);
  assert.equal(probeSaysLost(202, undefined, true), false);
});
