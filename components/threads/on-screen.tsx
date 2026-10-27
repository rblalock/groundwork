"use client";

import { useEffect } from "react";
import type { OnScreenRecord } from "@/lib/on-screen";
import { useThreadRail } from "./rail-context";

/** Tells the thread panel which record this page shows, for as long as it's shown. Renders nothing. */
export function OnScreen({ record }: { record: OnScreenRecord }) {
  const setOnScreen = useThreadRail()?.setOnScreen;
  const { kind, id, label } = record;
  useEffect(() => {
    if (!setOnScreen) return;
    setOnScreen({ kind, id, label });
    return () => setOnScreen(null);
  }, [setOnScreen, kind, id, label]);
  return null;
}
