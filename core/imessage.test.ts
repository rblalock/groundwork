import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addReaction, chunkText, createAdapter, getBot, postFile, postText, registerBot, setTransportForTests, type Bot } from "./imessage";

afterEach(() => setTransportForTests(null));

test("chunkText keeps chunks under the limit and whole", () => {
  const chunks = chunkText("a".repeat(1400) + "\n\n" + "b".repeat(1400), 1500);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 1500 && c.length > 0));
  assert.equal(chunks.join(""), "a".repeat(1400) + "b".repeat(1400));
});

test("chunkText returns short text as one chunk and nothing for blank text", () => {
  assert.deepEqual(chunkText("hello"), ["hello"]);
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("  \n\n  "), []);
});

test("chunkText packs small paragraphs together", () => {
  assert.deepEqual(chunkText("one\n\ntwo\n\nthree", 100), ["one\n\ntwo\n\nthree"]);
});

test("chunkText splits an oversized paragraph on sentences", () => {
  const sentence = "This is a sentence of moderate length that keeps going. ";
  const text = sentence.repeat(10).trim();
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 200 && c.length > 0));
  for (const chunk of chunks) assert.match(chunk, /\.$/);
  assert.equal(chunks.join(" "), text);
});

test("chunkText hard-splits text with no boundaries and never returns an empty chunk", () => {
  const chunks = chunkText("z".repeat(3300), 1500);
  assert.deepEqual(chunks.map((c) => c.length), [1500, 1500, 300]);
  assert.ok(chunkText("a\n\n\n\n\n\nb", 1).every((c) => c.length > 0));
});

test("getBot throws before registration", () => assert.throws(() => getBot(), /iMessage bot is not registered/));

test("createAdapter throws when the project credentials are unset", () => {
  const saved = { id: process.env.IMESSAGE_PROJECT_ID, secret: process.env.IMESSAGE_PROJECT_SECRET, fake: process.env.IMESSAGE_FAKE };
  delete process.env.IMESSAGE_PROJECT_ID;
  delete process.env.IMESSAGE_PROJECT_SECRET;
  // The real adapter's checks: tests otherwise run with the fake (scripts/test-env.ts).
  delete process.env.IMESSAGE_FAKE;
  try {
    assert.throws(() => createAdapter(), /IMESSAGE_PROJECT_ID/);
  } finally {
    if (saved.id !== undefined) process.env.IMESSAGE_PROJECT_ID = saved.id;
    if (saved.secret !== undefined) process.env.IMESSAGE_PROJECT_SECRET = saved.secret;
    if (saved.fake !== undefined) process.env.IMESSAGE_FAKE = saved.fake;
  }
});

test("createAdapter in warn mode builds an adapter that fails only on first use", async () => {
  const saved = { id: process.env.IMESSAGE_PROJECT_ID, secret: process.env.IMESSAGE_PROJECT_SECRET, fake: process.env.IMESSAGE_FAKE };
  delete process.env.IMESSAGE_PROJECT_ID;
  delete process.env.IMESSAGE_PROJECT_SECRET;
  // The real adapter's checks: tests otherwise run with the fake (scripts/test-env.ts).
  delete process.env.IMESSAGE_FAKE;
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    const adapter = createAdapter({ onMissing: "warn" });
    assert.equal(warnings.length, 1);
    await assert.rejects(adapter.openDM("+15555550101"), /IMESSAGE_PROJECT_ID/);
  } finally {
    console.warn = warn;
    if (saved.id !== undefined) process.env.IMESSAGE_PROJECT_ID = saved.id;
    if (saved.secret !== undefined) process.env.IMESSAGE_PROJECT_SECRET = saved.secret;
    if (saved.fake !== undefined) process.env.IMESSAGE_FAKE = saved.fake;
  }
});

test("the test transport replaces the bot", async () => {
  const calls: unknown[][] = [];
  setTransportForTests({
    postText: async (...args) => (calls.push(["text", ...args]), ["id1"]),
    postFile: async (...args) => (calls.push(["file", ...args]), "id2"),
    addReaction: async (...args) => void calls.push(["react", ...args]),
  });
  assert.deepEqual(await postText("t", "hi"), ["id1"]);
  assert.equal(await postFile("t", { filename: "a.pdf", mimeType: "application/pdf", data: Buffer.from("x") }), "id2");
  await addReaction("t", "m", "thumbs_up");
  assert.deepEqual(calls.map((c) => c[0]), ["text", "file", "react"]);
});

// Last in the file: it registers a bot for the rest of the run.
test("postFile returns the file bubble's id, since the adapter returns the first message it sends", async () => {
  // Mirrors the Photon adapter's postMessage: text first when non-empty, then each file; the id is the first one sent.
  const sent: string[] = [];
  const space = (content: string) => (sent.push(content), { id: `${content}_${sent.length}` });
  const fakeBot = {
    thread: () => ({
      post: async (message: { markdown?: string; files?: unknown[] }) => {
        let first: { id: string } | undefined;
        if (message.markdown?.trim()) first = space("text");
        for (const _file of message.files ?? []) {
          const sentFile = space("file");
          first ??= sentFile;
        }
        if (!first) throw new Error("postMessage requires non-empty text or at least one attachment");
        return first;
      },
    }),
  };
  registerBot(fakeBot as unknown as Bot);
  const fake = process.env.IMESSAGE_FAKE;
  delete process.env.IMESSAGE_FAKE;
  try {
    const id = await postFile("t", { filename: "a.pdf", mimeType: "application/pdf", data: Buffer.from("x") });
    assert.deepEqual(sent, ["file"]);
    assert.equal(id, "file_1");
  } finally {
    if (fake !== undefined) process.env.IMESSAGE_FAKE = fake;
  }
});
