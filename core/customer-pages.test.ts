import assert from "node:assert/strict";
import { customerPageState, editVersion, latestVersion, listVersions, pageForDesign, publishedTemplate, publishVersion, restoreVersion, saveVersion, useStandardPage, VERSIONS_KEPT } from "./customer-pages";
import { createMember, type Caller } from "./members";
import { invoicePage, quotePage } from "./customer-page-test-support";
import { TEST_ORG, withTestDb } from "./test-db";

async function people(): Promise<{ owner: Caller; crew: Caller }> {
  const owner = await createMember({ orgId: TEST_ORG, name: "Pat Owner", role: "owner" });
  const crew = await createMember({ orgId: TEST_ORG, name: "Sam Crew", role: "member" });
  const as = (m: typeof owner): Caller => ({ orgId: TEST_ORG, memberId: m.id, name: m.name, role: m.role, language: "en", phoneE164: null });
  return { owner: as(owner), crew: as(crew) };
}

withTestDb("a page's designs are versions; customers see one only once it's published, and the standard page again on request", async () => {
  const { owner, crew } = await people();
  assert.equal(await publishedTemplate(TEST_ORG, "invoice"), null, "the standard page to start");

  await assert.rejects(saveVersion(crew, "invoice", invoicePage("red"), "red"), /NOT_PRIVILEGED/);
  await assert.rejects(saveVersion(owner, "invoice", "<p>hi</p>", "bad"), /TEMPLATE_INVALID/);
  const v1 = await saveVersion(owner, "invoice", invoicePage("red"), "make it red");
  const v2 = await saveVersion(owner, "invoice", invoicePage("blue"), "now blue");
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.equal(await publishedTemplate(TEST_ORG, "invoice"), null, "a saved version is a draft");

  await assert.rejects(publishVersion(crew, "invoice"), /NOT_PRIVILEGED/);
  await assert.rejects(publishVersion(owner, "invoice", 9), /PAGE_VERSION_NOT_FOUND/);
  const live = await publishVersion(owner, "invoice", 1);
  assert.equal(live.published?.version, 1);
  assert.match((await publishedTemplate(TEST_ORG, "invoice")) ?? "", /color:red/);
  assert.equal(await publishedTemplate(TEST_ORG, "quote"), null, "each page on its own");

  const restored = await restoreVersion(owner, "invoice", 1);
  assert.equal(restored.version, 3);
  assert.equal(restored.request, "Restored version 1");
  assert.equal((await publishVersion(owner, "invoice")).published?.version, 3, "the newest, when none is named");

  const standard = await useStandardPage(owner, "invoice");
  assert.equal(standard.published, null);
  assert.equal(standard.latest?.version, 3, "the designs stay");
  assert.equal(await publishedTemplate(TEST_ORG, "invoice"), null);
});

withTestDb("old versions go as new ones come, but never the live one", async () => {
  const { owner } = await people();
  await saveVersion(owner, "invoice", invoicePage("c0"), null);
  await publishVersion(owner, "invoice", 1);
  for (let i = 1; i <= VERSIONS_KEPT + 2; i++) await saveVersion(owner, "invoice", invoicePage(`c${i}`), null);
  const kept = (await listVersions(TEST_ORG, "invoice")).map((v) => v.version);
  assert.equal(kept.length, VERSIONS_KEPT);
  assert.equal(kept[0], VERSIONS_KEPT + 3);
  assert.match((await publishedTemplate(TEST_ORG, "invoice")) ?? "", /color:c0/, "the live version stays");
  assert.equal((await customerPageState(TEST_ORG, "invoice")).published?.version, 1);
});

withTestDb("the assistant reads a page to design it, and edits its newest version into a new draft", async () => {
  const { owner, crew } = await people();
  const blank = await pageForDesign(TEST_ORG, "invoice");
  assert.equal(blank.template, null);
  assert.equal(blank.otherPage, null);
  assert.match(blank.slots, /\{\{invoice\.action\}\} \(required\) \[block\]/);
  assert.match(blank.blocks, /--gw-accent/);
  await assert.rejects(editVersion(owner, "invoice", [{ old_string: "a", new_string: "b" }], "x"), /PAGE_NOT_DESIGNED/);

  await saveVersion(owner, "quote", quotePage("teal"), "teal");
  await saveVersion(owner, "invoice", invoicePage("green"), "green");
  const read = await pageForDesign(TEST_ORG, "invoice");
  assert.equal(read.version, 1);
  assert.equal(read.liveVersion, null);
  assert.match(read.template ?? "", /color:green/);
  assert.match(read.otherPage?.template ?? "", /color:teal/, "the other page, to match");

  const navy = await editVersion(owner, "invoice", [{ old_string: "color:green", new_string: "color:navy" }], "navy");
  assert.equal(navy.version, 2);
  assert.match(navy.html, /color:navy/);
  await assert.rejects(editVersion(owner, "invoice", [{ old_string: "color:green", new_string: "x" }], "again"), /PAGE_EDIT_FAILED/);
  await assert.rejects(editVersion(owner, "invoice", [{ old_string: "{{invoice.action}}", new_string: "" }], "drop it"), /TEMPLATE_INVALID.*needs \{\{invoice\.action\}\}/);
  await assert.rejects(editVersion(crew, "invoice", [{ old_string: "navy", new_string: "red" }], "red"), /NOT_PRIVILEGED/);
  assert.equal((await latestVersion(TEST_ORG, "invoice"))?.version, 2, "nothing refused was saved");
});
