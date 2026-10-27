// Paging through invoices and payments (keyset: pages never repeat or skip, and filters hold), and the
// dropped emails Settings → Email lists for owners and admins.
import assert from "node:assert/strict";
import { createInvoice, recordPayment } from "../../core/invoices";
import { recordEvent } from "../../core/events";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { invoicesFor, parseInvoiceCursor, parsePaymentCursor, formatPaymentCursor, paymentsFor } from "./invoices";
import { droppedEmailsFor } from "./settings";
import { appCaller, installTransport, otherBusiness, person, signIn } from "./test-support";

withTestDb("invoices page by number: newest first, older and newer pages never overlap or skip, and the status holds", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const ids: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const { invoice } = await createInvoice(owner, { title: `${i} Example St`, lines: [{ name: "Labor", quantity: 1, unitCents: 1000 * i }] });
    ids.push(invoice.id);
  }
  // Two paid, the rest drafts: the "paid" tab pages on its own.
  await recordPayment(owner, { invoiceId: ids[1], amountCents: 2000, method: "cash" });
  await recordPayment(owner, { invoiceId: ids[3], amountCents: 4000, method: "cash" });
  const app = await appCaller(await signIn(owner.phoneE164!));
  const numbers = (page: { invoices: Array<{ number: number }> }) => page.invoices.map((i) => i.number);

  const first = await invoicesFor(app, {}, 3);
  assert.deepEqual(numbers(first), [7, 6, 5]);
  assert.deepEqual([first.hasNewer, first.hasOlder], [false, true]);
  const second = await invoicesFor(app, { before: 5 }, 3);
  assert.deepEqual(numbers(second), [4, 3, 2]);
  assert.deepEqual([second.hasNewer, second.hasOlder], [true, true]);
  const last = await invoicesFor(app, { before: 2 }, 3);
  assert.deepEqual(numbers(last), [1]);
  assert.deepEqual([last.hasNewer, last.hasOlder], [true, false]);
  // Back up from the last page: the page just newer, still newest first.
  const back = await invoicesFor(app, { after: 1 }, 3);
  assert.deepEqual(numbers(back), [4, 3, 2]);
  assert.deepEqual([back.hasNewer, back.hasOlder], [true, true]);
  const top = await invoicesFor(app, { after: 4 }, 3);
  assert.deepEqual(numbers(top), [7, 6, 5]);
  assert.equal(top.hasNewer, false);

  const paid = await invoicesFor(app, { status: "paid" }, 1);
  assert.deepEqual(numbers(paid), [4]);
  assert.equal(paid.hasOlder, true);
  assert.deepEqual(numbers(await invoicesFor(app, { status: "paid", before: 4 }, 1)), [2]);

  assert.equal(parseInvoiceCursor("12"), 12);
  for (const bad of ["0", "-1", "1e3", "abc", "", undefined]) assert.equal(parseInvoiceCursor(bad), undefined);
});

withTestDb("payments page newest first by day, then when recorded: both ways, nothing repeated or skipped", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const days = ["2026-10-01", "2026-10-03", "2026-10-03", "2026-10-02", "2026-10-05"];
  for (const [i, day] of days.entries()) {
    const { invoice } = await createInvoice(owner, { title: `${i} Example St`, lines: [{ name: "Labor", quantity: 1, unitCents: 1000 }] });
    await recordPayment(owner, { invoiceId: invoice.id, amountCents: 100 * (i + 1), method: "check", receivedDate: day });
  }
  const app = await appCaller(await signIn(owner.phoneE164!));
  const seen: string[] = [];
  let page = await paymentsFor(app, {}, 2);
  assert.equal(page.newer, null);
  assert.equal(page.receivedCents, 1500, "the total is everything received, not just this page");
  seen.push(...page.payments.map((p) => p.receivedDate));
  while (page.older) {
    // Through the URL form, as the page's links carry it.
    page = await paymentsFor(app, { before: parsePaymentCursor(formatPaymentCursor(page.older)) }, 2);
    seen.push(...page.payments.map((p) => p.receivedDate));
  }
  assert.deepEqual(seen, ["2026-10-05", "2026-10-03", "2026-10-03", "2026-10-02", "2026-10-01"]);
  // And back up from the end.
  assert.ok(page.newer);
  const up = await paymentsFor(app, { after: page.newer! }, 2);
  assert.deepEqual(up.payments.map((p) => p.receivedDate), ["2026-10-03", "2026-10-02"]);
  assert.ok(up.newer && up.older);

  for (const bad of ["x", "2026-10-01~nope~pay_1", "2026-10-01~2026-10-01T00:00:00.000Z~bad id", undefined]) assert.equal(parsePaymentCursor(bad), undefined);
});

withTestDb("dropped emails: owners and admins see their own business's, crew and other businesses see none", async () => {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  await recordEvent({ orgId: TEST_ORG, kind: "email.dropped", key: "email.dropped:a", data: { reason: "unknown_sender", from: "stranger@example.com", subject: "Quote please" } });
  await recordEvent({ orgId: TEST_ORG, kind: "email.dropped", key: "email.dropped:b", data: { reason: "spam", from: "spam@example.com", subject: "x".repeat(300), detail: "dkim=fail" } });
  const other = await otherBusiness();
  await recordEvent({ orgId: other, kind: "email.dropped", key: "email.dropped:c", data: { reason: "spam", from: "theirs@example.com", subject: "Theirs" } });

  const dropped = await droppedEmailsFor(await appCaller(await signIn(owner.phoneE164!)));
  assert.deepEqual(dropped.map((d) => [d.reason, d.from]).sort(), [["spam", "spam@example.com"], ["unknown_sender", "stranger@example.com"]]);
  assert.ok(dropped.every((d) => d.subject.length <= 120));
  assert.ok(dropped.every((d) => !("detail" in d)), "only who, what about, and why");
  assert.deepEqual(await droppedEmailsFor(await appCaller(await signIn(crew.phoneE164!))), []);
  const outsider = await person("Lee Outsider", "owner", "+15555550109", other);
  assert.deepEqual((await droppedEmailsFor(await appCaller(await signIn(outsider.phoneE164!)))).map((d) => d.from), ["theirs@example.com"]);
});
