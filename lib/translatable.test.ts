import assert from "node:assert/strict";
import { test } from "node:test";
import type { EveMessage } from "eve/client";
import { messageItems, textedItems } from "./translatable";

const message = (id: string, parts: Array<{ type: string; text?: string; state?: string }>, metadata: Record<string, unknown> = {}) =>
  ({ id, role: "assistant", parts, metadata }) as unknown as EveMessage;

test("translatable ids count a message's non-empty texts, and skip what's still on its way", () => {
  const items = messageItems([
    message("m1", [
      { type: "text", text: " ", state: "done" },
      { type: "dynamic-tool" },
      { type: "text", text: "First", state: "done" },
      { type: "text", text: "Second", state: "done" },
    ]),
    message("m2", [{ type: "text", text: "Done so far", state: "done" }, { type: "text", text: "Still writ", state: "streaming" }]),
    message("m3", [{ type: "text", text: "Sending", state: "done" }], { optimistic: true }),
  ]);
  assert.deepEqual(items, [
    { id: "m1:0", text: "First" },
    { id: "m1:1", text: "Second" },
    { id: "m2:0", text: "Done so far" },
  ]);
  assert.deepEqual(
    textedItems([
      { id: "msg_1", at: "", kind: "proactive", text: "Morning", file: null },
      { id: "msg_2", at: "", kind: "system", text: "", file: { name: "Q.pdf", href: null } },
    ]),
    [{ id: "texted:msg_1", text: "Morning" }],
  );
});
