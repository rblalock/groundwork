"use client";

import { PanelRightOpen } from "lucide-react";
import { usePathname } from "next/navigation";
import { copyFor } from "@/lib/copy";
import { cn } from "@/ui/lib/utils";
import { useThreadRail, withoutRail } from "./rail-context";

/** In a page's title bar: brings the thread panel back while it's put away with threads open in it. */
export function RailToggleButton({ className }: { className?: string }) {
  const rail = useThreadRail();
  const pathname = usePathname();
  if (!rail || rail.open || rail.tabs.length === 0) return null;
  if ((rail.active && pathname === `/threads/${rail.active}`) || withoutRail(pathname)) return null;
  const label = copyFor(rail.language).rail.show;
  return (
    <button
      aria-label={label}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 rounded-[8px] px-1.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink",
        className,
      )}
      onClick={rail.show}
      title={label}
      type="button"
    >
      <PanelRightOpen aria-hidden="true" size={16} />
      <span className="text-[11px] tabular-nums">{rail.tabs.length}</span>
    </button>
  );
}
