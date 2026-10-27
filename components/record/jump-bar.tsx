"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

export type JumpSection = { id: string; label: string; count?: number };

/**
 * The sections of a long record page, as a bar that stays at the top while the page scrolls: a tap jumps
 * to one, and the one in view is marked. Sections are elements with these ids (`scroll-mt-14` keeps
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
    // The section nearest the top of the view is the one being read.
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
        const first = targets.find((t) => seen.get(t.id));
        if (first) setActive(first.id);
      },
      { root, rootMargin: "-56px 0px -55% 0px" },
    );
    for (const target of targets) observer.observe(target);
    // At the very bottom, the last section is the one being read, however short it is.
    const scroller = root instanceof HTMLElement ? root : null;
    const onScroll = () => {
      if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) setActive(targets[targets.length - 1].id);
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [ids]);

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
