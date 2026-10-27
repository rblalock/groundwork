import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecordLink, linkRecords, quoteIdOf, recordLinksOf, replyExtras, toolChipsOf, type RecordLink, type ToolCallPart } from "./chat-tools";

const call = (toolName: string, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: `${toolName}_${Math.random()}`,
  state: "output-available",
  input: {},
  output: {},
  ...extra,
});

test("chips: one per tool and outcome, repeats counted, housekeeping and unfinished calls left out", () => {
  const parts = [
    { type: "text" },
    call("find_customer"),
    call("eve__skill"),
    call("find_customer"),
    call("create_quote", { output: { quoteId: "quo_1" } }),
    call("approve_quote", { output: { error: "NOT_PRIVILEGED: only owners" } }),
    call("save_note", { state: "output-error" }),
    call("start_job"),
    call("book_visit", { state: "input-available" }),
  ];
  assert.deepEqual(toolChipsOf(parts), [
    { tool: "find_customer", count: 2, failed: false, detail: null },
    { tool: "create_quote", count: 1, failed: false, detail: null },
    { tool: "approve_quote", count: 1, failed: true, detail: null },
    { tool: "save_note", count: 1, failed: true, detail: null },
  ]);
  assert.deepEqual(toolChipsOf([{ type: "text" }, call("no_reply")]), []);
});

test("a quote tool's quote: from its output, the approval's quote, or its input; none when it failed", () => {
  assert.equal(quoteIdOf(call("create_quote", { output: { quoteId: "quo_1" } })), "quo_1");
  assert.equal(quoteIdOf(call("approve_quote", { output: { ok: true, quote: { quoteId: "quo_2" } } })), "quo_2");
  assert.equal(quoteIdOf(call("set_quote_outcome", { input: { quoteId: "quo_3" }, output: { status: "won" } })), "quo_3");
  assert.equal(quoteIdOf(call("revise_quote", { input: { quoteId: "quo_4" }, output: { error: "QUOTE_NOT_FOUND" } })), null);
  assert.equal(quoteIdOf(call("find_customer", { output: { quoteId: "quo_5" } })), null);
});

test("a reply's chips and cards go under its last message; a quote's card only under the latest reply about it", () => {
  const messages = [
    { id: "m1", role: "assistant", parts: [call("create_quote", { output: { quoteId: "quo_1" } })] },
    { id: "m2", role: "user", parts: [{ type: "text" }] },
    // One reply in two messages: the tool calls, then the words.
    { id: "m3", role: "assistant", parts: [call("revise_quote", { output: { quoteId: "quo_1" } }), call("create_quote", { output: { quoteId: "quo_2" } })] },
    { id: "m4", role: "assistant", parts: [{ type: "text" }] },
    { id: "m5", role: "user", parts: [{ type: "text" }] },
    { id: "m6", role: "assistant", parts: [call("get_quote", { input: { quoteId: "quo_2" }, output: { error: "boom" } })] },
  ];
  const extras = replyExtras(messages);
  assert.deepEqual([...extras.keys()], ["m1", "m4", "m6"]);
  assert.deepEqual(extras.get("m1"), { chips: [{ tool: "create_quote", count: 1, failed: false, detail: null }], quoteIds: [], links: [], turnId: null, parts: messages[0].parts });
  assert.deepEqual(extras.get("m4")?.chips.map((c) => c.tool), ["revise_quote", "create_quote"]);
  assert.deepEqual(extras.get("m4")?.quoteIds, ["quo_1", "quo_2"]);
  assert.deepEqual(extras.get("m6"), { chips: [{ tool: "get_quote", count: 1, failed: true, detail: null }], quoteIds: [], links: [], turnId: null, parts: messages[5].parts });
});

test("a reply's turn and all its parts, from every message of the run, go under its last message", () => {
  const reasoning = { type: "reasoning", text: "Price the mulch first." };
  const tool = call("create_quote", { output: { quoteId: "quo_1" } });
  const words = { type: "text", text: "Here's the quote." };
  const messages = [
    { id: "m1", role: "user", parts: [{ type: "text" }], metadata: { turnId: "turn_1" } },
    { id: "m2", role: "assistant", parts: [reasoning, tool], metadata: { turnId: "turn_1" } },
    { id: "m3", role: "assistant", parts: [words], metadata: { turnId: "turn_1" } },
    { id: "m4", role: "user", parts: [{ type: "text" }] },
    // A message without a turn (imported history) keeps the run's turn unknown.
    { id: "m5", role: "assistant", parts: [{ type: "text" }] },
  ];
  const extras = replyExtras(messages);
  assert.equal(extras.get("m3")?.turnId, "turn_1");
  assert.deepEqual(extras.get("m3")?.parts, [reasoning, tool, words]);
  assert.equal(extras.get("m2"), undefined);
  assert.equal(extras.get("m5")?.turnId, null);
});

test("the records a reply's tools returned link their first mention to their page, and nothing else", () => {
  const parts = [
    {
      type: "dynamic-tool",
      toolName: "list_invoices",
      toolCallId: "1",
      state: "output-available",
      output: { invoices: [{ invoiceId: "inv_a", label: "INV-0003", customerId: "cus_r", customerName: "Pat Sample" }] },
    },
    {
      type: "dynamic-tool",
      toolName: "read_schedule",
      toolCallId: "2",
      state: "output-available",
      output: { visits: [{ visitId: "vis_x", quoteId: "quo_q", title: "10 outside windows", date: "2026-10-19" }] },
    },
    { type: "dynamic-tool", toolName: "get_quote", toolCallId: "3", state: "output-error", output: { quoteId: "quo_z", title: "Failed one" } },
  ];
  const links = recordLinksOf(parts);
  assert.deepEqual(links, [
    { text: "INV-0003", href: "/invoices/inv_a", kind: "invoice" },
    { text: "Pat Sample", href: "/customers/cus_r", kind: "customer" },
    { text: "10 outside windows", href: "/schedule?view=day&date=2026-10-19&visit=vis_x", kind: "visit" },
  ]);
  assert.equal(
    linkRecords("INV-0003 · Pat Sample · 10 outside windows\nPat Sample again · `INV-0003` · [INV-0003](/x) · INV-00031", links),
    "[INV-0003](/invoices/inv_a) · [Pat Sample](/customers/cus_r) · [10 outside windows](/schedule?view=day&date=2026-10-19&visit=vis_x)\nPat Sample again · `INV-0003` · [INV-0003](/x) · INV-00031",
  );
  assert.equal(linkRecords("nothing here", links), "nothing here");
});

test("a reply's records link however it words them: any case or spacing, short forms, a first name", () => {
  const links: RecordLink[] = [
    { text: "INV-0007", href: "/invoices/inv_7", kind: "invoice" },
    { text: "Jane Example", href: "/customers/cus_j", kind: "customer" },
    { text: "1 Example St, back porch", href: "/quotes/quo_b", kind: "quote" },
    { text: "Bo O'Sample", href: "/customers/cus_b", kind: "customer" },
  ];
  assert.equal(
    linkRecords("Sent inv-7 to jane. The 1 example st quote is approved, and Bo O’Sample paid.", links),
    "Sent [inv-7](/invoices/inv_7) to [jane](/customers/cus_j). The [1 example st](/quotes/quo_b) quote is approved, and [Bo O’Sample](/customers/cus_b) paid.",
  );
  // The whole title wins over its short form, and each record links once.
  assert.equal(
    linkRecords("1 Example St, back porch is booked. 1 Example St again.", links),
    "[1 Example St, back porch](/quotes/quo_b) is booked. 1 Example St again.",
  );
  // Two customers named Jane: neither first name alone is enough.
  const twoJanes: RecordLink[] = [...links, { text: "Jane Sample", href: "/customers/cus_s", kind: "customer" }];
  assert.equal(linkRecords("Jane said yes.", twoJanes), "Jane said yes.");
  assert.equal(linkRecords("INV-17 and INV-70", links), "INV-17 and INV-70");
});

test("a reply also links records an earlier reply looked up, by their exact name", () => {
  const messages = [
    { id: "m1", role: "assistant", parts: [call("find_customer", { output: { customers: [{ id: "cus_j", name: "Jane Example" }] } })] },
    { id: "m2", role: "user", parts: [{ type: "text" }] },
    { id: "m3", role: "assistant", parts: [{ type: "text" }] },
  ];
  const links = replyExtras(messages).get("m3")?.links ?? [];
  assert.deepEqual(links, [{ text: "Jane Example", href: "/customers/cus_j", kind: "customer", earlier: true }]);
  assert.equal(linkRecords("Jane Example approved it.", links), "[Jane Example](/customers/cus_j) approved it.");
  assert.equal(linkRecords("jane example and Jane approved it.", links), "jane example and Jane approved it.");
});

test("only the chat's own record links open in place; anything else goes through the link-safety check", () => {
  for (const href of ["/invoices/inv_a", "/customers/cus_r", "/quotes/quo_q", "/threads/job_j", "/work/sj_w", "/schedule?view=day&date=2026-10-19&visit=vis_x"]) {
    assert.equal(isRecordLink(href), true, href);
  }
  for (const href of ["//evil.example/x", "/invoices/../admin", "/\\evil.example", "https://evil.example", "/quotes/quo_1?next=//x", "/admin"]) {
    assert.equal(isRecordLink(href), false, href);
  }
});
