process.env.BLOB_FAKE = "1";

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as upngModule from "@pdf-lib/upng";
import { messages } from "../schema/schema";
import type { InboundAttachment } from "../schema/types";
import { getBranding, loadLogo, pageBusiness, removeLogo, setLogoFromText, updateBranding } from "./branding";
import { db, newId } from "./db";
import { createMember, type Caller } from "./members";
import type { Profile } from "./profile";
import { TEST_ORG, withTestDb } from "./test-db";

const UPNG = ((upngModule as unknown as { default?: { default?: typeof upngModule } }).default?.default ??
  (upngModule as unknown as { default?: typeof upngModule }).default ??
  upngModule) as typeof upngModule;

async function caller(name: string, role: Caller["role"]): Promise<Caller> {
  const member = await createMember({ orgId: TEST_ORG, name, role });
  return { orgId: TEST_ORG, memberId: member.id, name, role, language: "en", phoneE164: null };
}

async function texted(member: Caller, attachments: InboundAttachment[], minutesAgo = 1): Promise<void> {
  await db().insert(messages).values({
    id: newId("msg"),
    orgId: TEST_ORG,
    memberId: member.memberId,
    phoneE164: "+15555550100",
    direction: "inbound",
    kind: "user",
    body: "use this as our logo",
    attachments,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });
}

withTestDb("a logo by text: only owners and admins, only a recent image, only PNG or JPEG", async () => {
  const dir = await mkdtemp(`${tmpdir()}/gw-logo-`);
  try {
    const owner = await caller("Pat Owner", "owner");
    const admin = await caller("Ana Admin", "admin");
    const crew = await caller("Sam Crew", "member");
    const pngFile = `${dir}/logo.png`;
    await writeFile(pngFile, new Uint8Array(UPNG.encode([new Uint8Array(64 * 32 * 4).fill(90).buffer], 64, 32, 0)));
    const webpFile = `${dir}/logo.webp`;
    await writeFile(webpFile, new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 data"));

    await assert.rejects(setLogoFromText(owner), /NO_TEXTED_IMAGE/);
    // An hour-old photo isn't what "use this" points at.
    await texted(owner, [{ type: "image", url: pathToFileURL(pngFile).href, mimeType: "image/png" }], 60);
    await assert.rejects(setLogoFromText(owner), /NO_TEXTED_IMAGE/);
    // A text with only a PDF has no image.
    await texted(owner, [{ type: "file", url: "fake://price-list.pdf", name: "price-list.pdf", mimeType: "application/pdf" }]);
    await assert.rejects(setLogoFromText(owner), /NO_TEXTED_IMAGE/);

    await texted(crew, [{ type: "image", url: pathToFileURL(pngFile).href, mimeType: "image/png" }]);
    await assert.rejects(setLogoFromText(crew), /NOT_PRIVILEGED/);
    await assert.rejects(updateBranding(crew, { quoteFooter: "Crew note" }), /NOT_PRIVILEGED/);
    await assert.rejects(removeLogo(crew), /NOT_PRIVILEGED/);

    await texted(admin, [{ type: "file", url: pathToFileURL(webpFile).href, name: "logo.webp", mimeType: "image/webp" }]);
    await assert.rejects(setLogoFromText(admin), /LOGO_UNSUPPORTED/);
    // A PNG sent as a file works as well as a photo.
    await texted(admin, [{ type: "file", url: pathToFileURL(pngFile).href, name: "logo.png", mimeType: "image/png" }]);
    assert.deepEqual(await setLogoFromText(admin), { logoUrl: (await getBranding(TEST_ORG)).logoUrl, width: 64, height: 32 });
    assert.match((await getBranding(TEST_ORG)).logoUrl ?? "", /^fake:\/\/logos\/org_test\//);
    // A fake store keeps no bytes, so PDFs print without it rather than fail.
    assert.equal(await loadLogo(TEST_ORG), null);
    assert.deepEqual(await removeLogo(owner), { removed: true });
    assert.deepEqual(await removeLogo(owner), { removed: false });
    assert.equal((await getBranding(TEST_ORG)).logoUrl, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a customer page shows the address and license number only when the PDFs print them", () => {
  const profile = { name: "Example Co", phone: "555-0100", email: null, address: "1 Example St\nSpringfield", licenseNumber: "LIC-0000", pdfHiddenDetails: [] } as unknown as Profile;
  assert.deepEqual(pageBusiness(profile, "v1"), { name: "Example Co", phone: "555-0100", email: null, address: "1 Example St\nSpringfield", licenseNumber: "LIC-0000", logoVersion: "v1" });
  const hidden = pageBusiness({ ...profile, pdfHiddenDetails: ["address", "licenseNumber"] } as Profile, null);
  assert.equal(hidden.address, null);
  assert.equal(hidden.licenseNumber, null);
});
