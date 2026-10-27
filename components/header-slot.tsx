"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/ui/lib/utils";

// A place in a panel's title bar that something inside the panel can put a control into: the chat's
// language toggle sits in the page's title bar, or the thread panel's, instead of above the messages.

type Slot = { el: HTMLElement | null; setEl: (el: HTMLElement | null) => void };
const SlotContext = createContext<Slot | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return <SlotContext.Provider value={{ el, setEl }}>{children}</SlotContext.Provider>;
}

/** Where the title bar takes what's put in it. */
export function HeaderSlot({ className }: { className?: string }) {
  const slot = useContext(SlotContext);
  if (!slot) return null;
  return <div className={cn("flex min-w-0 items-center", className)} data-header-slot="" ref={slot.setEl} />;
}

/** Puts its children in the nearest title bar's slot, or right here without one. */
export function InHeader({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  if (!slot) return <>{children}</>;
  return slot.el ? createPortal(children, slot.el) : null;
}
