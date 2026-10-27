// Runs inside a website's page (agent-browser `eval`) and reads its brand from what the page actually
// renders, the way Firecrawl's branding extraction does: computed styles, not the HTML's words. It
// returns facts for the designer to judge, not a verdict: the page's background and text, the colors
// covering the most of the screen, its buttons and links (where a brand's accent usually is), its
// headings and body type, the fonts that loaded, its CSS custom properties, and logo candidates.
// Plain ES2017 in one string: it runs in whatever browser the sandbox has, with no bundling.
export const BRAND_SCRIPT = String.raw`(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const toHex = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
    if (Number(a) < 0.5) return null;
    return "#" + [r, g, b].map((v) => Math.round(Number(v)).toString(16).padStart(2, "0")).join("");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.1;
  };
  const font = (s) => ({
    family: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
    stack: s.fontFamily,
    size: s.fontSize,
    weight: s.fontWeight,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    transform: s.textTransform,
  });
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const hex = toHex(getComputedStyle(n).backgroundColor);
      if (hex) return hex;
    }
    return "#ffffff";
  };

  // Colors by how much of the first two screens they cover.
  const area = {};
  const textColors = {};
  const limit = window.innerHeight * 2;
  for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 2500)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > limit) continue;
    const s = getComputedStyle(el);
    const bg = toHex(s.backgroundColor);
    if (bg) area[bg] = (area[bg] || 0) + r.width * Math.min(r.height, limit);
    if (el.childNodes.length && Array.from(el.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim())) {
      const fg = toHex(s.color);
      if (fg) textColors[fg] = (textColors[fg] || 0) + (el.textContent || "").trim().length;
    }
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([color]) => color);

  // Buttons and button-like links near the top: where the accent usually is.
  const buttons = [];
  for (const el of document.querySelectorAll("button, a, [role=button], input[type=submit]")) {
    if (buttons.length >= 8 || !visible(el)) continue;
    const s = getComputedStyle(el);
    const bg = toHex(s.backgroundColor);
    const bordered = parseFloat(s.borderTopWidth) > 0 && toHex(s.borderTopColor);
    if (!bg && !bordered) continue;
    const text = (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (!text) continue;
    buttons.push({
      text,
      background: bg,
      color: toHex(s.color),
      border: bordered ? s.borderTopWidth + " " + toHex(s.borderTopColor) : null,
      radius: s.borderTopLeftRadius,
      padding: s.paddingTop + " " + s.paddingRight,
      font: font(s),
      top: Math.round(el.getBoundingClientRect().top),
    });
  }

  const pick = (selector) => {
    const el = Array.from(document.querySelectorAll(selector)).find(visible);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { text: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60), color: toHex(s.color), font: font(s) };
  };
  const link = Array.from(document.querySelectorAll("a")).find((a) => visible(a) && !toHex(getComputedStyle(a).backgroundColor));

  // The page's own design tokens: custom properties on :root and the theme root.
  const tokens = {};
  const rootStyle = getComputedStyle(document.documentElement);
  const names = new Set();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const rule of Array.from(rules || [])) {
      const text = rule.cssText || "";
      if (!/^(:root|html|body|\[data-theme|\.dark|\.light)/.test(rule.selectorText || "")) continue;
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
    }
  }
  for (const name of names) {
    if (Object.keys(tokens).length >= 60) break;
    if (/^--tw-/.test(name)) continue;
    const value = rootStyle.getPropertyValue(name).trim();
    if (value && /(#|rgb|hsl|oklch|lab\(|color|font|radius|space|gap)/i.test(name + " " + value)) tokens[name] = value.slice(0, 80);
  }

  const loadedFonts = Array.from(new Set(Array.from(document.fonts || []).filter((f) => f.status === "loaded").map((f) => f.family.replace(/["']/g, ""))));
  const meta = (name) => document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]')?.getAttribute("content") || null;
  const logos = Array.from(document.querySelectorAll("header img, header svg, nav img, nav svg, a[href='/'] img, a[href='/'] svg, [class*=logo] img, [class*=logo] svg, img[alt*=logo i]"))
    .filter(visible)
    .slice(0, 4)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { kind: el.tagName.toLowerCase(), src: el.currentSrc || el.getAttribute("src") || null, alt: el.getAttribute("alt"), width: Math.round(r.width), height: Math.round(r.height), color: toHex(getComputedStyle(el).color) };
    });

  const bodyBg = bgOf(document.body);
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return {
    url: location.href,
    title: document.title,
    description: meta("description"),
    themeColor: meta("theme-color"),
    scheme: lum(bodyBg) < 0.2 ? "dark" : "light",
    page: { background: bodyBg, text: toHex(getComputedStyle(document.body).color) },
    colorsByArea: top(area, 8),
    textColors: top(textColors, 6),
    buttons,
    link: link ? { color: toHex(getComputedStyle(link).color), decoration: getComputedStyle(link).textDecorationLine } : null,
    heading: pick("h1") || pick("h2"),
    subheading: pick("h2") || pick("h3"),
    body: pick("main p, article p, p"),
    small: pick("small, .caption, figcaption, footer p"),
    loadedFonts,
    tokens,
    logos,
    ogImage: meta("og:image"),
    viewport: { width: window.innerWidth, height: window.innerHeight, scale: round(window.devicePixelRatio) },
  };
})()`;
