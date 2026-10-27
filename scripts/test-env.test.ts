import assert from "node:assert/strict";
import { test } from "node:test";
import { postText } from "../core/imessage";
import { OFFLINE_ENV } from "../core/offline";

// Guards `scripts/test-env.ts`: run outside `npm test` / `npm run test:db`, or with the preload dropped,
// this fails before any other test can text a real phone.
test("tests run offline: fake iMessage and Photon admin, no Photon or Resend credentials", async () => {
  for (const [name, value] of Object.entries(OFFLINE_ENV)) assert.equal(process.env[name], value, name);
  const logged: unknown[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    // No test transport and no bot: only the fake can answer.
    const ids = await postText("thread:+15555550100", "hello");
    assert.equal(ids.length, 1);
    assert.match(ids[0], /^fake_/);
  } finally {
    console.log = log;
  }
  assert.match(String(logged[0]), /imessage \(fake\)/);
});
