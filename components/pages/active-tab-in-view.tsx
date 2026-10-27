"use client";

import { useEffect, useRef } from "react";

/** Inside a row of tabs that scrolls sideways: brings the current one (`aria-current="page"`) into view. */
export function ActiveTabInView() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const row = marker.current?.parentElement;
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !current) return;
    const left = current.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + current.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, left - (row.clientWidth - current.offsetWidth) / 2);
    }
  }, []);
  return <span aria-hidden="true" className="hidden" ref={marker} />;
}
