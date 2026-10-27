import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { chatRemarkPlugins } from "./chat-markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Streamdown, { remarkPlugins: chatRemarkPlugins, mode: "static" }, text));

test("a single newline in a chat message is a line break", () => {
  const html = render("Quote for 12 Oak St\n20 windows: $240\nTotal: $240");
  assert.equal((html.match(/<br\s*\/?>/g) ?? []).length, 2, html);
});

test("lists still render as lists, and blank lines as paragraphs", () => {
  const html = render("I need two prices:\n1) Widget service, per widget?\n2) Setup, per hour?\n\nThanks.");
  assert.match(html, /<ol[\s>]/, html);
  assert.equal((html.match(/<li[\s>]/g) ?? []).length, 2, html);
  assert.match(render("- one\n- two"), /<ul[\s>]/);
  assert.ok((render("First.\n\nSecond.").match(/<p[\s>]/g) ?? []).length >= 2);
});
