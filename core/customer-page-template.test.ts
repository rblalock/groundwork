import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTemplate, renderTemplate, type SlotValues } from "./customer-page-template";
import { applyEdits } from "./customer-pages";

const page = (head: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{{en:Invoice|es:Factura}}</title>${head}</head><body>${body}</body></html>`;
const INVOICE_BODY = `<main><header>{{business.logo}}<h1>{{business.name}}</h1></header><p>{{en:Amount due|es:Monto a pagar}} <strong>{{invoice.balance}}</strong></p>{{invoice.action}}{{invoice.receipt}}</main>`;

const values = (language: "en" | "es", text: Record<string, string> = {}, blocks: Record<string, string> = {}): SlotValues => ({
  language,
  text: { "business.name": "Sample Co", "invoice.balance": "$40.00", ...text },
  blocks: { "business.logo": "", "invoice.action": '<form action="/pay/t/checkout"><button>Pay</button></form>', "invoice.receipt": "", ...blocks },
});

test("a template of HTML and CSS with its slots passes, Google Fonts, inline images, and SVG included", () => {
  const html = page(
    `<link rel="preconnect" href="https://fonts.gstatic.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap"><style>:root{--gw-accent:#0a5}body{font-family:Inter;background:url("data:image/png;base64,AAAA")}</style>`,
    `${INVOICE_BODY}<a href="mailto:{{business.email}}" target="_blank">{{business.email}}</a><a href="tel:{{business.phone}}">call</a><svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><use href="#g"/><path d="M0 0" fill="url(#g)"/></svg><img alt="" src="data:image/png;base64,AAAA">`,
  );
  const check = checkTemplate(html, "invoice");
  assert.equal(check.ok, true, check.ok ? "" : check.errors.join("\n"));
});

test("scripts, handlers, forms, frames, outside resources, and misplaced slots are refused, each in words the designer can act on", () => {
  const html = page(
    `<script>alert(1)</script><link rel="stylesheet" href="https://example.com/x.css"><style>@import url(https://example.com/x.css); body{background:url(https://example.com/t.gif)}</style><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com/">`,
    `<div onclick="x()">{{invoice.action}}</div><form></form><input name="card"><button>Pay</button><iframe src="https://example.com"></iframe><img src="https://example.com/t.gif"><a href="javascript:alert(1)">x</a><a href="//example.com">x</a><p title="{{invoice.receipt}}">{{invoice.secret}}</p><div style="background:url(https://example.com/t.gif)"></div><svg><a href="https://example.com"><text>x</text></a><foreignObject></foreignObject><script>1</script></svg><span>{{en:Pay}}</span><style>.x{color:{{business.name}}}</style>`,
  );
  const check = checkTemplate(html, "invoice");
  assert.equal(check.ok, false);
  const errors = check.ok ? "" : check.errors.join("\n");
  for (const expected of [
    /Scripts don't run/,
    /<link> is only for Google Fonts/,
    /@import isn't allowed/,
    /url\(https:\/\/example\.com\/t\.gif\) isn't allowed/,
    /Only <meta charset>/,
    /<base> isn't allowed/,
    /Event handlers/,
    /Forms aren't allowed/,
    /Inputs aren't allowed/,
    /Buttons aren't allowed/,
    /Frames aren't allowed/,
    /Images must be inline/,
    /javascript: and similar/,
    /Links must be https:/,
    /\{\{invoice\.receipt\}\} fills with HTML/,
    /\{\{invoice\.secret\}\} isn't a slot of the invoice page/,
    /<a> isn't allowed/,
    /<foreignObject> isn't allowed/,
    /isn't a language pair/,
    /can't go in CSS/,
  ])
    assert.match(errors, expected);
});

test("a page must have its required slots, a body, and stay under the size limit", () => {
  const missing = checkTemplate(page("", "<p>{{invoice.balance}}</p>"), "invoice");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.errors.join(" "), /needs \{\{invoice\.action\}\}/);
  const quote = checkTemplate(page("", "<p>{{quote.total}}</p>"), "quote");
  assert.match(quote.ok ? "" : quote.errors.join(" "), /needs \{\{quote\.items\}\}.*needs \{\{quote\.action\}\}/);
  assert.equal(checkTemplate(page("", INVOICE_BODY), "quote").ok, false, "an invoice's slots aren't a quote's");
  assert.match((checkTemplate("<p>hi</p>", "invoice") as { errors: string[] }).errors[0], /whole HTML document/);
  assert.match((checkTemplate(page(`<style>${"a{}".repeat(60_000)}</style>`, INVOICE_BODY), "invoice") as { errors: string[] }).errors[0], /over 150 KB/);
});

test("serving cleans a stored template again: what isn't allowed comes out, and misplaced slots fill with nothing", () => {
  const stored = page(`<script>alert(1)</script><style>@import url(https://example.com/x.css)</style><style>p{color:red}</style>`, `<p onclick="x()" title="{{invoice.action}}">{{invoice.nope}}</p><iframe></iframe><img src="https://example.com/t.gif">${INVOICE_BODY}`);
  const filled = renderTemplate(stored, "invoice", values("en"), "<meta charset=utf-8>");
  assert.doesNotMatch(filled, /<script|onclick|@import|<iframe|example\.com/);
  assert.match(filled, /<style>p\{color:red\}<\/style>/, "allowed CSS stays");
  assert.match(filled, /<p title="">/, "an HTML slot in an attribute fills with nothing");
  assert.equal((filled.match(/<form/g) ?? []).length, 1, "the action block fills once, where it belongs");
});

test("filling escapes text, keeps the page's language, sets <html lang>, and never reads what it fills in as a slot", () => {
  const template = page("", `${INVOICE_BODY}<p class="note">{{en:Questions? Call us & ask|es:¿Preguntas? Llámanos}}</p>`);
  const en = renderTemplate(template, "invoice", values("en", { "business.name": `<b>A & B</b> {{invoice.action}}` }), "<meta charset=utf-8>");
  assert.match(en, /^<!doctype html><html lang="en"><head><meta charset=utf-8>/);
  assert.match(en, /<h1>&lt;b&gt;A &amp; B&lt;\/b&gt; \{\{invoice\.action\}\}<\/h1>/, "escaped, and a slot in the name stays words");
  assert.match(en, /<p class="note">Questions\? Call us &amp; ask<\/p>/);
  assert.match(en, /<title>Invoice<\/title>/);
  const es = renderTemplate(template, "invoice", values("es"), "");
  assert.match(es, /<html lang="es">/);
  assert.match(es, /Monto a pagar/);
  assert.match(es, /¿Preguntas\? Llámanos/);
});

test("a link that opens a new tab doesn't hand the page to it", () => {
  const filled = renderTemplate(page("", `${INVOICE_BODY}<a href="https://example.com" target="_blank" rel="opener">site</a>`), "invoice", values("en"), "");
  assert.match(filled, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">/);
});

test("edits apply in order, each matching exactly once", () => {
  assert.deepEqual(applyEdits("a b c", [{ old_string: "b", new_string: "B" }, { old_string: "B c", new_string: "x" }]), { ok: true, html: "a x" });
  assert.match((applyEdits("a b", [{ old_string: "z", new_string: "y" }]) as { error: string }).error, /isn't in the page/);
  assert.match((applyEdits("a a", [{ old_string: "a", new_string: "b" }]) as { error: string }).error, /more than once/);
});

test("a slot can't be made of pieces from two places: an attribute and a style's text don't join into a language pair", () => {
  // The check sees `{{en:x` in an attribute and `|es:…}}` in CSS, neither one a slot. Filling the page as a
  // string would read them as one pair, and the Spanish side would break out of the attribute.
  const stored = page(
    `<style>.a{} /* |es:x"><meta http-equiv="refresh" content="0;url=https://example.com"><p title="}} */</style>`,
    `<p title="{{en:x">${INVOICE_BODY}</p>`,
  );
  assert.match((checkTemplate(stored, "invoice") as { errors: string[] }).errors.join(" "), /CSS can't contain "<"/);
  for (const language of ["en", "es"] as const) {
    const filled = renderTemplate(stored, "invoice", values(language), "");
    assert.doesNotMatch(filled, /<meta http-equiv|<style>\.a/i, language);
    assert.match(filled, /<p title="\{\{en:x">/, "the stray half stays words in its attribute");
  }
  // And with the CSS left out of it, the two halves still never join.
  const split = page("", `<p title="{{en:x"></p>${INVOICE_BODY}<p>|es:y"><b>bold</b>}}</p>`);
  const es = renderTemplate(split, "invoice", values("es"), "");
  assert.match(es, /<p title="\{\{en:x"><\/p>/);
  assert.match(es, /<p>\|es:y"&gt;<b>bold<\/b>\}\}<\/p>|<p>\|es:y"><b>bold<\/b>\}\}<\/p>/);
});

test("our blocks go in only at this view's own markers; a template's look-alike stays words", () => {
  const stored = page("", `${INVOICE_BODY}<p title="<!--gw:0000:0-->">&lt;!--gw:0000:0--&gt;</p>`);
  const filled = renderTemplate(stored, "invoice", values("en"), "<meta charset=utf-8>");
  assert.equal((filled.match(/<form/g) ?? []).length, 1);
  assert.match(filled, /<p title="<!--gw:0000:0-->">&lt;!--gw:0000:0--&gt;<\/p>/);
  assert.match(filled, /^<!doctype html><html lang="en"><head><meta charset=utf-8>/);
});

test("a language pair keeps its words as written, so a space before the next slot stays", () => {
  const filled = renderTemplate(page("", `${INVOICE_BODY}<p>{{en:Invoice |es:Factura }}{{invoice.balance}}</p><p>{{ en:Due|es:Vence }}</p>`), "invoice", values("es"), "");
  assert.match(filled, /<p>Factura \$40\.00<\/p>/);
  assert.match(filled, /<p>Vence <\/p>/);
  assert.match(renderTemplate(page("", `${INVOICE_BODY}<p>{{en:Invoice |es:Factura }}{{invoice.balance}}</p>`), "invoice", values("en"), ""), /<p>Invoice \$40\.00<\/p>/);
});
