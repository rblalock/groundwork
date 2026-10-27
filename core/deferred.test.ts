import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { defer, pendingDeferred, setDeferScheduler, settleDeferred } from "./deferred";

afterEach(() => setDeferScheduler(null));

test("settleDeferred waits for deferred work, and for work it defers in turn", async () => {
  const done: string[] = [];
  defer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    done.push("first");
    defer(async () => {
      done.push("second");
    });
  });
  assert.equal(pendingDeferred(), 1);
  await settleDeferred();
  assert.deepEqual(done, ["first", "second"]);
  assert.equal(pendingDeferred(), 0);
});

test("an injected scheduler decides when work starts, and settling still covers it", async () => {
  const queued: Array<() => Promise<unknown>> = [];
  setDeferScheduler((task) => void queued.push(task));
  let ran = false;
  defer(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(pendingDeferred(), 1);
  const settled = settleDeferred();
  await queued[0]();
  await settled;
  assert.equal(ran, true);
});

test("a failing task is logged and settled, and a stuck one fails settling instead of hanging", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    defer(async () => {
      throw new Error("boom");
    });
    await settleDeferred();
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  defer(() => gate);
  await assert.rejects(settleDeferred(20), /still running/);
  release();
  await settleDeferred();
});
