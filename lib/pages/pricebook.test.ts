import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { pricebookChanges, pricebookItems, rules } from "../../schema/schema";
import { db } from "../../core/db";
import { saveItems, saveRule, versions } from "../../core/pricebook";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { PATCH as itemRoute } from "../../app/api/price-book/items/[id]/route";
import { PATCH as ruleEditRoute, POST as ruleRoute } from "../../app/api/price-book/rules/[id]/route";
import { pricebookFor } from "./pricebook";
import { appCaller, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  const crew = await person("Sam Crew", "member", "+15555550102");
  const [item] = await saveItems(TEST_ORG, [{ name: "widget service", unitKind: "each", unitLabel: "widget", priceCents: 1200 }], owner.memberId);
  const active = await saveRule(TEST_ORG, { text: "Add $50 for rush jobs", kind: "pricing_modifier", effect: { op: "add_fixed", amount: 5000, appliesTo: "any" } }, owner.memberId);
  const suggested = await saveRule(TEST_ORG, { text: "Bring two ladders for tall jobs", kind: "process", status: "suggested" }, crew.memberId);
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  const [otherItem] = await saveItems(other, [{ name: "gadget fitting", unitKind: "each", unitLabel: "gadget", priceCents: 500 }], otherOwner.memberId);
  const otherRule = await saveRule(other, { text: "Other rule", kind: "other", status: "suggested" }, otherOwner.memberId);
  return { owner, item, active, suggested, otherItem, otherRule };
}

withTestDb("price book: owners reprice, retire, and restore items, logged as the assistant's changes are", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  await assert.rejects(pricebookFor(await appCaller(crewHeaders)), { status: 403 });
  refused(await call(itemRoute, crewHeaders, { method: "PATCH", params: { id: s.item.id }, body: { priceCents: 1 } }), 403, "NOT_PRIVILEGED");
  refused(await call(itemRoute, ownerHeaders, { method: "PATCH", params: { id: s.otherItem.id }, body: { priceCents: 1 } }), 404);
  refused(await call(itemRoute, ownerHeaders, { method: "PATCH", params: { id: s.item.id }, body: { priceCents: -5 } }), 400);

  const before = (await versions(TEST_ORG)).pricebookVersion;
  const repriced = await call(itemRoute, ownerHeaders, { method: "PATCH", params: { id: s.item.id }, body: { priceCents: 1500 } });
  assert.equal(repriced.status, 200, JSON.stringify(repriced.body));
  assert.equal((await versions(TEST_ORG)).pricebookVersion, before + 1);
  const changes = await db().select().from(pricebookChanges).where(eq(pricebookChanges.itemId, s.item.id));
  assert.deepEqual(changes.map((c) => [c.field, c.oldValue, c.newValue, c.memberId]), [["price_cents", "1200", "1500", s.owner.memberId]]);

  await call(itemRoute, ownerHeaders, { method: "PATCH", params: { id: s.item.id }, body: { status: "retired" } });
  const page = await pricebookFor(await appCaller(ownerHeaders));
  assert.equal(page.items[0].status, "retired");
  await call(itemRoute, ownerHeaders, { method: "PATCH", params: { id: s.item.id }, body: { status: "active" } });
  const [row] = await db().select().from(pricebookItems).where(eq(pricebookItems.id, s.item.id));
  assert.equal(row.status, "active");
  assert.equal(row.priceCents, 1500);
  const [otherRow] = await db().select().from(pricebookItems).where(eq(pricebookItems.id, s.otherItem.id));
  assert.equal(otherRow.priceCents, 500);

  // Weather-sensitive: off until the owner ticks it, logged as any change.
  assert.equal(row.weatherSensitive, false);
  await call(itemRoute, ownerHeaders, { method: "PATCH", params: { id: s.item.id }, body: { weatherSensitive: true } });
  const [sensitive] = await db().select().from(pricebookItems).where(eq(pricebookItems.id, s.item.id));
  assert.equal(sensitive.weatherSensitive, true);
  const logged = await db().select().from(pricebookChanges).where(eq(pricebookChanges.itemId, s.item.id));
  assert.ok(logged.some((c) => c.field === "weather_sensitive" && c.oldValue === "false" && c.newValue === "true"));
});

withTestDb("price book: owners accept or turn down crew suggestions and retire rules", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  refused(await call(ruleRoute, crewHeaders, { params: { id: s.suggested.id }, body: { action: "accept" } }), 403, "NOT_PRIVILEGED");
  refused(await call(ruleRoute, ownerHeaders, { params: { id: s.otherRule.id }, body: { action: "accept" } }), 404);
  refused(await call(ruleRoute, ownerHeaders, { params: { id: s.active.id }, body: { action: "accept" } }), 409, "RULE_NOT_SUGGESTED");

  const page = await pricebookFor(await appCaller(ownerHeaders));
  assert.deepEqual(page.rules.map((r) => [r.status, r.by]), [["suggested", "Sam Crew"], ["active", "Pat Owner"]]);

  const before = (await versions(TEST_ORG)).rulesVersion;
  const accepted = await call(ruleRoute, ownerHeaders, { params: { id: s.suggested.id }, body: { action: "accept" } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await versions(TEST_ORG)).rulesVersion, before + 1);
  const [suggestion] = await db().select().from(rules).where(eq(rules.id, s.suggested.id));
  assert.equal(suggestion.status, "retired");
  const [made] = await db().select().from(rules).where(and(eq(rules.orgId, TEST_ORG), eq(rules.text, "Bring two ladders for tall jobs"), eq(rules.status, "active")));
  assert.equal(made.memberId, s.owner.memberId);
  // Already handled: it can't be accepted twice.
  refused(await call(ruleRoute, ownerHeaders, { params: { id: s.suggested.id }, body: { action: "accept" } }), 409);

  const retired = await call(ruleRoute, ownerHeaders, { params: { id: s.active.id }, body: { action: "retire" } });
  assert.equal((retired.body?.rule as { status: string }).status, "retired");
  const [otherRule] = await db().select().from(rules).where(eq(rules.id, s.otherRule.id));
  assert.equal(otherRule.status, "suggested");
});

withTestDb("price book: a super admin looking can read it and change nothing", async () => {
  const s = await seed();
  const headers = await superAdminViewing(TEST_ORG);
  assert.equal((await pricebookFor(await appCaller(headers))).items.length, 1);
  refused(await call(itemRoute, headers, { method: "PATCH", params: { id: s.item.id }, body: { priceCents: 1 } }), 403, "NOT_A_MEMBER");
  refused(await call(ruleRoute, headers, { params: { id: s.suggested.id }, body: { action: "accept" } }), 403, "NOT_A_MEMBER");
});

withTestDb("price book: owners edit a rule's words and kind, crew can't", async () => {
  const s = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");
  const edit = (headers: Headers, id: string, body: unknown) => call(ruleEditRoute, headers, { method: "PATCH", params: { id }, body });

  refused(await edit(crewHeaders, s.active.id, { text: "x", kind: "pricing_modifier", expectedVersion: 1 }), 403, "NOT_PRIVILEGED");
  refused(await edit(ownerHeaders, s.otherRule.id, { text: "x", kind: "other", expectedVersion: 1 }), 404);
  refused(await edit(ownerHeaders, s.active.id, { text: "Add $50 for rush", kind: "scope", expectedVersion: 1 }), 400, "RULE_EFFECT_NEEDS_PRICING");

  const saved = await edit(ownerHeaders, s.active.id, { text: "Add $50 for same-day jobs", kind: "pricing_modifier", expectedVersion: 1 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const [row] = await db().select().from(rules).where(eq(rules.id, s.active.id));
  assert.deepEqual([row.text, row.version, row.effect], ["Add $50 for same-day jobs", 2, s.active.effect]);
  refused(await edit(ownerHeaders, s.active.id, { text: "stale", kind: "pricing_modifier", expectedVersion: 1 }), 409, "REVISION_CHANGED");
});
