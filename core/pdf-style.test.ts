import assert from "node:assert/strict";
import test from "node:test";
import { FOOTER_MAX_CHARS, INK_RGB, accentColors, brandingPatchSchema, contrastRatio, normalizeFooter, normalizeHex } from "./pdf-style";

test("hex colors are read in their usual spellings and nothing else", () => {
  assert.equal(normalizeHex("#1F6FEB"), "#1f6feb");
  assert.equal(normalizeHex("1f6feb"), "#1f6feb");
  assert.equal(normalizeHex(" #16e "), "#1166ee");
  for (const bad of ["navy", "#12345", "#1234567", "#ggg000", "rgb(0,0,0)", "", "#1f6feb80"]) assert.equal(normalizeHex(bad), null, bad);
});

test("closing notes are tidied, capped, and plain", () => {
  assert.equal(normalizeFooter("  Net 15.\r\n\r\n\r\n\r\nThanks!  "), "Net 15.\n\nThanks!");
  assert.equal(normalizeFooter("   \n  "), null);
  const parse = (quoteFooter: unknown) => brandingPatchSchema.safeParse({ quoteFooter });
  assert.equal(parse("Thanks!").data?.quoteFooter, "Thanks!");
  assert.equal(parse("").data?.quoteFooter, null, "blank goes back to the standard line");
  assert.equal(parse(null).data?.quoteFooter, null);
  assert.equal(parse("x".repeat(FOOTER_MAX_CHARS + 1)).success, false);
  assert.equal(parse("1\n2\n3\n4\n5\n6\n7").success, false);
  assert.equal(parse("hidden\u202ereversed").success, false);
});

test("a patch needs one setting, a valid color, and only the facts a PDF can leave off", () => {
  assert.equal(brandingPatchSchema.safeParse({}).success, false);
  assert.equal(brandingPatchSchema.safeParse({ accentColor: "blue" }).success, false);
  assert.equal(brandingPatchSchema.parse({ accentColor: "#ABC" }).accentColor, "#aabbcc");
  assert.equal(brandingPatchSchema.parse({ accentColor: null }).accentColor, null);
  assert.deepEqual(brandingPatchSchema.parse({ showOnPdf: { phone: false } }).showOnPdf, { phone: false });
  assert.equal(brandingPatchSchema.safeParse({ showOnPdf: { taxRate: false } }).success, false);
});

test("text on the accent and the accent as text stay readable, whatever the color", () => {
  const white = [1, 1, 1] as const;
  for (let r = 0; r <= 255; r += 51) {
    for (let g = 0; g <= 255; g += 51) {
      for (let b = 0; b <= 255; b += 51) {
        const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
        const colors = accentColors(hex);
        assert.ok(contrastRatio(colors.onFill, colors.fill) >= 4, `${hex}: band text`);
        assert.ok(contrastRatio(colors.text, [...white]) >= 4.5, `${hex}: accent text on white`);
        assert.ok(contrastRatio(INK_RGB, colors.tint) >= 4.5, `${hex}: ink on the tint`);
      }
    }
  }
  assert.deepEqual(accentColors("#ffffff").onFill, INK_RGB, "white gets ink");
  assert.deepEqual(accentColors("#000080").onFill, [1, 1, 1], "navy gets white");
});
