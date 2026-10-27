import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { after } from "node:test";
import { eq } from "drizzle-orm";
import * as upngModule from "@pdf-lib/upng";
import jpeg from "jpeg-js";
import { organization } from "../../schema/schema";
import { getBranding } from "../../core/branding";
import { saveCustomer } from "../../core/customers";
import { db } from "../../core/db";
import { createInvoice, sendInvoice } from "../../core/invoices";
import { LOGO_MAX_BYTES } from "../../core/logo";
import { getProfile, updateProfile } from "../../core/profile";
import { TEST_ORG, withTestDb } from "../../core/test-db";
import { PATCH as brandingRoute } from "../../app/api/branding/route";
import { DELETE as removeLogoRoute, GET as logoRoute, POST as uploadRoute } from "../../app/api/branding/logo/route";
import { POST as previewRoute } from "../../app/api/branding/preview/route";
import { GET as payLogoRoute } from "../../app/pay/[token]/logo/route";
import { BASE, call, installTransport, otherBusiness, person, refused, signIn, superAdminViewing } from "./test-support";

// Logos are written to a folder of this test's own, so they can be read back the way the app serves them.
const blobDir = mkdtempSync(`${tmpdir()}/gw-branding-`);
process.env.BLOB_LOCAL_DIR = blobDir;
after(() => rmSync(blobDir, { recursive: true, force: true }));

const UPNG = ((upngModule as unknown as { default?: { default?: typeof upngModule } }).default?.default ??
  (upngModule as unknown as { default?: typeof upngModule }).default ??
  upngModule) as typeof upngModule;

function png(width = 200, height = 80): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(200);
  return new Uint8Array(UPNG.encode([data.buffer], width, height, 0));
}

function jpg(width = 120, height = 60): Uint8Array {
  return new Uint8Array(jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 0x60) }, 80).data);
}

/** Posts raw image bytes to the upload route, as the Settings page does. */
function upload(headers: Headers, bytes: Uint8Array, type = "image/png", declaredLength?: number) {
  return call(
    async (request: Request) =>
      uploadRoute(
        new Request(`${BASE}/api/branding/logo`, {
          method: "POST",
          headers: {
            cookie: request.headers.get("cookie") ?? "",
            "content-type": type,
            ...(declaredLength === undefined ? {} : { "content-length": String(declaredLength) }),
          },
          body: Buffer.from(bytes),
        }),
      ),
    headers,
  );
}

async function seed() {
  installTransport();
  const owner = await person("Pat Owner", "owner", "+15555550101");
  await person("Sam Crew", "member", "+15555550102");
  await updateProfile(TEST_ORG, { name: "Example Services", phone: "555-0100", licenseNumber: "LIC-0000" }, owner.memberId);
  const other = await otherBusiness();
  const otherOwner = await person("Kim Other", "owner", "+15555550201", other);
  return { owner, other, otherOwner };
}

const storedLogo = async (orgId: string) =>
  (await db().select({ logo: organization.logo }).from(organization).where(eq(organization.id, orgId)))[0]?.logo ?? null;

withTestDb("branding: owners upload, replace, and remove the logo; crew and super admins can't; bad files are refused", async () => {
  await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  refused(await upload(crewHeaders, png()), 403, "NOT_PRIVILEGED");
  refused(await call(removeLogoRoute, crewHeaders, { method: "DELETE" }), 403, "NOT_PRIVILEGED");
  refused(await call(logoRoute, ownerHeaders), 404, "NOT_FOUND");

  // The type comes from the bytes: a WebP or an SVG called image/png is still refused.
  refused(await upload(ownerHeaders, new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 data")), 415, "LOGO_UNSUPPORTED");
  refused(await upload(ownerHeaders, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 415, "LOGO_UNSUPPORTED");
  refused(await upload(ownerHeaders, png().slice(0, 50)), 400, "LOGO_UNREADABLE");
  // Too big, by its declared length, and by what actually arrives.
  refused(await upload(ownerHeaders, png(), "image/png", LOGO_MAX_BYTES + 1), 413, "LOGO_TOO_LARGE");
  const big = new Uint8Array(LOGO_MAX_BYTES + 10);
  big.set(png());
  refused(await upload(ownerHeaders, big), 413, "LOGO_TOO_LARGE");
  assert.equal(await storedLogo(TEST_ORG), null, "nothing refused was stored");

  const first = await upload(ownerHeaders, png());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstUrl = await storedLogo(TEST_ORG);
  assert.match(firstUrl ?? "", /^file:\/\/.*\/logos\/org_test\/[0-9a-f]{8}\.png$/);
  const served = await call(logoRoute, crewHeaders);
  assert.equal(served.status, 200, "crew see their business's logo in the app");
  assert.equal(served.response.headers.get("content-type"), "image/png");
  assert.equal(served.response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await served.response.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const second = await upload(ownerHeaders, jpg(), "image/jpeg");
  assert.equal(second.status, 200);
  const secondUrl = await storedLogo(TEST_ORG);
  assert.notEqual(secondUrl, firstUrl, "a replaced logo gets a new URL");
  assert.equal((await call(logoRoute, ownerHeaders)).response.headers.get("content-type"), "image/jpeg");

  const admin = await superAdminViewing(TEST_ORG);
  refused(await upload(admin, png()), 403, "NOT_A_MEMBER");
  assert.equal((await call(logoRoute, admin)).status, 200, "a super admin looking sees it");

  const removed = await call(removeLogoRoute, ownerHeaders, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(await storedLogo(TEST_ORG), null);
  refused(await call(logoRoute, ownerHeaders), 404);
});

withTestDb("branding: PDF settings save only what changed, without touching the profile's version; the preview renders", async () => {
  await seed();
  const ownerHeaders = await signIn("+15555550101");
  const crewHeaders = await signIn("+15555550102");

  refused(await call(brandingRoute, crewHeaders, { method: "PATCH", body: { accentColor: "#0b5394" } }), 403, "NOT_PRIVILEGED");
  refused(await call(previewRoute, crewHeaders, { body: { kind: "quote" } }), 403, "NOT_PRIVILEGED");
  refused(await call(brandingRoute, ownerHeaders, { method: "PATCH", body: { accentColor: "navy" } }), 400, "INVALID_INPUT");
  refused(await call(brandingRoute, ownerHeaders, { method: "PATCH", body: { quoteFooter: "x".repeat(401) } }), 400, "INVALID_INPUT");
  refused(await call(brandingRoute, ownerHeaders, { method: "PATCH", body: {} }), 400, "INVALID_INPUT");

  const version = (await getProfile(TEST_ORG)).version;
  const saved = await call(brandingRoute, ownerHeaders, {
    method: "PATCH",
    body: { accentColor: "#0B5394", quoteFooter: " Sample terms.\r\nThanks! ", invoiceFooter: null, showOnPdf: { phone: false, email: true } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body?.changed, ["pdfAccentColor", "quoteFooter", "pdfHiddenDetails"]);
  const branding = await getBranding(TEST_ORG);
  assert.equal(branding.accentColor, "#0b5394");
  assert.equal(branding.quoteFooter, "Sample terms.\nThanks!");
  assert.deepEqual(branding.showOnPdf, { address: true, phone: false, email: true, licenseNumber: true });
  assert.equal((await getProfile(TEST_ORG)).version, version, "branding doesn't mark quotes stale");

  const again = await call(brandingRoute, ownerHeaders, { method: "PATCH", body: { accentColor: "#0b5394", showOnPdf: { phone: false } } });
  assert.deepEqual(again.body?.changed, []);
  const cleared = await call(brandingRoute, ownerHeaders, { method: "PATCH", body: { accentColor: null, quoteFooter: "", showOnPdf: { phone: true } } });
  assert.deepEqual(cleared.body?.changed, ["pdfAccentColor", "quoteFooter", "pdfHiddenDetails"]);
  const plain = await getBranding(TEST_ORG);
  assert.equal(plain.accentColor, null);
  assert.equal(plain.quoteFooter, null);

  await upload(ownerHeaders, png());
  for (const kind of ["quote", "invoice"]) {
    const preview = await call(previewRoute, ownerHeaders, { body: { kind, branding: { accentColor: "#c0392b", quoteFooter: "Unsaved note" } } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.response.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await preview.response.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  }
  assert.equal((await getBranding(TEST_ORG)).accentColor, null, "a preview saves nothing");
  refused(await call(previewRoute, ownerHeaders, { body: { kind: "quote", branding: { accentColor: "nope" } } }), 400, "INVALID_INPUT");
  const admin = await superAdminViewing(TEST_ORG);
  assert.equal((await call(previewRoute, admin, { body: {} })).status, 200, "a super admin looking can preview");
  refused(await call(brandingRoute, admin, { method: "PATCH", body: { accentColor: "#000000" } }), 403, "NOT_A_MEMBER");
});

withTestDb("branding: another business can't see or change yours, and a pay link shows only its own business's logo", async () => {
  const { owner, other, otherOwner } = await seed();
  const ownerHeaders = await signIn("+15555550101");
  const otherHeaders = await signIn("+15555550201");
  await upload(ownerHeaders, png());
  await call(brandingRoute, ownerHeaders, { method: "PATCH", body: { accentColor: "#0b5394", invoiceFooter: "Ours" } });

  // The other business's owner works on their own business only: the session picks it, never a parameter.
  refused(await call(logoRoute, otherHeaders), 404);
  const theirs = await call(brandingRoute, otherHeaders, { method: "PATCH", body: { accentColor: "#123456", invoiceFooter: "Theirs" } });
  assert.equal(theirs.status, 200);
  await call(removeLogoRoute, otherHeaders, { method: "DELETE" });
  const ours = await getBranding(TEST_ORG);
  assert.equal(ours.accentColor, "#0b5394");
  assert.equal(ours.invoiceFooter, "Ours");
  assert.ok(ours.logoUrl, "their remove didn't touch our logo");
  assert.equal((await getBranding(other)).invoiceFooter, "Theirs");
  assert.equal((await getBranding(other)).logoUrl, null);

  // Pay links: ours shows our logo; theirs has none; a draft's link shows nothing.
  const send = async (caller: typeof owner) => {
    const customer = await saveCustomer(caller.orgId, { name: "Jane Sample" }, caller.memberId);
    const { invoice } = await createInvoice(caller, { title: "12 Example St", customerId: customer.id, lines: [{ name: "Sample service", quantity: 1, unitCents: 5000 }] });
    return invoice;
  };
  const draft = await send(owner);
  const payLogo = (token: string) => payLogoRoute(new Request(`${BASE}/pay/${token}/logo`), { params: Promise.resolve({ token }) });
  assert.equal((await payLogo(draft.payToken)).status, 404, "a draft isn't the customer's yet");
  await sendInvoice(owner, draft.id, { post: async () => ({ posted: true }) });
  const shown = await payLogo(draft.payToken);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/png");
  const otherInvoice = await send(otherOwner);
  await sendInvoice(otherOwner, otherInvoice.id, { post: async () => ({ posted: true }) });
  assert.equal((await payLogo(otherInvoice.payToken)).status, 404);
  assert.equal((await payLogo("not-a-token")).status, 404);
});
