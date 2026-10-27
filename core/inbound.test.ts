import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORWARDED_REACTIONS,
  contextLines,
  decideInbound,
  failureText,
  helpText,
  inviteText,
  reactionTurnText,
  startText,
  stopText,
  welcomeText,
  type PhoneRow,
} from "./inbound";

const ph = (status: PhoneRow["status"]): PhoneRow => ({ id: "ph", memberId: "m", status });
const base = (phone: PhoneRow | null) => ({ hasAttachments: false, isBot: false, phone, duplicate: false });

test("bot messages are ignored before anything else", () => {
  assert.deepEqual(decideInbound({ text: "STOP", ...base(null), isBot: true }), { kind: "ignore", reason: "bot" });
});

test("unknown phone is ignored silently", () =>
  assert.deepEqual(decideInbound({ text: "hi", ...base(null) }), { kind: "ignore", reason: "unknown_phone" }));

test("duplicate delivery is ignored, even for STOP", () => {
  assert.deepEqual(decideInbound({ text: "hi", ...base(ph("verified")), duplicate: true }), {
    kind: "ignore",
    reason: "duplicate",
  });
  assert.equal(decideInbound({ text: "STOP", ...base(ph("verified")), duplicate: true }).kind, "ignore");
});

test("STOP works even when already stopped, START restarts, HELP answers", () => {
  assert.equal(decideInbound({ text: " Stop ", ...base(ph("stopped")) }).kind, "stop");
  assert.equal(decideInbound({ text: "unsubscribe", ...base(ph("verified")) }).kind, "stop");
  for (const word of ["STOPALL", "cancel", "End", "QUIT"]) {
    assert.equal(decideInbound({ text: word, ...base(ph("verified")) }).kind, "stop", word);
  }
  assert.equal(decideInbound({ text: "START", ...base(ph("stopped")) }).kind, "start");
  assert.equal(decideInbound({ text: "unstop", ...base(ph("stopped")) }).kind, "start");
  assert.equal(decideInbound({ text: "help", ...base(ph("verified")) }).kind, "help");
  assert.equal(decideInbound({ text: "Info", ...base(ph("pending")) }).kind, "help");
});

test("keywords match the whole message only", () => {
  assert.deepEqual(decideInbound({ text: "stop by the shop at 3", ...base(ph("verified")) }), {
    kind: "dispatch",
    welcome: false,
  });
  assert.deepEqual(decideInbound({ text: "help me quote 4512 Palm Ave", ...base(ph("verified")) }), {
    kind: "dispatch",
    welcome: false,
  });
});

test("HELP and INFO from a stopped phone still get the help line", () => {
  assert.equal(decideInbound({ text: "HELP", ...base(ph("stopped")) }).kind, "help");
  assert.equal(decideInbound({ text: " info ", ...base(ph("stopped")) }).kind, "help");
});

test("stopped phones get nothing for ordinary texts", () =>
  assert.deepEqual(decideInbound({ text: "quote 1 window", ...base(ph("stopped")) }), { kind: "ignore", reason: "stopped" }));

test("first text from a pending phone dispatches with welcome", () =>
  assert.deepEqual(decideInbound({ text: "hi", ...base(ph("pending")) }), { kind: "dispatch", welcome: true }));

test("a verified phone dispatches without welcome", () =>
  assert.deepEqual(decideInbound({ text: "hi", ...base(ph("verified")) }), { kind: "dispatch", welcome: false }));

test("a photo with no text still dispatches; nothing at all is empty", () => {
  assert.equal(decideInbound({ text: "", hasAttachments: true, isBot: false, phone: ph("verified"), duplicate: false }).kind, "dispatch");
  assert.deepEqual(decideInbound({ text: "   ", ...base(ph("verified")) }), { kind: "ignore", reason: "empty" });
});

test("welcome text names the business, the member, and says it is automated, in both languages", () => {
  const en = welcomeText({ businessName: "Palm Coast Lawn", memberName: "Pat Jones", language: "en" });
  assert.match(en, /Pat/);
  assert.doesNotMatch(en, /Jones/);
  assert.match(en, /Palm Coast Lawn/);
  assert.match(en, /automated/i);
  const es = welcomeText({ businessName: "Palm Coast Lawn", memberName: "Pat", language: "es" });
  assert.match(es, /automatizad/i);
  assert.match(es, /Palm Coast Lawn/);
});

test("welcome text is at most two lines; crew welcome names who added them", () => {
  const owner = welcomeText({ businessName: "Palm Coast Lawn", memberName: "Pat", language: "en" });
  assert.ok(owner.split("\n").length <= 2);
  assert.doesNotMatch(owner, /added you/);
  for (const language of ["en", "es"] as const) {
    const crew = welcomeText({ businessName: "Palm Coast Lawn", memberName: "Carlos", language, addedByName: "Pat" });
    assert.ok(crew.split("\n").length <= 2, language);
    assert.match(crew, /Pat/);
    assert.match(crew, /Carlos/);
  }
  const crewEn = welcomeText({ businessName: "Palm Coast Lawn", memberName: "Carlos", language: "en", addedByName: "Pat" });
  assert.match(crewEn, /Pat added you/);
  assert.match(crewEn, /approves/);
  assert.match(crewEn, /automated/i);
});

test("invite text is forwardable and formats a US line", () => {
  assert.equal(
    inviteText({ businessName: "Palm Coast Lawn", memberName: "Carlos", assignedLine: "+17865550199", language: "en" }),
    "Carlos, this is Palm Coast Lawn's quoting assistant. Text me at (786) 555-0199 to send in jobs.",
  );
  assert.match(
    inviteText({ businessName: "Palm Coast Lawn", memberName: "Carlos Ruiz", assignedLine: "(786) 555-0199", language: "es" }),
    /^Carlos, .*Palm Coast Lawn.*\(786\) 555-0199/,
  );
});

test("reactionTurnText quotes the target and truncates at 160 chars", () => {
  assert.equal(reactionTurnText({ glyph: "👍", targetBody: null }), "👍 (tapback)");
  assert.equal(
    reactionTurnText({ glyph: "👍", targetBody: "Quote for Palm Ave: $392" }),
    '👍 (tapback on your message: "Quote for Palm Ave: $392")',
  );
  const long = reactionTurnText({ glyph: "❤️", targetBody: "x".repeat(300) });
  assert.equal(long, `❤️ (tapback on your message: "${"x".repeat(160)}")`);
});

test("forwarded reactions drop laugh and exclamation", () => {
  assert.deepEqual([...FORWARDED_REACTIONS], ["thumbs_up", "heart", "thumbs_down", "question"]);
});

test("help, stop, and start texts exist in both languages", () => {
  assert.match(helpText("Palm Coast Lawn", "en"), /Palm Coast Lawn/);
  assert.match(helpText("Palm Coast Lawn", "es"), /Palm Coast Lawn/);
  assert.match(helpText("Palm Coast Lawn", "en"), /STOP/);
  assert.match(stopText("en"), /START/);
  assert.match(stopText("es"), /START/);
  assert.ok(startText("en").length > 0 && startText("es").length > 0);
  assert.notEqual(startText("en"), startText("es"));
});

const rick = { orgId: "org_1", memberId: "m1", name: "Pat", role: "owner" as const, language: "en" as const, phoneE164: "+15555550101" };
const now = new Date("2026-10-16T18:00:00Z");

test("contextLines includes role, pending items, and last proactive message", () => {
  const lines = contextLines({
    caller: rick,
    pending: ["Palm Ave quote needs your approval"],
    lastProactive: { text: "Carlos drafted $392 for Palm Ave", at: new Date("2026-10-16T16:00:00Z") },
    now,
  });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Member: Pat (owner). Reply in the language of their message; when unclear, English.");
  assert.match(lines[1], /^Waiting on them: Palm Ave quote needs your approval/);
  assert.equal(lines[2], "You last texted them 2h ago: 'Carlos drafted $392 for Palm Ave'");
});

test("contextLines has only the member line when nothing is pending", () => {
  assert.deepEqual(contextLines({ caller: rick, pending: [], lastProactive: null, now }), [
    "Member: Pat (owner). Reply in the language of their message; when unclear, English.",
  ]);
});

test("contextLines adds the first-contact and reaction-quote lines when given", () => {
  const lines = contextLines({
    caller: rick,
    pending: [],
    lastProactive: null,
    now,
    firstContact: true,
    reactionQuote: { quoteId: "q_1", title: "Palm Ave", status: "draft", asksApproval: true },
  });
  assert.ok(lines.some((l) => l.startsWith("First text ever from Pat. The welcome was already sent.")));
  assert.ok(lines.some((l) => l.includes("photos help")));
  assert.ok(lines.includes('The tapback is on a message about quote q_1 "Palm Ave" (status draft).'));
});

test("contextLines names the tapped revision and tells the model to pass it to approve_quote", () => {
  const lines = contextLines({
    caller: rick,
    pending: [],
    lastProactive: null,
    now,
    reactionQuote: { quoteId: "q_1", title: "Palm Ave", status: "draft", revisionNumber: 2, asksApproval: true },
  });
  assert.ok(
    lines.includes(
      'The tapback is on a message about quote q_1 "Palm Ave" (status draft), revision 2. ' +
        "If you approve it, pass expectedRevisionNumber 2 to approve_quote.",
    ),
  );
});

test("contextLines says a tapped message about a quote did not ask for approval, with no approve hint", () => {
  const lines = contextLines({
    caller: rick,
    pending: [],
    lastProactive: null,
    now,
    reactionQuote: { quoteId: "q_1", title: "Palm Ave", status: "draft", revisionNumber: 2, asksApproval: false },
  });
  assert.ok(
    lines.includes(
      'The tapback is on a message about quote q_1 "Palm Ave" (status draft) that did not ask for approval, so it is not an approval.',
    ),
  );
  assert.ok(!lines.some((l) => l.includes("expectedRevisionNumber")));
});

test("failureText is one fixed line per language", () => {
  assert.equal(failureText("en"), "Something went wrong on my end. Try that again in a minute.");
  assert.equal(failureText("es"), "Algo falló de mi lado. Inténtalo de nuevo en un minuto.");
});
