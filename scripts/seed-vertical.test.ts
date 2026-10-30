import assert from "node:assert/strict";
import { businessNotes } from "../core/notes";
import { createMember } from "../core/members";
import { createOrganization } from "../core/organizations";
import { listItems, listRules, saveItems } from "../core/pricebook";
import { getProfile } from "../core/profile";
import { TEST_ORG, withTestDb } from "../core/test-db";
import { applyVerticalPack } from "../core/vertical-seed";
import { VERTICALS } from "../verticals";

withTestDb("applying the landscaping pack twice adds its items, rules, notes, minimum, and profile settings once, and leaves other businesses alone", async () => {
  const other = await createMember({ orgId: TEST_ORG, name: "Other Owner", role: "owner" });
  const [otherItem] = await saveItems(TEST_ORG, [{ name: "Lawn mowing", unitKind: "visit", unitLabel: "visit", priceCents: 1 }], other.id);

  const org = await createOrganization({ name: "Landscape Test Co" });
  const owner = await createMember({ orgId: org.id, name: "Test Owner", role: "owner" });
  const pack = VERTICALS.landscaping;

  const first = await applyVerticalPack(org.id, owner.id, pack);
  assert.deepEqual(first, { items: 10, rulesAdded: 3, notesAdded: 3 });
  const second = await applyVerticalPack(org.id, owner.id, pack);
  assert.deepEqual(second, { items: 10, rulesAdded: 0, notesAdded: 0 });

  const items = await listItems(org.id);
  assert.equal(items.length, 10);
  assert.ok(items.every((i) => !i.name.toLowerCase().includes("minimum")));
  const rules = await listRules(org.id, { includeRetired: true, includeSuggested: true });
  assert.equal(rules.length, 3);
  assert.equal((await businessNotes(org.id)).length, 3);

  assert.deepEqual(
    items.filter((i) => i.weatherSensitive).map((i) => i.name),
    ["Bed edging", "Cleanup labor", "Lawn mowing", "Mulch installed", "Sod installed"],
    "rain or heat calls off mowing, sod, mulch, edging, and cleanup",
  );
  const haulAway = items.find((i) => i.name === "Haul-away");
  const rush = rules.find((r) => r.text.toLowerCase().includes("rush"));
  assert.ok(haulAway && rush?.effect && Array.isArray(rush.effect.appliesTo));
  assert.equal(rush.effect.appliesTo.length, 9);
  assert.ok(!rush.effect.appliesTo.includes(haulAway.id));
  const ids = new Set(items.map((i) => i.id));
  assert.ok(rush.effect.appliesTo.every((id) => ids.has(id)));

  const profile = await getProfile(org.id);
  assert.equal(profile.minimumChargeCents, 15000);
  assert.equal(profile.quoteValidityDays, 14);
  assert.equal(profile.depositPercent, 30);

  const [stillThere] = await listItems(TEST_ORG);
  assert.equal(stillThere.id, otherItem.id);
  assert.equal(stillThere.priceCents, 1);
  assert.equal((await listRules(TEST_ORG)).length, 0);
});
