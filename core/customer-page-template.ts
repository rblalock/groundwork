// A business's own design for the pages its customers open: a quote's link (`/q/<token>`) and an
// invoice's pay link (`/pay/<token>`). The design is a template, one HTML document with CSS and no
// scripts, that the page designer writes (core/customer-page-designer.ts). It never holds the
// quote's or invoice's facts: those are slots, `{{invoice.balance}}`, that the page fills on every
// view (lib/customer-pages.ts), so the page is never out of date. The slots that act, Approve and
// Pay, are ours: the template only places them.
//
// A template is checked before it's saved (`checkTemplate`) and cleaned again when it's served
// (`cleanTemplate`): only an allowlist of elements, attributes, and CSS gets through. No scripts, forms,
// frames, or outside resources except Google Fonts; the page is also served with a Content Security
// Policy that runs no script at all (`CUSTOMER_PAGE_CSP`), so a template that slipped past the check
// still couldn't do anything.
import { randomBytes } from "node:crypto";
import { parse, serialize } from "parse5";

export const CUSTOMER_PAGE_KINDS = ["quote", "invoice"] as const;
export type CustomerPageKind = (typeof CUSTOMER_PAGE_KINDS)[number];

/** A template's size limit. A design is usually 8–16 KB; inline SVG and data: images add up fast. */
export const TEMPLATE_MAX_BYTES = 150 * 1024;

/**
 * A slot: `text` fills with plain text (escaped), usable in text and attributes; `block` fills with
 * our HTML (classed `gw-…`), usable only as an element's content in the body. Required slots must
 * appear once at least.
 */
export type SlotDef = { name: string; kind: "text" | "block"; required?: boolean; about: string };

const BUSINESS_SLOTS: SlotDef[] = [
  { name: "business.name", kind: "text", about: "The business's name." },
  { name: "business.phone", kind: "text", about: "Its phone number, or empty when it has none." },
  { name: "business.email", kind: "text", about: "Its email address, or empty when it has none." },
  { name: "business.address", kind: "text", about: "Its address on one line, or empty when it has none or keeps it off its PDFs." },
  { name: "business.license", kind: "text", about: "Its license number, or empty when it has none or keeps it off its PDFs." },
  { name: "business.logo", kind: "block", about: 'Its logo, an <img class="gw-logo">, or nothing when it has none.' },
  { name: "business.contact", kind: "block", about: 'A line with its phone and email (<p class="gw-contact">), or nothing when it has neither.' },
];

export const PAGE_SLOTS: Record<CustomerPageKind, SlotDef[]> = {
  quote: [
    ...BUSINESS_SLOTS,
    { name: "quote.title", kind: "text", about: "What the quote is for, the business's own words (e.g. the job's name)." },
    { name: "quote.total", kind: "text", about: 'The quote\'s total, formatted ("$1,240.00").' },
    { name: "quote.valid_until", kind: "text", about: 'How long it\'s good for ("Good through Nov 3"), or empty once approved.' },
    { name: "quote.customer", kind: "block", about: "Who it's prepared for: the customer's name and the job's address (.gw-customer), or nothing." },
    {
      name: "quote.items",
      kind: "block",
      required: true,
      about: "The priced lines (table.gw-lines) and the totals (dl.gw-totals: subtotal, adjustments, tax, and .gw-total).",
    },
    { name: "quote.notes", kind: "block", about: "The quote's notes to the customer (.gw-notes), or nothing." },
    { name: "quote.pdf", kind: "block", about: "A link to download the quote's PDF (a.gw-button.gw-secondary), or nothing." },
    {
      name: "quote.action",
      kind: "block",
      required: true,
      about:
        "Where the quote stands and what the customer can do: the Approve form with their name (open), the deposit to pay by card (approved), or a notice (approved, expired). Make it prominent.",
    },
    { name: "quote.receipt", kind: "block", about: "The deposit's receipt once one's been paid (.gw-receipt), or nothing." },
  ],
  invoice: [
    ...BUSINESS_SLOTS,
    { name: "invoice.number", kind: "text", about: 'The invoice\'s number ("INV-0042").' },
    { name: "invoice.title", kind: "text", about: "What the invoice is for, the business's own words." },
    { name: "invoice.balance", kind: "text", about: 'What\'s left to pay, formatted ("$1,240.00"); "$0.00" once paid.' },
    { name: "invoice.total", kind: "text", about: "The invoice's total, formatted." },
    { name: "invoice.paid", kind: "text", about: "What's been paid so far, formatted." },
    { name: "invoice.due", kind: "text", about: 'When it\'s due ("Due Nov 3" or "Due on receipt"), or empty once paid or void.' },
    {
      name: "invoice.action",
      kind: "block",
      required: true,
      about: "The Pay by card button (payable), or a notice when it's paid, void, or can't be paid online. Make it prominent.",
    },
    { name: "invoice.receipt", kind: "block", about: "The payments so far, the totals, and a receipt download (.gw-receipt), or nothing before any payment." },
  ],
};

/** The page's language, set on `<html lang>`. Not for templates to use. */
const LANG_SLOT = "lang";
// A pair's words are kept as written, spaces included: `{{en:Invoice |es:Factura }}{{invoice.number}}`
// reads "Invoice INV-0042". A slot's name is read without the spaces around it.
const LANGUAGE_PAIR = /^\s*en:([^{}|]*)\|\s*es:([^{}|]*)$/;
const TOKEN = /\{\{([^{}]*)\}\}/g;

type Context = "text" | "attribute" | "style" | "title";

// --- What's allowed -------------------------------------------------------------------------------

const HTML_ELEMENTS = new Set([
  "html", "head", "body", "title", "meta", "link", "style",
  "main", "header", "footer", "section", "article", "aside", "nav", "div", "span", "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "strong", "em", "b", "i", "u", "s", "small", "mark", "sub", "sup",
  "abbr", "time", "address", "blockquote", "q", "cite", "code", "pre", "figure", "figcaption", "img", "picture",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
  "details", "summary", "svg",
]);

const SVG_ELEMENTS = new Set([
  "svg", "g", "defs", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "title", "desc",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "use", "symbol",
]);

/** Elements refused with a reason the designer can act on. */
const REFUSED: Record<string, string> = {
  script: "Scripts don't run on customer pages. Use CSS only (transitions and animations are fine).",
  noscript: "Scripts don't run on customer pages, so <noscript> isn't needed.",
  form: "Forms aren't allowed: the {{quote.action}} and {{invoice.action}} slots put the real Approve and Pay forms on the page.",
  input: "Inputs aren't allowed: the action slot has the real form.",
  button: "Buttons aren't allowed: the action slot has the real buttons. Style .gw-button instead.",
  select: "Form controls aren't allowed: the action slot has the real form.",
  textarea: "Form controls aren't allowed: the action slot has the real form.",
  iframe: "Frames aren't allowed.",
  frame: "Frames aren't allowed.",
  object: "Embedded objects aren't allowed.",
  embed: "Embedded objects aren't allowed.",
  base: "<base> isn't allowed.",
  video: "Video isn't allowed.",
  audio: "Audio isn't allowed.",
  canvas: "Canvas needs a script, and scripts don't run on customer pages.",
  template: "<template> isn't allowed.",
  foreignobject: "<foreignObject> isn't allowed in SVG.",
};

const GLOBAL_ATTRIBUTES = new Set(["class", "id", "style", "title", "lang", "dir", "role", "hidden", "tabindex"]);
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  time: new Set(["datetime"]),
  details: new Set(["open"]),
  meta: new Set(["charset", "name", "content"]),
  link: new Set(["rel", "href", "crossorigin"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
};

const META_NAMES = new Set(["viewport", "color-scheme", "theme-color", "description"]);
const FONT_CSS = "https://fonts.googleapis.com/";
const FONT_FILES = "https://fonts.gstatic.com/";
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)(?:;[a-z0-9=.+-]+)*,/i;

/** CSS a template may not have: anything that loads from elsewhere or runs. `url()` is checked on its own. */
function cssProblems(css: string): string[] {
  const problems: string[] = [];
  const flat = css.replace(/\\/g, "");
  if (/@import/i.test(flat)) problems.push(`@import isn't allowed. Load Google Fonts with <link rel="stylesheet" href="${FONT_CSS}css2?…"> in the head.`);
  if (/expression\s*\(|javascript:|-moz-binding|behavior\s*:/i.test(flat)) problems.push("That CSS isn't allowed (expression, javascript:, binding, or behavior).");
  if (css.includes("<")) problems.push('CSS can\'t contain "<". Remove it (and any HTML) from the styles.');
  for (const match of flat.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
    const target = match[2].trim();
    if (!(target.startsWith("#") || DATA_IMAGE.test(target) || /^data:font\//i.test(target) || target.startsWith(FONT_FILES))) {
      problems.push(`url(${target.slice(0, 60)}) isn't allowed: images must be inline data: URLs (or inline SVG), and fonts come from Google Fonts.`);
    }
  }
  return problems;
}

function hrefProblem(href: string): string | null {
  const value = href.trim();
  if (value === "" || value.startsWith("#")) return null;
  if (/^(?:https?:|mailto:|tel:)/i.test(value)) return /^https?:\/\/[^/]*@/i.test(value) ? "A link can't carry a username or password." : null;
  if (/^\{\{\s*business\.(?:email|phone)\s*\}\}$/.test(value)) return "Put mailto: or tel: before {{business.email}} or {{business.phone}} in a link.";
  return `Links must be https://, mailto:, tel:, or #section (not ${value.slice(0, 40)}).`;
}

// --- The check ------------------------------------------------------------------------------------

type Node = {
  nodeName: string;
  tagName?: string;
  namespaceURI?: string;
  attrs?: Array<{ name: string; value: string; prefix?: string }>;
  childNodes?: Node[];
  content?: { childNodes: Node[] };
  value?: string;
  data?: string;
  parentNode?: Node | null;
};

export type TemplateCheck = { ok: true; html: string } | { ok: false; errors: string[] };

const SVG_NS = "http://www.w3.org/2000/svg";

class Checker {
  readonly errors = new Set<string>();
  readonly used = new Map<string, number>();
  constructor(
    private readonly kind: CustomerPageKind,
    private readonly strip: boolean,
  ) {}

  private slot(name: string) {
    return PAGE_SLOTS[this.kind].find((s) => s.name === name);
  }

  /** The slots in a piece of text, checked against where they sit: the text with only the allowed ones left. */
  tokens(text: string, context: Context): string {
    return text.replace(TOKEN, (whole, raw: string) => {
      if (LANGUAGE_PAIR.test(raw)) {
        if (context !== "style") return whole;
        this.errors.add("Slots and language pairs can't go in CSS.");
        return "";
      }
      const inner = raw.trim();
      const slot = this.slot(inner);
      if (!slot) {
        this.errors.add(
          /^en:|^es:/.test(inner)
            ? `{{${inner.slice(0, 50)}}} isn't a language pair. Write {{en:English text|es:Spanish text}}, without braces or "|" inside.`
            : `{{${inner.slice(0, 40)}}} isn't a slot of the ${this.kind} page.`,
        );
        return "";
      }
      if (context === "style") {
        this.errors.add(`{{${inner}}} can't go in CSS.`);
        return "";
      }
      if (slot.kind === "block" && context !== "text") {
        this.errors.add(`{{${inner}}} fills with HTML, so it goes only as an element's content in the body, not in an attribute or the title.`);
        return "";
      }
      this.used.set(inner, (this.used.get(inner) ?? 0) + 1);
      return whole;
    });
  }

  /** Checks an element and what's in it; when stripping, takes out what isn't allowed instead. */
  element(node: Node, inBody: boolean, inSvg: boolean): boolean {
    const name = (node.tagName ?? node.nodeName).toLowerCase();
    const svg = node.namespaceURI === SVG_NS;
    if (REFUSED[name]) {
      this.errors.add(REFUSED[name]);
      return false;
    }
    if (svg ? !SVG_ELEMENTS.has(name) : !HTML_ELEMENTS.has(name)) {
      this.errors.add(`<${name}> isn't allowed on customer pages.`);
      return false;
    }
    if (name === "meta") {
      const metaName = node.attrs?.find((a) => a.name === "name")?.value.toLowerCase();
      const charset = node.attrs?.some((a) => a.name === "charset");
      if (!charset && !(metaName && META_NAMES.has(metaName))) {
        this.errors.add('Only <meta charset>, and <meta name> for viewport, color-scheme, theme-color, or description, are allowed.');
        return false;
      }
    }
    if (name === "link") {
      const rel = node.attrs?.find((a) => a.name === "rel")?.value.toLowerCase() ?? "";
      const href = node.attrs?.find((a) => a.name === "href")?.value ?? "";
      const origin = (() => {
        try {
          return new URL(href).origin + "/";
        } catch {
          return "";
        }
      })();
      const ok = (rel === "stylesheet" && href.startsWith(FONT_CSS)) || (rel === "preconnect" && (origin === FONT_CSS || origin === FONT_FILES));
      if (!ok) {
        this.errors.add(`<link> is only for Google Fonts: rel="stylesheet" href="${FONT_CSS}css2?…" (and preconnect to it).`);
        return false;
      }
    }
    const attrs: NonNullable<Node["attrs"]> = [];
    for (const attr of node.attrs ?? []) {
      const attrName = (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
      const problem = this.attribute(name, attrName, attr.value, svg || inSvg);
      if (problem) {
        this.errors.add(problem);
        continue;
      }
      attrs.push({ ...attr, value: this.tokens(attr.value, "attribute") });
    }
    if (name === "a" && attrs.some((a) => a.name === "target")) {
      const rel = attrs.find((a) => a.name === "rel");
      if (rel) rel.value = "noopener noreferrer";
      else attrs.push({ name: "rel", value: "noopener noreferrer" });
    }
    node.attrs = attrs;
    if (name === "style") {
      const css = (node.childNodes ?? []).map((c) => c.value ?? "").join("");
      const problems = cssProblems(css);
      for (const problem of problems) this.errors.add(problem);
      return this.tokens(css, "style") === css && problems.length === 0;
    }
    this.children(node, inBody || name === "body", inSvg || svg, name === "title" ? "title" : "text");
    return true;
  }

  private attribute(element: string, name: string, value: string, svg: boolean): string | null {
    if (name.startsWith("on")) return "Event handlers (on…) aren't allowed: scripts don't run on customer pages.";
    if (/javascript:|vbscript:|data:text\/html/i.test(value.replace(/[\s\u0000-\u001f]/g, ""))) return "javascript: and similar URLs aren't allowed.";
    if (name === "style") {
      const problems = cssProblems(value);
      if (problems.length) return problems[0];
      return /\{\{/.test(value) ? "Slots can't go in a style attribute." : null;
    }
    if (name === "srcset" || name === "srcdoc" || name === "formaction" || name === "ping") return `${name} isn't allowed.`;
    if (svg) {
      if (name === "href" || name === "xlink:href") return value.trim().startsWith("#") ? null : "In SVG, href may only point within the page (#id).";
      return /^[a-z][a-z0-9:_.-]*$/.test(name) ? null : `${name} isn't allowed.`;
    }
    if (GLOBAL_ATTRIBUTES.has(name) || name.startsWith("aria-") || name.startsWith("data-")) return null;
    if (!ELEMENT_ATTRIBUTES[element]?.has(name)) return `${name} isn't allowed on <${element}>.`;
    if (element === "a" && name === "href") return hrefProblem(value);
    if (element === "a" && name === "target") return value === "_blank" ? null : 'A link\'s target can only be "_blank".';
    if (element === "img" && name === "src") {
      const v = value.trim();
      return DATA_IMAGE.test(v) ? null : "Images must be inline data: URLs or inline SVG. The logo is {{business.logo}}.";
    }
    return null;
  }

  children(node: Node, inBody: boolean, inSvg: boolean, context: Context) {
    const kept: Node[] = [];
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === "#comment") continue;
      if (child.nodeName === "#text") {
        child.value = this.tokens(child.value ?? "", inBody ? context : context === "title" ? "title" : "attribute");
        kept.push(child);
        continue;
      }
      if (child.nodeName === "#documentType") continue;
      if (this.element(child, inBody, inSvg) || !this.strip) kept.push(child);
    }
    node.childNodes = kept;
  }
}

function checkAndClean(html: string, kind: CustomerPageKind, strip: boolean): { errors: string[]; used: Map<string, number>; html: string; doc: Node } {
  const doc = parse(html) as unknown as Node;
  const checker = new Checker(kind, strip);
  checker.children(doc, false, false, "text");
  const root = doc.childNodes?.find((c) => c.nodeName === "html");
  const head = root?.childNodes?.find((c) => c.nodeName === "head");
  const body = root?.childNodes?.find((c) => c.nodeName === "body");
  if (root) root.attrs = [{ name: "lang", value: `{{${LANG_SLOT}}}` }];
  if (head) {
    head.attrs = [];
    // Our charset and viewport lead the head; the template's own are dropped.
    head.childNodes = (head.childNodes ?? []).filter((c) => {
      if (c.nodeName !== "meta") return true;
      return !c.attrs?.some((a) => a.name === "charset" || (a.name === "name" && a.value.toLowerCase() === "viewport"));
    });
  }
  if (body && !strip && !(body.childNodes ?? []).some((c) => c.nodeName !== "#text" || (c.value ?? "").trim())) checker.errors.add("The body is empty.");
  return { errors: [...checker.errors], used: checker.used, html: `<!doctype html>${serialize(doc as never).replace(/^<!DOCTYPE html>/i, "")}`, doc };
}

/**
 * Checks a template the designer wrote for a page, and returns it as it will be stored, or every
 * problem with it, in words the designer can act on.
 */
export function checkTemplate(html: string, kind: CustomerPageKind): TemplateCheck {
  if (new TextEncoder().encode(html).byteLength > TEMPLATE_MAX_BYTES) return { ok: false, errors: [`The page is over ${TEMPLATE_MAX_BYTES / 1024} KB. Make it smaller.`] };
  if (!/<body[\s>]/i.test(html)) return { ok: false, errors: ["Write a whole HTML document: <!doctype html>, <html>, <head>, and <body>."] };
  const { errors, used } = checkAndClean(html, kind, false);
  for (const slot of PAGE_SLOTS[kind]) {
    if (slot.required && !used.has(slot.name)) errors.push(`The page needs {{${slot.name}}}: ${slot.about}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, html };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);

export type SlotValues = { language: "en" | "es"; text: Record<string, string>; blocks: Record<string, string> };

/**
 * A stored template, ready for one view: cleaned to the allowlist again (whatever isn't allowed comes
 * out), then filled. Filling works on the parsed page, one text or attribute at a time, never on its
 * HTML as a string, so slots and language pairs are only ever the ones the check saw in place, and
 * what they fill in is escaped by where it sits. A block (our own HTML) and `head` (our charset,
 * viewport, and the blocks' base styles, first in the head) go in at markers holding a value made for
 * this view, which nothing in a template can know or forge.
 */
export function renderTemplate(html: string, kind: CustomerPageKind, values: SlotValues, head: string): string {
  const { doc } = checkAndClean(html, kind, true);
  const nonce = randomBytes(12).toString("hex");
  const inserts: string[] = [];
  const marker = (content: string, parentNode: Node): Node => ({ nodeName: "#comment", data: `gw:${nonce}:${inserts.push(content) - 1}`, parentNode });
  const blocks = new Set(PAGE_SLOTS[kind].filter((slot) => slot.kind === "block").map((slot) => slot.name));
  const text = (raw: string): string => {
    const pair = LANGUAGE_PAIR.exec(raw);
    if (pair) return values.language === "es" ? pair[2] : pair[1];
    const inner = raw.trim();
    if (inner === LANG_SLOT) return values.language;
    return blocks.has(inner) ? "" : (values.text[inner] ?? "");
  };
  const fill = (node: Node) => {
    for (const attr of node.attrs ?? []) attr.value = attr.value.replace(TOKEN, (_whole, inner: string) => text(inner));
    const name = (node.tagName ?? node.nodeName).toLowerCase();
    if (name === "style") return;
    const children: Node[] = [];
    for (const child of node.childNodes ?? []) {
      if (child.nodeName !== "#text") {
        fill(child);
        children.push(child);
        continue;
      }
      // Cleaning left a block slot only where the check allows one: an element's content in the body.
      const value = child.value ?? "";
      let last = 0;
      for (const match of value.matchAll(TOKEN)) {
        const before = value.slice(last, match.index);
        if (before) children.push({ nodeName: "#text", value: before, parentNode: node });
        const inner = match[1].trim();
        children.push(blocks.has(inner) ? marker(values.blocks[inner] ?? "", node) : { nodeName: "#text", value: text(match[1]), parentNode: node });
        last = (match.index ?? 0) + match[0].length;
      }
      const after = value.slice(last);
      if (after || last === 0) children.push({ nodeName: "#text", value: after, parentNode: node });
    }
    node.childNodes = children;
  };
  fill(doc);
  const headNode = doc.childNodes?.find((c) => c.nodeName === "html")?.childNodes?.find((c) => c.nodeName === "head");
  if (headNode) headNode.childNodes = [marker(head, headNode), ...(headNode.childNodes ?? [])];
  const out = `<!doctype html>${serialize(doc as never).replace(/^<!DOCTYPE html>/i, "")}`;
  return out.replace(new RegExp(`<!--gw:${nonce}:(\\d+)-->`, "g"), (_whole, index: string) => inserts[Number(index)]);
}

/** The slots of a page, as the designer's instructions list them. */
export function slotGuide(kind: CustomerPageKind): string {
  return PAGE_SLOTS[kind].map((s) => `- {{${s.name}}}${s.required ? " (required)" : ""} [${s.kind}]: ${s.about}`).join("\n");
}

export { CUSTOMER_PAGE_CSP } from "./customer-page-csp";

/**
 * The blocks' own styles, first in the head so a template's CSS wins: `:where()` keeps them at zero
 * specificity. A template themes them with the `--gw-*` variables or by restyling the classes.
 */
export const BLOCK_BASE_CSS = `
:where(.gw-logo){display:block;max-height:56px;max-width:200px;width:auto;object-fit:contain}
:where(.gw-label){margin:0;font-size:.75rem;opacity:.7}
:where(.gw-contact,.gw-secure,.gw-help,.gw-valid){margin:0;font-size:.8125rem;opacity:.75}
:where(.gw-lines){width:100%;border-collapse:collapse;font-size:.875rem}
:where(.gw-lines th){text-align:left;font-weight:600;font-size:.75rem;padding:.5rem 0;border-bottom:1px solid var(--gw-line,rgba(127,127,127,.25))}
:where(.gw-lines td){padding:.625rem 0;border-bottom:1px solid var(--gw-line,rgba(127,127,127,.25));vertical-align:top}
:where(.gw-line-name){display:block;font-weight:500}
:where(.gw-line-detail){display:block;font-size:.75rem;opacity:.7}
:where(.gw-num){text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
:where(.gw-totals){margin:.75rem 0 0;font-size:.875rem}
:where(.gw-totals>div){display:flex;justify-content:space-between;gap:1rem;padding:.125rem 0}
:where(.gw-totals dt,.gw-totals dd){margin:0}
:where(.gw-totals dd){font-variant-numeric:tabular-nums}
:where(.gw-total){font-weight:700;font-size:1rem;border-top:1px solid var(--gw-line,rgba(127,127,127,.25));margin-top:.375rem;padding-top:.5rem!important}
:where(.gw-customer p,.gw-notes p){margin:0}
:where(.gw-notes p:last-child){white-space:pre-line}
:where(.gw-action){display:grid;gap:.75rem}
:where(.gw-heading){margin:0;font-size:1rem;font-weight:600}
:where(.gw-amount){margin:0;font-size:1.75rem;font-weight:700;font-variant-numeric:tabular-nums}
:where(.gw-form){display:grid;gap:.75rem}
:where(.gw-field){display:grid;gap:.25rem;font-size:.8125rem}
:where(.gw-input){font:inherit;font-size:1rem;padding:.625rem .75rem;border-radius:calc(var(--gw-radius,12px) * .66);border:1px solid var(--gw-line,rgba(127,127,127,.4));background:transparent;color:inherit;width:100%;box-sizing:border-box}
:where(.gw-button){display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;box-sizing:border-box;padding:.75rem 1rem;border:0;border-radius:999px;background:var(--gw-accent,#111827);color:var(--gw-on-accent,#fff);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
:where(.gw-button.gw-secondary){background:transparent;color:inherit;border:1px solid var(--gw-line,rgba(127,127,127,.4))}
:where(.gw-notice){margin:0;padding:.75rem 1rem;border-radius:var(--gw-radius,12px);background:var(--gw-surface,rgba(127,127,127,.1));font-size:.875rem}
:where(.gw-error){margin:0;font-size:.8125rem;color:#b42318}
:where(.gw-receipt){display:grid;gap:.5rem}
:where(.gw-payments){list-style:none;margin:0;padding:0;font-size:.875rem}
:where(.gw-payments li){display:flex;justify-content:space-between;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--gw-line,rgba(127,127,127,.25))}
`.trim();

/** How the blocks are marked up, for the designer to style them. */
export const BLOCK_GUIDE = `Our blocks come with plain base styles (zero specificity, so yours win). Theme them with CSS variables on :root or body: --gw-accent (button background), --gw-on-accent (button text), --gw-line (rules and borders), --gw-surface (notice background), --gw-radius. Or restyle the classes:
- {{business.logo}}: <img class="gw-logo" alt="…">
- {{business.contact}}: <p class="gw-contact">phone · email</p>
- {{quote.customer}}: <div class="gw-customer"><p class="gw-label">Prepared for</p><p>name</p><p>address</p></div>
- {{quote.items}}: <div class="gw-items"><table class="gw-lines"><thead><tr><th>Service</th><th class="gw-num">Amount</th></tr></thead><tbody><tr><td><span class="gw-line-name">…</span><span class="gw-line-detail">2 hr × $85.00</span></td><td class="gw-num">$170.00</td></tr>…</tbody></table><dl class="gw-totals"><div><dt>Subtotal</dt><dd>…</dd></div>…<div class="gw-total"><dt>Total</dt><dd>…</dd></div></dl></div>
- {{quote.notes}}: <div class="gw-notes"><p class="gw-label">Notes</p><p>…</p></div>
- {{quote.pdf}}: <a class="gw-button gw-secondary" href="…">Download the quote (PDF)</a>
- {{quote.action}} and {{invoice.action}}: <div class="gw-action"> holding some of: <p class="gw-notice gw-ok|gw-closed|gw-alert">…</p>, <h2 class="gw-heading">…</h2>, <p class="gw-amount">$…</p>, <p class="gw-help">…</p>, <form class="gw-form"> with <label class="gw-field"><span>Your name</span><input class="gw-input"></label> and <button class="gw-button">…</button>, <p class="gw-secure">…</p>
- {{quote.receipt}} and {{invoice.receipt}}: <section class="gw-receipt"><h2 class="gw-heading">Receipt</h2><ul class="gw-payments"><li><span>Visa •••• 4242 · Nov 3</span><span class="gw-num">$…</span></li></ul><dl class="gw-totals">…</dl><a class="gw-button gw-secondary">…</a></section>`;
