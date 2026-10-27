process.env.BLOB_FAKE = "1";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { Chat, type Message, type ReactionEvent } from "chat";
import { asc, eq } from "drizzle-orm";
import { deliveries, messages } from "../schema/schema";
import { persistEvent } from "./conversation-events";
import { upsertThread } from "./conversations";
import { db } from "./db";
import {
  BACKOFF_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  claimNext,
  drainDeliveries,
  processMember,
  pruneDeliveries,
  readyMembers,
  recordDelivery,
  type DeliveryHandler,
} from "./deliveries";
import { addPhone, createMember, recordInbound } from "./members";
import {
  HANDOFF_GRACE_MS,
  PREVIOUS_TURN_WAIT_MS,
  intakePhotonWebhook,
  parseDelivery,
  photonDeliveryHandler,
  signPhotonWebhook,
  verifyPhotonSignature,
  type PhotonRuntime,
  type PhotonWebhookPayload,
} from "./photon-inbound";
import { updateProfile } from "./profile";
import { TEST_ORG, withTestDb } from "./test-db";

const SECRET = "test-webhook-secret";
const OWNER = "+13055550100";
const CREW = "+13055550142";
const LINE = "+15555550100";
const T0 = new Date("2026-10-18T15:00:00Z");

// The real adapter and Chat SDK parse deliveries, as the channel does; nothing here reaches Photon.
const adapter = createiMessageAdapter({ clients: { address: "127.0.0.1:9", phone: "shared", token: "fake" }, webhookSecret: SECRET });
const chat = new Chat({ adapters: { imessage: adapter }, state: createMemoryState(), userName: "Assistant" });
const parse: PhotonRuntime["parse"] = (payload) =>
  parseDelivery(payload, { parseMessage: (raw) => adapter.parseMessage(raw), thread: (id) => chat.thread(id) });
const encodeThreadId = (data: { chatGuid: string; phone?: string }) => adapter.encodeThreadId(data);

let seq = 0;
function textPayload(text: string, from = OWNER, extra: { id?: string; at?: Date } = {}): PhotonWebhookPayload {
  const id = extra.id ?? `pm_${++seq}`;
  return {
    event: "messages",
    message: {
      id,
      direction: "inbound",
      timestamp: (extra.at ?? T0).toISOString(),
      sender: { id: from, service: "iMessage" } as { id: string },
      content: { type: "text", text } as { type: string },
    },
    space: { id: `iMessage;-;${from}`, phone: LINE },
  };
}

function tapbackPayload(targetId: string, glyph: string, from = OWNER): PhotonWebhookPayload {
  return {
    event: "messages",
    message: { id: `rx_${++seq}`, direction: "inbound", timestamp: T0.toISOString(), sender: { id: from }, content: { type: "reaction", emoji: glyph, target: { id: targetId } } },
    space: { id: `iMessage;-;${from}`, phone: LINE },
  };
}

function signed(payload: unknown, options: { secret?: string; at?: Date; headers?: Record<string, string> } = {}): Request {
  const body = JSON.stringify(payload);
  const headers = signPhotonWebhook(body, options.secret ?? SECRET, Math.floor((options.at ?? T0).getTime() / 1000));
  return new Request("http://localhost/eve/v1/photon", { method: "POST", body, headers: { ...headers, "content-type": "application/json", ...options.headers } });
}

const intake = (request: Request, now = T0) => intakePhotonWebhook(request, { secret: SECRET, encodeThreadId, now });

async function owner(verified = true) {
  await updateProfile(TEST_ORG, { name: "Acme Widgets" }, "system");
  const member = await createMember({ orgId: TEST_ORG, name: "Pat Example", role: "owner" });
  const phone = await addPhone(TEST_ORG, member.id, OWNER);
  if (verified) await recordInbound(TEST_ORG, phone.id, encodeThreadId({ chatGuid: `iMessage;-;${OWNER}`, phone: LINE }), new Date(T0.getTime() - 60_000));
  return member;
}

/** A fake eve and Photon: records what was handed to eve and what was posted. */
function fakes(overrides: Partial<PhotonRuntime> = {}) {
  const sends: Array<{ threadId: string; content: unknown; deliveryId: unknown; context: string[] }> = [];
  const posts: Array<{ threadId: string; text: string }> = [];
  let n = 0;
  let clockAt = T0;
  const runtime: PhotonRuntime = {
    async send(thread, content, options) {
      sends.push({ threadId: thread.id, content, deliveryId: options.auth.attributes.deliveryId, context: options.context });
    },
    async post(threadId, text) {
      posts.push({ threadId, text });
      return [`out_${++n}`];
    },
    markRead: async () => {},
    parse,
    clock: () => clockAt,
    // Waiting for a previous turn moves this fake clock instead of real time.
    sleep: async (ms) => void (clockAt = new Date(clockAt.getTime() + ms)),
    ...overrides,
  };
  return {
    sends,
    posts,
    runtime,
    handler: photonDeliveryHandler(runtime),
    setClock: (at: Date) => void (clockAt = at),
    clock: () => clockAt,
  };
}

const rows = () => db().select().from(deliveries).orderBy(asc(deliveries.sentAt), asc(deliveries.id));
const inbound = () => db().select().from(messages).where(eq(messages.direction, "inbound"));
const later = (ms: number) => new Date(T0.getTime() + ms);

function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; errors: unknown[][]; warnings: unknown[][] }> {
  const errors: unknown[][] = [];
  const warnings: unknown[][] = [];
  const [error, warn] = [console.error, console.warn];
  console.error = (...args: unknown[]) => void errors.push(args);
  console.warn = (...args: unknown[]) => void warnings.push(args);
  return fn()
    .then((result) => ({ result, errors, warnings }))
    .finally(() => {
      console.error = error;
      console.warn = warn;
    });
}

test("the signature check matches the adapter's: good, stale, missing, and wrong", () => {
  const body = JSON.stringify({ hello: "world" });
  const nowSec = Math.floor(T0.getTime() / 1000);
  const headers = signPhotonWebhook(body, SECRET, nowSec);
  const check = (over: Partial<Parameters<typeof verifyPhotonSignature>[0]>) =>
    verifyPhotonSignature({ rawBody: body, secret: SECRET, signature: headers["x-spectrum-signature"], timestamp: headers["x-spectrum-timestamp"], nowSec, ...over });
  assert.deepEqual(check({}), { ok: true });
  assert.deepEqual(check({ nowSec: nowSec + 301 }), { ok: false, status: 400, reason: "stale or invalid timestamp" });
  assert.deepEqual(check({ signature: null }), { ok: false, status: 400, reason: "missing signature headers" });
  assert.deepEqual(check({ secret: "other" }), { ok: false, status: 401, reason: "bad signature" });
  assert.deepEqual(check({ rawBody: `${body} ` }), { ok: false, status: 401, reason: "bad signature" });
});

test("a stored delivery parses to what the adapter's own webhook path hands the Chat SDK", async () => {
  const captured: { message?: Message; reaction?: ReactionEvent } = {};
  // The adapter's webhook path, with a Chat stand-in that keeps what it's given.
  const probe = createiMessageAdapter({ clients: { address: "127.0.0.1:9", phone: "shared", token: "fake" }, webhookSecret: SECRET });
  (probe as unknown as { chat: unknown }).chat = {
    processMessage: (_a: unknown, _t: string, message: Message) => void (captured.message = message),
    processReaction: (event: ReactionEvent) => void (captured.reaction = event),
  };
  const nowSec = Math.floor(Date.now() / 1000);
  for (const payload of [textPayload("need a quote"), tapbackPayload("out_9", "👍")]) {
    const body = JSON.stringify(payload);
    const response = await probe.handleWebhook(new Request("http://x/", { method: "POST", body, headers: signPhotonWebhook(body, SECRET, nowSec) }));
    assert.equal(response.status, 200);
    const ours = parse(JSON.parse(body));
    if (ours.kind === "message") {
      const theirs = captured.message!;
      assert.equal(ours.message.id, theirs.id);
      assert.equal(ours.message.threadId, theirs.threadId);
      assert.equal(ours.message.text, theirs.text);
      assert.deepEqual(ours.message.author, theirs.author);
      assert.equal(ours.thread.id, theirs.threadId);
    } else {
      const theirs = captured.reaction!;
      assert.equal(ours.reaction.threadId, theirs.threadId);
      assert.equal(ours.reaction.messageId, theirs.messageId);
      assert.equal(ours.reaction.emoji.name, theirs.emoji.name);
      assert.equal(ours.reaction.rawEmoji, theirs.rawEmoji);
      assert.equal(ours.reaction.user.userId, theirs.user.userId);
    }
  }
  assert.equal(captured.reaction?.emoji.name, "thumbs_up");
});

withTestDb("the webhook refuses bad signatures and drops strangers, outbound posts, and events without storing them", async () => {
  await owner();
  const { result } = await quietly(async () => [
    await intake(signed(textPayload("hi"), { secret: "wrong" })),
    await intake(signed(textPayload("hi"), { at: later(-10 * 60_000) })),
    await intake(signed(textPayload("hi", "+13055559999"))),
    await intake(signed({ ...textPayload("hi"), message: { ...textPayload("hi").message, direction: "outbound" } })),
    await intake(signed({ ...textPayload("hi"), message: { ...textPayload("hi").message, content: { type: "typing" } } })),
    await intake(signed(textPayload("hi"), { headers: { "x-spectrum-event": "spaces" } })),
  ]);
  assert.deepEqual(result.map((r) => r.response.status), [401, 400, 200, 200, 200, 204]);
  assert.ok(result.every((r) => !r.queued));
  assert.equal((await rows()).length, 0);
  const missing = await quietly(() => intakePhotonWebhook(signed(textPayload("hi")), { secret: undefined, encodeThreadId }));
  assert.equal(missing.result.response.status, 500);
});

withTestDb("a duplicate delivery is stored once and handled once", async () => {
  await owner();
  const payload = textPayload("quote 100 Example St");
  const first = await intake(signed(payload));
  const again = await intake(signed(payload, { at: later(5_000), headers: { "x-spectrum-webhook-id": "wh_retry" } }));
  assert.equal(first.response.status, 200);
  assert.ok(first.queued);
  assert.equal(again.response.status, 200);
  assert.equal(again.queued, undefined);
  assert.deepEqual(await again.response.json(), { duplicate: first.queued.deliveryId });

  const { sends, handler } = fakes();
  await processMember(TEST_ORG, first.queued.memberId, handler, { clock: () => T0 });
  await processMember(TEST_ORG, first.queued.memberId, handler, { clock: () => later(60_000) });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].deliveryId, first.queued.deliveryId);
  assert.equal(sends[0].threadId, `imessage:iMessage;-;${OWNER}~${LINE}`);
  const [row] = await rows();
  assert.equal(row.status, "done");
  assert.equal(row.outcome, "dispatch");
  assert.equal(row.attempts, 1);
  assert.equal((await inbound()).length, 1);
});

withTestDb("a try that stops mid-way is picked up by the backstop and answered once, with one welcome", async () => {
  await owner(false); // first contact: the welcome goes out before the hand-off
  const { queued } = await intake(signed(textPayload("hi there")));
  assert.ok(queued);

  // The first try claims the text, verifies the phone, and posts the welcome, then the instance stops
  // before eve gets the turn: the handler never returns and nothing settles the delivery.
  let crash = true;
  const f = fakes({
    async send(thread, content, options) {
      if (crash) throw new Error("instance stopped");
      f.sends.push({ threadId: thread.id, content, deliveryId: options.auth.attributes.deliveryId, context: options.context });
    },
  });
  const claimed = await claimNext(TEST_ORG, queued.memberId, T0);
  assert.ok(claimed);
  await f.handler(claimed, { progress: { ...claimed.progress }, save: async (patch) => {
    await db().update(deliveries).set({ progress: { ...claimed.progress, ...patch } }).where(eq(deliveries.id, claimed.id));
    Object.assign(claimed.progress, patch);
  } }).catch(() => {});
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].text, /I'm automated/);

  // Within the lease, nothing is ready; after it, the backstop finds the stalled delivery.
  crash = false;
  assert.deepEqual(await readyMembers(later(LEASE_MS - 1000)), []);
  f.setClock(later(LEASE_MS + 1000));
  const { result, warnings } = await quietly(() => drainDeliveries(f.handler, { clock: f.clock }));
  assert.deepEqual(result, { members: 1, handled: 1 });
  assert.ok(warnings.some((w) => String(w[0]).includes("stalled")));
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].context.some((line) => line.startsWith("First text ever")));
  assert.equal(f.posts.length, 1, "no second welcome");
  assert.equal((await inbound()).length, 1);
  const [row] = await rows();
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 2);
});

withTestDb("a hand-off eve already got is not sent again; one eve never confirms is, after the grace", async () => {
  const member = await owner();
  await upsertThread(TEST_ORG, member.id, "ses_thread");
  const f = fakes();
  /** Runs a try that hands the text to eve, then stops before it's marked done: what a stopped instance leaves. */
  async function handOffThenStop(deliveryId: string) {
    const claimed = await claimNext(TEST_ORG, member.id, f.clock());
    assert.equal(claimed?.id, deliveryId);
    await f.handler(claimed!, {
      progress: { ...claimed!.progress },
      save: async (patch) => void (await db().update(deliveries).set({ progress: { ...claimed!.progress, ...patch } }).where(eq(deliveries.id, claimed!.id))),
    });
    await db().update(deliveries).set({ leaseUntil: new Date(f.clock().getTime() - 1) }).where(eq(deliveries.id, deliveryId));
  }

  // eve started the first one's turn: its events carry the delivery. The backstop marks it done.
  const first = await intake(signed(textPayload("first")));
  assert.ok(first.queued);
  await handOffThenStop(first.queued.deliveryId);
  const auth = { authenticator: "photon-imessage", principalId: `member:${member.id}`, attributes: { orgId: TEST_ORG, memberId: member.id, deliveryId: first.queued.deliveryId } };
  await persistEvent({ type: "turn.started", data: { turnId: "t1" }, meta: { id: "evt_t1", at: T0.toISOString() } }, { id: "ses_thread", auth });
  await persistEvent({ type: "turn.completed", data: { turnId: "t1" }, meta: { id: "evt_t1_done", at: later(500).toISOString() } }, { id: "ses_thread", auth });
  f.setClock(later(10_000));
  await quietly(() => drainDeliveries(f.handler, { clock: f.clock }));
  assert.equal((await rows())[0].status, "done");
  assert.equal(f.sends.length, 1);

  // The second never reached eve. Within the grace it waits; after it, it's sent again, once.
  const second = await intake(signed(textPayload("second", OWNER, { at: later(10_000) }), { at: later(10_000) }), later(10_000));
  assert.ok(second.queued);
  await handOffThenStop(second.queued.deliveryId);
  assert.equal(f.sends.length, 2);
  f.setClock(later(40_000));
  await quietly(() => drainDeliveries(f.handler, { clock: f.clock }));
  let b = (await rows())[1];
  assert.equal(b.status, "pending");
  assert.equal(b.outcome, "handoff_unconfirmed");
  assert.equal(b.attempts, 1, "a wait isn't a try");
  assert.equal(f.sends.length, 2);

  f.setClock(later(10_000 + HANDOFF_GRACE_MS + 60_000));
  const { warnings } = await quietly(() => drainDeliveries(f.handler, { clock: f.clock }));
  b = (await rows())[1];
  assert.equal(b.status, "done");
  assert.equal(f.sends.length, 3);
  assert.equal(f.sends[2].deliveryId, second.queued.deliveryId);
  assert.ok(warnings.some((w) => String(w[0]).includes("never confirmed")));
});

withTestDb("one member's texts reach eve in the order they were sent, even with two workers at once", async () => {
  const member = await owner();
  // A burst of three, arriving out of order.
  for (const [text, ms] of [["third", 3000], ["first", 1000], ["second", 2000]] as const) {
    await intake(signed(textPayload(text, OWNER, { at: later(ms) }), { at: later(4000) }), later(4000));
  }
  const order: string[] = [];
  const f = fakes({
    async send(_thread, content) {
      await new Promise((r) => setTimeout(r, 20));
      order.push(typeof content === "string" ? content : "?");
    },
  });
  const clock = () => later(5000);
  const counts = await Promise.all([processMember(TEST_ORG, member.id, f.handler, { clock }), processMember(TEST_ORG, member.id, f.handler, { clock })]);
  assert.equal(counts[0] + counts[1], 3);
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.ok((await rows()).every((r) => r.status === "done" && r.attempts === 1));
});

withTestDb("a held lease is respected and a stalled one is released", async () => {
  const member = await owner();
  const { queued } = await intake(signed(textPayload("hello")));
  assert.ok(queued);
  const held = await claimNext(TEST_ORG, member.id, T0);
  assert.ok(held);
  const f = fakes();
  assert.equal(await processMember(TEST_ORG, member.id, f.handler, { clock: () => later(60_000) }), 0);
  assert.equal(f.sends.length, 0);
  await quietly(() => processMember(TEST_ORG, member.id, f.handler, { clock: () => later(LEASE_MS + 1) }));
  assert.equal(f.sends.length, 1);
  const [row] = await rows();
  assert.equal(row.status, "done");
});

withTestDb("after the last failed try a delivery is dead: logged, nobody texted, and the member's next text goes through", async () => {
  const member = await owner();
  const bad = await intake(signed(textPayload("this one fails")));
  const next = await intake(signed(textPayload("this one works", OWNER, { at: later(1000) })));
  assert.ok(bad.queued && next.queued);
  const f = fakes({
    async send(thread, content, options) {
      if (content === "this one fails") throw new Error("eve unavailable");
      f.sends.push({ threadId: thread.id, content, deliveryId: options.auth.attributes.deliveryId, context: options.context });
    },
  });
  let at = T0.getTime();
  const { errors, warnings } = await quietly(async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await processMember(TEST_ORG, member.id, f.handler, { clock: () => new Date(at) });
      at += (BACKOFF_MS[attempt - 1] ?? 0) + 1000;
    }
  });
  const [dead, ok] = await rows();
  assert.equal(dead.status, "dead");
  assert.equal(dead.attempts, MAX_ATTEMPTS);
  assert.match(dead.lastError ?? "", /eve unavailable/);
  assert.equal(warnings.filter((w) => String(w[0]).includes("will be retried")).length, MAX_ATTEMPTS - 1);
  assert.equal(errors.filter((e) => String(e[0]).includes("dead-lettered")).length, 1);
  assert.equal(f.posts.length, 0, "nobody is texted");
  assert.equal(ok.status, "done");
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].content, "this one works");
  // Pruned once past retention.
  assert.equal(await pruneDeliveries(new Date(Date.now() + 31 * 24 * 60 * 60_000)), 2);
});

withTestDb("a tapback is queued and handled like a text, and a STOP still stops", async () => {
  const member = await owner();
  const crew = await createMember({ orgId: TEST_ORG, name: "Carlos", role: "member", addedByMemberId: member.id });
  await addPhone(TEST_ORG, crew.id, CREW);
  const tap = await intake(signed(tapbackPayload("out_unknown", "👍")));
  const stop = await intake(signed(textPayload("STOP", CREW)));
  assert.ok(tap.queued && stop.queued);
  const f = fakes();
  await drainDeliveries(f.handler, { clock: () => later(1000) });
  const done = await rows();
  assert.deepEqual(done.map((r) => [r.kind, r.status, r.outcome]).sort(), [
    ["message", "done", "stop"],
    ["reaction", "done", "dispatch"],
  ]);
  assert.equal(f.sends.length, 1);
  assert.match(String(f.sends[0].content), /👍/);
  assert.ok(f.posts.some((p) => /unsubscribed/.test(p.text)));
});

withTestDb("recordDelivery dedupes on the provider id", async () => {
  const member = await owner();
  const input = { orgId: TEST_ORG, memberId: member.id, providerMessageId: "pm_x", kind: "message" as const, threadId: "imessage:x", payload: {} };
  const a = await recordDelivery(input);
  const b = await recordDelivery({ ...input, webhookId: "wh_2" });
  assert.deepEqual(b, { id: a.id, duplicate: true });
  const handler: DeliveryHandler = async () => ({ kind: "done", outcome: "ok" });
  assert.equal(await processMember(TEST_ORG, member.id, handler), 1);
});

withTestDb("a text waits for the member's previous turn to finish, so each gets its own turn; past the wait it goes anyway", async () => {
  const member = await owner();
  await upsertThread(TEST_ORG, member.id, "ses_thread");
  const first = await intake(signed(textPayload("first")));
  const second = await intake(signed(textPayload("second", OWNER, { at: later(500) })));
  assert.ok(first.queued && second.queued);
  const auth = (deliveryId: string) => ({ authenticator: "photon-imessage", principalId: `member:${member.id}`, attributes: { orgId: TEST_ORG, memberId: member.id, deliveryId } });
  const timeline: string[] = [];
  let sleeps = 0;
  const f = fakes({
    async send(_thread, content) {
      timeline.push(`send ${String(content)}`);
    },
  });
  f.runtime.sleep = async (ms) => {
    sleeps += 1;
    f.setClock(new Date(f.clock().getTime() + ms));
    // eve starts the first text's turn after a moment, and ends it a few seconds later.
    if (sleeps === 2) await persistEvent({ type: "turn.started", data: { turnId: "t1" }, meta: { id: "e1", at: f.clock().toISOString() } }, { id: "ses_thread", auth: auth(first.queued!.deliveryId) });
    if (sleeps === 5) {
      await persistEvent({ type: "turn.completed", data: { turnId: "t1" }, meta: { id: "e2", at: f.clock().toISOString() } }, { id: "ses_thread", auth: auth(first.queued!.deliveryId) });
      timeline.push("first turn ended");
    }
  };
  const handler = photonDeliveryHandler(f.runtime);
  await processMember(TEST_ORG, member.id, handler, { clock: f.clock });
  assert.deepEqual(timeline, ["send first", "first turn ended", "send second"]);
  const [, row] = await rows();
  assert.equal(row.progress.dispatchStartedAt, f.clock().toISOString(), "the hand-off time is after the wait");

  // A turn that never ends doesn't hold the next text past the wait.
  const third = await intake(signed(textPayload("third", OWNER, { at: later(1000) })), f.clock());
  assert.ok(third.queued);
  await persistEvent({ type: "turn.started", data: { turnId: "t2" }, meta: { id: "e3", at: f.clock().toISOString() } }, { id: "ses_thread", auth: auth(second.queued.deliveryId) });
  f.runtime.sleep = async (ms) => void f.setClock(new Date(f.clock().getTime() + ms));
  const start = f.clock().getTime();
  const { warnings } = await quietly(() => processMember(TEST_ORG, member.id, photonDeliveryHandler(f.runtime), { clock: f.clock }));
  assert.equal(timeline.at(-1), "send third");
  assert.ok(f.clock().getTime() - start >= PREVIOUS_TURN_WAIT_MS);
  assert.ok(warnings.some((w) => String(w[0]).includes("previous turn is still going")));
});
