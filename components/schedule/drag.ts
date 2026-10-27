"use client";

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { VisitJson } from "@/lib/pages/schedule";
import type { MoveTarget } from "@/lib/schedule-presentation";

export { SNAP_MINUTES, draggable, moveRequest, snap, visitMinutes, type MoveRequest, type MoveTarget } from "@/lib/schedule-presentation";

// Dragging a visit on the Schedule page, for owners and admins with a mouse or pen. The calendar only
// proposes the move (lib/schedule-presentation.ts works out what it would send): the board asks to
// confirm it, then sends it to the same route the Reschedule form uses, which applies the same rules
// (crew busy, time off, working hours). Touch screens and keyboards use the form; on a phone a drag
// would fight scrolling.

/** How far a press travels before it's a drag rather than a click. */
const THRESHOLD_PX = 5;

type Drag = { visit: VisitJson; fromMemberId: string; pointerId: number; x: number; y: number; grab: number; moved: boolean; target: MoveTarget | null };

/**
 * Pointer bookkeeping for one calendar view. `locate` turns a pointer position into a target (null off
 * the calendar); `grabAt` is, in day view, how far into the visit it was picked up. A press that
 * doesn't travel stays a click, which opens the visit; Escape drops nothing.
 */
export function useVisitDrag({
  enabled,
  locate,
  grabAt,
  onDrop,
}: {
  enabled: boolean;
  locate: (x: number, y: number, drag: { visit: VisitJson; grab: number }) => MoveTarget | null;
  grabAt?: (event: PointerEvent<HTMLElement>, visit: VisitJson) => number;
  onDrop: (visit: VisitJson, fromMemberId: string, target: MoveTarget) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const [target, setTarget] = useState<MoveTarget | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const stop = () => {
    drag.current = null;
    setTarget(null);
    setDragging(null);
  };

  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      swallowClick.current = true;
      stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);

  function bind(visit: VisitJson, fromMemberId: string) {
    if (!enabled) return {};
    return {
      "data-draggable": "",
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 || event.pointerType === "touch") return;
        drag.current = {
          visit,
          fromMemberId,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          grab: grabAt?.(event, visit) ?? 0,
          moved: false,
          target: null,
        };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!current.moved) {
          if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < THRESHOLD_PX) return;
          current.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(visit.visitId);
        }
        event.preventDefault();
        current.target = locate(event.clientX, event.clientY, current);
        setTarget(current.target);
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        stop();
        if (!current.moved) return;
        swallowClick.current = true;
        if (current.target) onDrop(current.visit, current.fromMemberId, current.target);
      },
      onPointerCancel: stop,
      onLostPointerCapture(event: PointerEvent<HTMLElement>) {
        if (drag.current?.pointerId === event.pointerId && drag.current.moved) stop();
      },
      onClickCapture(event: MouseEvent<HTMLElement>) {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }

  return { target, dragging, bind };
}
