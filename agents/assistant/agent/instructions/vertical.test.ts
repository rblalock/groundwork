import assert from "node:assert/strict";
import { after, test } from "node:test";
import { verticalInstructions } from "./vertical";

const saved = process.env.VERTICAL;
after(() => {
  if (saved === undefined) delete process.env.VERTICAL;
  else process.env.VERTICAL = saved;
});

test("no overlay without VERTICAL, the trade's overlay with it", () => {
  delete process.env.VERTICAL;
  assert.equal(verticalInstructions(), null);
  process.env.VERTICAL = "none";
  assert.equal(verticalInstructions(), null);
  process.env.VERTICAL = "landscaping";
  assert.match(verticalInstructions() ?? "", /mulch/);
});
