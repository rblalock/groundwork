"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export type JumpSection = { id: string; label: string; count?: number };

/**
 * The sections of a long record page, as a bar that stays at the top while the page scrolls: a tap jumps
 * to one, and the one in view is marked. Sections are elements with these ids (`clearOfJumpBar` keeps
 * their title clear of the bar). `end` sits at its far end (a page's view toggle).
 */
export function JumpBar({ sections, label, end }: { sections: JumpSection[]; label: string; end?: ReactNode }) {
  const bar = useRef<HTMLElement>(null);
  const [active, setActive] = useState(sections[0]?.id);
  const ids = sections.map((s) => s.id).join(" ");

  useEffect(() => {
    const root = bar.current?.closest(".paper-body") ?? null;
    const targets = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const scroller = root instanceof HTMLElement ? root : null;
    // The section nearest the top of the view, below the bar, is the one being read. The bar sticks below
    // the page's top padding, so the view's top is the padding plus the bar.
    const top = (scroller ? parseFloat(getComputedStyle(scroller).paddingTop) || 0 : 0) + (bar.current?.offsetHeight ?? 0);
    const seen = new Map<string, boolean>();
    // A section the address points into is the one marked, until the reader scrolls: the jump to it can
    // land with the section before it still in view, and the page can shift as its photos load.
    let pinned: string | null = null;
    const read = () => {
      if (pinned) return;
      const first = targets.find((t) => seen.get(t.id));
      if (first) setActive(first.id);
    };
    const pinToHash = () => {
      let hash = window.location.hash.slice(1);
      try {
        hash = decodeURIComponent(hash);
      } catch {
        // A malformed escape: look it up as it is.
      }
      const el = hash ? document.getElementById(hash) : null;
      const section = el ? targets.find((t) => t.contains(el)) : undefined;
      if (!section) return;
      pinned = section.id;
      setActive(section.id);
    };
    const unpin = () => {
      if (!pinned) return;
      pinned = null;
      read();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
        read();
      },
      { root, rootMargin: `-${Math.round(top)}px 0px -55% 0px` },
    );
    for (const target of targets) observer.observe(target);
    pinToHash();
    // At the very bottom, the last section is the one being read, however short it is.
    const onScroll = () => {
      if (!pinned && scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) setActive(targets[targets.length - 1].id);
    };
    // Only the reader's own scrolling hands the mark back; the browser's jump to the address scrolls too.
    const handBack = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    for (const type of handBack) scroller?.addEventListener(type, unpin, { passive: true });
    window.addEventListener("hashchange", pinToHash);
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
      for (const type of handBack) scroller?.removeEventListener(type, unpin);
      window.removeEventListener("hashchange", pinToHash);
    };
  }, [ids]);

  // On a phone the bar scrolls sideways; keep the marked section's tab in it.
  useEffect(() => {
    const row = bar.current;
    const current = row?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!row || !current) return;
    const tab = current.getBoundingClientRect();
    const view = row.getBoundingClientRect();
    if (tab.left < view.left || tab.right > view.right) row.scrollLeft += tab.left - view.left - (view.width - tab.width) / 2;
  }, [active]);

  return (
    <nav
      aria-label={label}
      className="sticky top-0 z-10 -mx-4 flex gap-1.5 overflow-x-auto bg-page/90 px-4 py-2 backdrop-blur-sm [scrollbar-width:none] sm:-mx-10 sm:px-10"
      ref={bar}
    >
      {sections.map((section) => (
        <a
          aria-current={active === section.id ? "true" : undefined}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-colors",
            active === section.id ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-2 hover:bg-hover hover:text-ink",
          )}
          href={`#${section.id}`}
          key={section.id}
          onClick={(event) => {
            const target = document.getElementById(section.id);
            if (!target) return;
            event.preventDefault();
            target.scrollIntoView({ behavior: "smooth", block: "start" });
            setActive(section.id);
          }}
        >
          {section.label}
          {section.count ? <span className="text-[11px] text-ink-3 tabular-nums">{section.count}</span> : null}
        </a>
      ))}
      {end ? <div className="ml-auto flex shrink-0 items-center pl-2">{end}</div> : null}
    </nav>
  );
}
