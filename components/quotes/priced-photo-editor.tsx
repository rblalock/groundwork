"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, PenLine, Search, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LoadingState, Spinner } from "@/components/spinner";
import type { Language } from "@/core/language";
import { pluralUnit } from "@/core/units";
import { money, quantity } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { MAX_DRAWN_POINTS, MAX_PROMPT_POINTS, SELECTED_PHRASE } from "@/core/priced-photo-select";
import {
  applyAssignment,
  assignmentsOf,
  boxAnswer,
  closesAt,
  editedAgo,
  PricedPhotoError,
  pricedPhotoApi,
  sketchPath,
  type PricedBox,
  type PricedCandidate,
  type PricedPhotoApi,
  type PricedPhotoEditorState,
  type PricedRegion,
  type Point,
} from "@/lib/priced-photo-editor";
import { Button } from "@/ui/beautiful/atoms/Button";
import { cn } from "@/ui/lib/utils";
import { ErrorLine, inputClass, NativeSelect } from "../pages/client-kit";

// Editing a quote's priced photo by hand (lib/priced-photo-editor.ts). Everything SAM found in the photo
// is outlined over it; tapping an outline lists the quote's lines to put it on, a box dragged on the
// photo asks SAM to look again there for something it missed (by a word, or with none for the one thing
// in the box), and points tapped around a thing SAM never finds outline it by hand. Each change saves the
// whole set, and the server draws the priced PNG again from it.

/** One color per line, in line order: the same ones the priced PNG draws with (core/priced-photo.ts). */
const PALETTE = ["#ff9f0a", "#0a84ff", "#ff375f", "#bf5af2", "#ffd60a", "#64d2ff", "#ff3b30", "#30d158"];
const colorOf = (lineIndex: number) => PALETTE[lineIndex % PALETTE.length];

/** The height of the page around the photo: the app's title bar, the section bar, the buttons under the photo, and the find form. */
const STAGE_RESERVE = "22rem";
/** A tap, not a drag, makes a box this share of the photo's width around where it landed. */
const TAP_BOX = 0.15;
/** A tap this close to an outline's first point, in screen pixels, closes it. */
const CLOSE_REACH = 16;
/** The hover label's widest, the most it takes below the pointer, and its gap from the pointer, in screen pixels. */
const LABEL_WIDTH = 224;
const LABEL_HEIGHT = 48;
const LABEL_GAP = 12;
type Hover = { id: string; x: number; y: number; flipX: boolean; flipY: boolean; maxWidth: number };
/** The outline whose lines are showing, where its list hangs (in % of the photo), and the lines' order when it opened. */
type Picked = { id: string; x: number; y: number; order: number[]; keyboard: boolean };
/**
 * Asking SAM: by a phrase, kept inside `box` when one is drawn, or with no phrase for the one thing in
 * `box`. After a boxed answer, `answer` is what SAM found and `replace` the one it added; each tap off it
 * (`points`) asks again with the box and every tap so far.
 */
type Finding = {
  lineIndex: number | null;
  phrase: string;
  box: PricedBox | null;
  busy: boolean;
  message?: string;
  points: Point[];
  answer: string[] | null;
  replace: string | null;
};
/** An outline being drawn by hand: its points in the photo's pixels, where the pointer is, and whether it's closed. */
type Sketch = { points: Point[]; at: Point | null; closed: boolean; busy: boolean; message?: string };

export function PricedPhotoEditor({
  quoteId,
  pricedId,
  language,
  onClose,
  api: givenApi,
}: {
  quoteId: string;
  pricedId: string;
  language: Language;
  /** Called with the last state the server sent, once any save in flight has landed. */
  onClose: (last: PricedPhotoEditorState | null) => void;
  /** The routes; another implementation tries the editor without a server. */
  api?: PricedPhotoApi;
}) {
  const copy = pageCopyFor(language);
  const e = copy.quotes.pricedEdit;
  const api = useMemo(() => givenApi ?? pricedPhotoApi(quoteId, pricedId), [givenApi, quoteId, pricedId]);

  const [state, setState] = useState<PricedPhotoEditorState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [hover, setHover] = useState<Hover | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // The last outline picked stays while its list closes, so the list fades out whole.
  const [picked, setPicked] = useState<Picked | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [draft, setDraft] = useState<{ start: Point; box: PricedBox } | null>(null);
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [closing, setClosing] = useState(false);

  // The server's last word, to fall back to when a save fails; the save that counts is the latest one sent.
  const confirmed = useRef<PricedPhotoEditorState | null>(null);
  const saveSeq = useRef(0);
  const confirmedSeq = useRef(0);
  const inflight = useRef<Promise<unknown> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  // A tap on the photo adds its point when it lifts, and only if it went down there.
  const pressed = useRef(false);

  const accept = (next: PricedPhotoEditorState) => {
    confirmedSeq.current = saveSeq.current;
    confirmed.current = next;
    setState(next);
  };

  const load = () => {
    setLoadFailed(false);
    api.load().then(accept, () => setLoadFailed(true));
  };
  useEffect(load, [api]);

  // Escape leaves the box drawing; the popover closes itself.
  useEffect(() => {
    if (!finding || finding.busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFinding(null);
        setDraft(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [finding]);

  // Escape steps back through the outline being drawn: open a closed one, drop the last point, then leave.
  useEffect(() => {
    if (!sketch || sketch.busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stepBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sketch]);

  const onLines = useMemo(() => new Map(assignmentsOf(state?.regions ?? []).map((a) => [a.candidateId, a.lineIndexes])), [state?.regions]);
  const regionOf = useMemo(() => new Map((state?.regions ?? []).map((region) => [region.lineIndex, region])), [state?.regions]);
  const nameOf = useMemo(() => new Map((state?.lines ?? []).map((line) => [line.lineIndex, line.name])), [state?.lines]);
  // Big outlines first, so the small ones drawn over them can still be tapped.
  const drawn = useMemo(() => [...(state?.candidates ?? [])].sort((a, b) => b.areaPx - a.areaPx), [state?.candidates]);

  if (!state) {
    return loadFailed ? (
      <div className="space-y-2">
        <ErrorLine>{e.loadFailed}</ErrorLine>
        <div className="flex gap-2">
          <Button onClick={load} size="sm" type="button" variant="secondary">
            {copy.common.retry}
          </Button>
          <Button onClick={() => onClose(null)} size="sm" type="button" variant="quiet">
            {e.done}
          </Button>
        </div>
      </div>
    ) : (
      <LoadingState label={copy.common.loading} />
    );
  }

  // A box or an outline is being drawn: the outlines underneath can't be picked meanwhile.
  const drawing = finding !== null || sketch !== null;
  const labelOf = (candidate: PricedCandidate) => (candidate.source === "hand" ? e.drawn : candidate.phrase === SELECTED_PHRASE ? e.selected : candidate.phrase);
  const linesText = (candidateId: string) => {
    const lines = onLines.get(candidateId) ?? [];
    return lines.length ? lines.map((index) => nameOf.get(index) ?? "").join(", ") : e.notOnLine;
  };

  /** Shows a change at once and saves the whole set; if the save fails, the server's last word comes back. */
  function commit(regions: PricedRegion[]) {
    const seq = ++saveSeq.current;
    setState((current) => (current ? { ...current, regions } : current));
    setError(undefined);
    setNotice(undefined);
    const saving = api.save(assignmentsOf(regions)).then(
      (next) => {
        if (seq < confirmedSeq.current) return;
        confirmedSeq.current = seq;
        confirmed.current = next;
        if (seq === saveSeq.current) setState(next);
      },
      () => {
        if (seq !== saveSeq.current) return;
        setState(confirmed.current);
        setError(e.savingFailed);
      },
    );
    inflight.current = saving;
  }

  function toggle(candidateId: string, lineIndex: number) {
    if (!state) return;
    const on = !(onLines.get(candidateId) ?? []).includes(lineIndex);
    commit(applyAssignment(state.regions, state.candidates, candidateId, lineIndex, on));
  }

  function clear(candidateId: string) {
    if (!state) return;
    const lines = onLines.get(candidateId) ?? [];
    commit(lines.reduce((regions, lineIndex) => applyAssignment(regions, state.candidates, candidateId, lineIndex, false), state.regions));
  }

  function pick(candidate: PricedCandidate, at: Point, keyboard: boolean) {
    if (!state) return;
    // Lines not yet found in the photo first; the order holds while the list is open.
    const order = state.lines
      .map((line) => line.lineIndex)
      .sort((a, b) => Number(regionOf.get(a)?.located ?? false) - Number(regionOf.get(b)?.located ?? false) || a - b);
    setHover(null);
    setPicked({ id: candidate.id, x: (at.x / state.width) * 100, y: (at.y / state.height) * 100, order, keyboard });
    setOpen(true);
  }

  /** A pointer's place on the photo, in the photo's pixels. */
  function imagePoint(clientX: number, clientY: number): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    const { width, height } = state!;
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
    return { x: clamp(((clientX - rect.left) / rect.width) * width, width), y: clamp(((clientY - rect.top) / rect.height) * height, height) };
  }

  /**
   * Shows the label by a pointer that moved over an outline. Not on entering one: an editor that opens
   * under a resting mouse would show a label nobody asked for, and a browser's move made up after a
   * layout change, which goes nowhere, doesn't count either.
   */
  function hoverAt(candidate: PricedCandidate, event: ReactPointerEvent) {
    if (event.pointerType === "touch" || open) return;
    if (event.movementX === 0 && event.movementY === 0 && hover?.id !== candidate.id) return;
    const rect = stageRef.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // Left of the pointer when it doesn't fit to the right, above when it doesn't fit below; never past the photo's edge.
    const right = rect.width - x - LABEL_GAP;
    const left = x - LABEL_GAP;
    const flipX = right < LABEL_WIDTH && left > right;
    const flipY = rect.height - y - LABEL_GAP < LABEL_HEIGHT && y > rect.height / 2;
    setHover({ id: candidate.id, x, y, flipX, flipY, maxWidth: Math.max(Math.min(LABEL_WIDTH, flipX ? left : right), 0) });
  }

  function startFind(lineIndex: number | null) {
    const line = lineIndex === null ? undefined : state?.lines.find((l) => l.lineIndex === lineIndex);
    setOpen(false);
    setSketch(null);
    setNotice(undefined);
    setError(undefined);
    setDraft(null);
    // A line with no photo prompt starts with no phrase: a box then asks for the one thing in it.
    setFinding({ lineIndex, phrase: line?.phrase ?? "", box: null, busy: false, points: [], answer: null, replace: null });
  }

  function startSketch() {
    setOpen(false);
    setNotice(undefined);
    setError(undefined);
    setFinding(null);
    setDraft(null);
    setSketch({ points: [], at: null, closed: false, busy: false });
  }

  function stepBack() {
    setSketch((current) => {
      if (!current || current.busy) return current;
      if (current.closed) return { ...current, closed: false, message: undefined };
      if (current.points.length === 0) return null;
      return { ...current, points: current.points.slice(0, -1), message: undefined };
    });
  }

  const drawable = (current: Sketch | null): current is Sketch => current !== null && !current.closed && !current.busy;

  function sketchDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!drawable(sketch)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressed.current = true;
    setSketch({ ...sketch, at: imagePoint(event.clientX, event.clientY) });
  }

  function sketchMove(event: ReactPointerEvent<SVGSVGElement>) {
    // A mouse shows the next edge as it moves; a finger only while it's down.
    if (!drawable(sketch) || (event.pointerType !== "mouse" && !pressed.current)) return;
    setSketch({ ...sketch, at: imagePoint(event.clientX, event.clientY) });
  }

  function sketchUp(event: ReactPointerEvent<SVGSVGElement>) {
    if (!drawable(sketch) || !pressed.current) return;
    pressed.current = false;
    const at = imagePoint(event.clientX, event.clientY);
    const reach = (CLOSE_REACH / svgRef.current!.getBoundingClientRect().width) * state!.width;
    const after = event.pointerType === "mouse" ? at : null;
    if (closesAt(sketch.points, at, reach)) setSketch({ ...sketch, at: null, closed: true, message: undefined });
    else if (sketch.points.length >= MAX_DRAWN_POINTS) setSketch({ ...sketch, at: after, message: e.drawTooMany });
    else setSketch({ ...sketch, points: [...sketch.points, at], at: after, message: undefined });
  }

  async function saveSketch(lineIndex: number | null) {
    if (!sketch || !sketch.closed) return;
    const points = sketch.points.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }));
    setSketch({ ...sketch, busy: true, message: undefined });
    try {
      // After any move still saving, so the outline lands on the set as it ends up.
      await inflight.current;
      const { added, ...next } = await api.draw({ points, ...(lineIndex !== null ? { lineIndex } : {}) });
      accept(next);
      setSketch(null);
      setNotice(added ? e.drawnSaved : e.drawnSame);
      if (lineIndex !== null) setHighlight(lineIndex);
    } catch (failure) {
      const message = failure instanceof PricedPhotoError && failure.status === 400 ? e.drawBad : e.drawFailed;
      setSketch((current) => (current ? { ...current, busy: false, message } : current));
    }
  }

  async function removeOutline(candidateId: string) {
    setOpen(false);
    setError(undefined);
    setNotice(undefined);
    try {
      await inflight.current;
      accept(await api.removeDrawn(candidateId));
      setNotice(e.outlineRemoved);
    } catch {
      setError(e.savingFailed);
    }
  }

  function drawStart(event: ReactPointerEvent<SVGSVGElement>) {
    if (!finding || finding.busy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // After a boxed answer, a tap says where it isn't.
    if (finding.answer) {
      pressed.current = true;
      return;
    }
    const start = imagePoint(event.clientX, event.clientY);
    setDraft({ start, box: { left: start.x, top: start.y, right: start.x, bottom: start.y } });
  }

  function drawMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!draft) return;
    const at = imagePoint(event.clientX, event.clientY);
    setDraft({
      start: draft.start,
      box: { left: Math.min(draft.start.x, at.x), top: Math.min(draft.start.y, at.y), right: Math.max(draft.start.x, at.x), bottom: Math.max(draft.start.y, at.y) },
    });
  }

  function drawEnd(event: ReactPointerEvent<SVGSVGElement>) {
    if (finding?.answer) {
      if (!pressed.current) return;
      pressed.current = false;
      notThis(imagePoint(event.clientX, event.clientY));
      return;
    }
    if (!draft || !state) return;
    const { box, start } = draft;
    const small = state.width * 0.02;
    let next = box;
    if (box.right - box.left < small && box.bottom - box.top < small) {
      // A tap: a square around it, kept inside the photo.
      const side = Math.min(state.width * TAP_BOX, state.width, state.height);
      const left = Math.min(Math.max(start.x - side / 2, 0), state.width - side);
      const top = Math.min(Math.max(start.y - side / 2, 0), state.height - side);
      next = { left, top, right: left + side, bottom: top + side };
    }
    const rounded = { left: Math.round(next.left), top: Math.round(next.top), right: Math.round(next.right), bottom: Math.round(next.bottom) };
    setDraft(null);
    setFinding((current) => (current ? { ...current, box: rounded, message: undefined } : current));
  }

  async function find(event: FormEvent) {
    event.preventDefault();
    if (!finding || finding.busy) return;
    if (!finding.phrase.trim()) {
      if (finding.box) await askBox({ ...finding, points: [], answer: null, replace: null });
      return;
    }
    const { lineIndex, box } = finding;
    setFinding({ ...finding, busy: true, message: undefined });
    try {
      const { found, ...next } = await api.find({ phrase: finding.phrase.trim(), ...(box ? { box } : {}), ...(lineIndex !== null ? { lineIndex } : {}) });
      accept(next);
      if (found === 0) {
        setFinding((current) => (current ? { ...current, busy: false, message: e.nothingFound } : current));
        return;
      }
      setFinding(null);
      setNotice(e.found(found));
      if (lineIndex !== null) setHighlight(lineIndex);
    } catch {
      setFinding((current) => (current ? { ...current, busy: false, message: e.findFailed } : current));
    }
  }

  /** A tap off the boxed answer: asks again, up to `MAX_PROMPT_POINTS` taps (the hint says when there are no more). */
  function notThis(at: Point) {
    if (!finding || finding.busy || finding.points.length >= MAX_PROMPT_POINTS) return;
    void askBox({ ...finding, points: [...finding.points, at] });
  }

  /** Asks SAM for the one thing in the box, off every tap so far, in place of what the last ask added. */
  async function askBox(ask: Finding) {
    const { box, points, lineIndex, replace } = ask;
    if (!box) return;
    setFinding({ ...ask, busy: true, message: undefined });
    try {
      // After any move still saving, so the answer lands on the set as it ends up.
      await inflight.current;
      const before = new Set((confirmed.current?.candidates ?? []).map((c) => c.id));
      const { found, candidateIds, ...next } = await api.find({
        box,
        ...(points.length ? { points: points.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y), negative: true })) } : {}),
        ...(lineIndex !== null ? { lineIndex } : {}),
        ...(replace ? { replace } : {}),
      });
      accept(next);
      if (candidateIds.length === 0) {
        // Nothing there: back to the box, to ask again or draw another.
        setFinding((current) => (current ? { ...current, busy: false, points: [], answer: null, replace: null, message: e.nothingInBox } : current));
        return;
      }
      // "Outlined already" only when nothing new came back: everything SAM found was kept before the ask.
      const answer = boxAnswer(before, candidateIds, found);
      setFinding((current) =>
        current ? { ...current, busy: false, points, answer: candidateIds, replace: answer.added, message: answer.same ? e.foundSame : e.found(answer.found) } : current,
      );
      if (answer.found && lineIndex !== null) setHighlight(lineIndex);
    } catch {
      setFinding((current) => (current ? { ...current, busy: false, message: e.findFailed } : current));
    }
  }

  async function done() {
    setClosing(true);
    await inflight.current;
    onClose(confirmed.current);
  }

  const pickedCandidate = picked ? state.candidates.find((c) => c.id === picked.id) : undefined;
  const pickedLines = picked ? (onLines.get(picked.id) ?? []) : [];
  const shownBox = draft?.box ?? finding?.box ?? null;
  const focusedCandidate = !hover && !open && focused ? state.candidates.find((c) => c.id === focused) : undefined;
  const hoverCandidate = hover ? state.candidates.find((c) => c.id === hover.id) : undefined;

  return (
    <div className="space-y-3">
      <div
        // While a box is drawn, a drag never selects text and a touch never scrolls the page. Scrolled to, it
        // lands clear of the quote page's sticky section bar, which sticks below the page's top padding.
        className={cn("relative mx-auto scroll-mt-18 overflow-hidden rounded-[8px] bg-inset shadow-hairline sm:scroll-mt-21", drawing && "touch-none select-none")}
        ref={stageRef}
        style={{
          aspectRatio: `${state.width} / ${state.height}`,
          // No taller than the view less the bar, the buttons, and the find form, so Find is pressed with the photo in sight.
          width: `min(100%, max(16rem, calc((100dvh - ${STAGE_RESERVE}) * ${(state.width / state.height).toFixed(4)})))`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
        <img alt={e.photoAlt} className="absolute inset-0 size-full select-none" draggable={false} src={state.photoUrl} />
        <svg
          className={cn("absolute inset-0 size-full", ((finding && !finding.busy) || drawable(sketch)) && "cursor-crosshair")}
          onPointerCancel={() => {
            setDraft(null);
            pressed.current = false;
          }}
          onPointerDown={finding ? drawStart : sketch ? sketchDown : undefined}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse" && drawable(sketch)) setSketch({ ...sketch, at: null });
          }}
          onPointerMove={finding ? drawMove : sketch ? sketchMove : undefined}
          onPointerUp={finding ? drawEnd : sketch ? sketchUp : undefined}
          preserveAspectRatio="none"
          ref={svgRef}
          viewBox={`0 0 ${state.width} ${state.height}`}
        >
          {drawn.map((candidate) => {
            const lines = onLines.get(candidate.id) ?? [];
            const color = lines.length ? colorOf(lines[0]) : null;
            const expanded = open && picked?.id === candidate.id;
            const answered = finding?.answer?.includes(candidate.id) ?? false;
            const lit = hover?.id === candidate.id || focused === candidate.id || expanded || answered || (highlight !== null && lines.includes(highlight));
            const dim = ((highlight !== null && !lines.includes(highlight)) || drawing) && !answered;
            return (
              <path
                aria-expanded={expanded}
                aria-haspopup="dialog"
                aria-label={`${labelOf(candidate)}: ${linesText(candidate.id)}`}
                className="cursor-pointer scroll-mt-18 outline-none transition-[stroke-opacity,fill-opacity,stroke-width] duration-150 sm:scroll-mt-21"
                d={candidate.svgPath}
                data-candidate={candidate.id}
                fill={color ?? "#ffffff"}
                fillOpacity={lit ? (color ? 0.4 : 0.18) : dim ? 0 : color ? 0.2 : 0}
                key={candidate.id}
                onBlur={() => setFocused((current) => (current === candidate.id ? null : current))}
                onClick={(event) => pick(candidate, imagePoint(event.clientX, event.clientY), false)}
                onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible") ? candidate.id : null)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  pick(candidate, { x: (candidate.box.left + candidate.box.right) / 2, y: (candidate.box.top + candidate.box.bottom) / 2 }, true);
                }}
                onPointerLeave={() => setHover((current) => (current?.id === candidate.id ? null : current))}
                onPointerMove={(event) => hoverAt(candidate, event)}
                pointerEvents={drawing ? "none" : "all"}
                ref={(node) => {
                  if (node) pathRefs.current.set(candidate.id, node);
                  else pathRefs.current.delete(candidate.id);
                }}
                role="button"
                stroke={color ?? "#ffffff"}
                strokeLinejoin="round"
                strokeOpacity={lit ? 1 : dim ? 0.2 : color ? 0.9 : 0.35}
                strokeWidth={lit ? 3.5 : color ? 2 : 1.5}
                tabIndex={drawing ? -1 : 0}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {shownBox ? (
            <rect
              fill="#ffffff"
              fillOpacity={0.12}
              height={shownBox.bottom - shownBox.top}
              pointerEvents="none"
              stroke="#ffffff"
              strokeDasharray="6 4"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              width={shownBox.right - shownBox.left}
              x={shownBox.left}
              y={shownBox.top}
            />
          ) : null}
          {finding?.points.map((point, i) => <NotItMark key={i} point={point} />)}
          {sketch ? <SketchShape sketch={sketch} /> : null}
        </svg>

        {finding && !finding.box && !draft ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-[12px] text-white">{e.dragBox}</p>
        ) : finding?.answer && !finding.busy && finding.points.length < MAX_PROMPT_POINTS ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-[12px] text-white">{e.tapNotIt}</p>
        ) : drawable(sketch) ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-[12px] text-white">
            {sketch.points.length < 3 ? e.drawTap : e.drawClose}
          </p>
        ) : null}

        {hover ? (
          <HoverLabel
            phrase={hoverCandidate ? labelOf(hoverCandidate) : ""}
            style={{
              left: hover.x,
              top: hover.y,
              maxWidth: hover.maxWidth,
              transform: `translate(${hover.flipX ? `calc(-100% - ${LABEL_GAP}px)` : `${LABEL_GAP}px`}, ${hover.flipY ? `calc(-100% - ${LABEL_GAP}px)` : `${LABEL_GAP}px`})`,
            }}
            text={linesText(hover.id)}
          />
        ) : focusedCandidate ? (
          <HoverLabel
            phrase={labelOf(focusedCandidate)}
            style={{
              left: `${(((focusedCandidate.box.left + focusedCandidate.box.right) / 2 / state.width) * 100).toFixed(2)}%`,
              top: `${((focusedCandidate.box.top / state.height) * 100).toFixed(2)}%`,
              transform: "translate(-50%, calc(-100% - 6px))",
            }}
            text={linesText(focusedCandidate.id)}
          />
        ) : null}

        <div
          aria-hidden="true"
          className="pointer-events-none absolute size-px"
          ref={anchorRef}
          style={picked ? { left: `${picked.x}%`, top: `${picked.y}%` } : undefined}
        />
      </div>

      <PopoverPrimitive.Root
        // A new outline gets its own popover, so it hangs from the new spot.
        key={picked?.id ?? "none"}
        onOpenChange={(next, details) => {
          if (next) return;
          // Tapping another outline moves the list there rather than just closing it.
          const target = details.event?.target;
          if (details.reason === "outside-press" && target instanceof Element && target.closest("[data-candidate]")) return;
          setOpen(false);
        }}
        open={open && pickedCandidate !== undefined}
      >
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner anchor={anchorRef} className="isolate z-50" collisionPadding={8} side="bottom" sideOffset={10}>
            <PopoverPrimitive.Popup
              className="z-50 flex w-64 origin-(--transform-origin) flex-col rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
              finalFocus={() => {
                if (picked?.keyboard) pathRefs.current.get(picked.id)?.focus();
                return false;
              }}
            >
              {picked && pickedCandidate ? (
                <>
                  <PopoverPrimitive.Title className="truncate px-2 pt-1.5 pb-1 text-[12px] font-normal text-ink-3">{labelOf(pickedCandidate)}</PopoverPrimitive.Title>
                  <ul className="max-h-72 overflow-y-auto">
                    {picked.order.map((lineIndex) => {
                      const line = state.lines.find((l) => l.lineIndex === lineIndex);
                      if (!line) return null;
                      return (
                        <li key={lineIndex}>
                          <LineChoice
                            lineIndex={lineIndex}
                            located={regionOf.get(lineIndex)?.located ?? false}
                            name={line.name}
                            notLocated={e.notLocated}
                            on={pickedLines.includes(lineIndex)}
                            onClick={() => toggle(picked.id, lineIndex)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-1 border-t border-line pt-1">
                    <button
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink-2 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
                      disabled={pickedLines.length === 0}
                      onClick={() => clear(picked.id)}
                      type="button"
                    >
                      <X aria-hidden="true" className="size-3.5 shrink-0" />
                      {e.clear}
                    </button>
                    {pickedCandidate.source === "hand" ? (
                      // Only an outline on no line comes off, so no line's count changes under the member.
                      <button
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink-2 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
                        disabled={pickedLines.length > 0}
                        onClick={() => void removeOutline(picked.id)}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
                        {e.removeOutline}
                      </button>
                    ) : null}
                  </div>
                </>
              ) : null}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {/* Under the photo, not over it: the quote page's sticky section bar covers the top of the card. */}
      {/* On a phone the note takes its own row and the buttons wrap under it. */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-48 flex-1 text-[12px] text-ink-3 text-pretty">
          {state.editedAt
            ? state.editedBy
              ? e.editedBy(state.editedBy, editedAgo(state.editedAt, language))
              : e.edited(editedAgo(state.editedAt, language))
            : e.hint}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button disabled={drawing} onClick={() => startFind(null)} size="xs" type="button" variant="quiet">
            <Search aria-hidden="true" className="size-3.5" />
            {e.findInPhoto}
          </Button>
          <Button disabled={drawing} onClick={startSketch} size="xs" type="button" variant="quiet">
            <PenLine aria-hidden="true" className="size-3.5" />
            {e.draw}
          </Button>
          <Button disabled={closing || finding?.busy || sketch?.busy} onClick={done} size="sm" type="button" variant="primary">
            {closing ? <Spinner variant="saving" /> : null}
            {e.done}
          </Button>
        </div>
      </div>

      {finding ? (
        // Relative so its sr-only label is placed inside it: with no positioned box above it, the label
        // hangs off the document, which then scrolls and shifts the whole app shell.
        <form className="relative space-y-2 rounded-[10px] bg-inset p-3" onSubmit={find}>
          <p className="text-[12px] text-ink-2">{finding.lineIndex !== null ? e.findLine(nameOf.get(finding.lineIndex) ?? "") : e.findInPhoto}</p>
          {finding.answer ? (
            // A boxed answer is saved already: Done leaves it, a new box asks about something else.
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={finding.busy}
                onClick={() => {
                  setFinding(null);
                  setDraft(null);
                }}
                size="sm"
                type="button"
                variant="primary"
              >
                {e.done}
              </Button>
              <Button
                disabled={finding.busy}
                onClick={() => setFinding({ ...finding, box: null, points: [], answer: null, replace: null, message: undefined })}
                size="sm"
                type="button"
                variant="quiet"
              >
                {e.newBox}
              </Button>
              {finding.busy ? (
                <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <Spinner variant="loading" />
                  {e.finding}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="priced-find-phrase">
                {e.phrase}
              </label>
              <input
                className={cn(inputClass, "min-w-40 flex-1")}
                disabled={finding.busy}
                id="priced-find-phrase"
                onChange={(event) => setFinding({ ...finding, phrase: event.target.value, message: undefined })}
                placeholder={e.phrasePlaceholder}
                value={finding.phrase}
              />
              <NativeSelect
                aria-label={e.putOn}
                className="w-auto max-w-48"
                disabled={finding.busy}
                onChange={(event) => {
                  const lineIndex = event.target.value === "" ? null : Number(event.target.value);
                  const line = state.lines.find((l) => l.lineIndex === lineIndex);
                  setFinding({ ...finding, lineIndex, phrase: finding.phrase.trim() || !line ? finding.phrase : (line.phrase ?? "") });
                }}
                value={finding.lineIndex ?? ""}
              >
                <option value="">{e.noLine}</option>
                {state.lines.map((line) => (
                  <option key={line.lineIndex} value={line.lineIndex}>
                    {line.name}
                  </option>
                ))}
              </NativeSelect>
              <Button disabled={finding.busy || (!finding.phrase.trim() && !finding.box)} size="sm" type="submit" variant="primary">
                {finding.busy ? <Spinner variant="loading" /> : null}
                {finding.busy ? e.finding : e.find}
              </Button>
              <Button
                disabled={finding.busy}
                onClick={() => {
                  setFinding(null);
                  setDraft(null);
                }}
                size="sm"
                type="button"
                variant="quiet"
              >
                {e.cancel}
              </Button>
            </div>
          )}
          {finding.message ? (
            <p className="text-[12px] text-ink-2" role="status">
              {finding.message}
            </p>
          ) : null}
          {finding.answer ? (
            // Each ask is one SAM call, billed like any other.
            <p className="text-[12px] text-ink-3">{finding.points.length < MAX_PROMPT_POINTS ? e.notThis(MAX_PROMPT_POINTS - finding.points.length) : e.noMoreTaps}</p>
          ) : finding.message ? null : !finding.box ? (
            <p className="text-[12px] text-ink-3">{e.dragBox}</p>
          ) : !finding.phrase.trim() ? (
            <p className="text-[12px] text-ink-3">{e.boxOnly}</p>
          ) : null}
        </form>
      ) : null}

      {sketch ? (
        <div className="space-y-2 rounded-[10px] bg-inset p-3">
          <p className="text-[12px] text-ink-2">{sketch.closed ? e.drawPutOn : e.drawHint}</p>
          {sketch.closed ? (
            <ul aria-label={e.drawPutOn}>
              {state.lines.map((line) => (
                <li key={line.lineIndex}>
                  <LineChoice
                    disabled={sketch.busy}
                    lineIndex={line.lineIndex}
                    located={regionOf.get(line.lineIndex)?.located ?? false}
                    name={line.name}
                    notLocated={e.notLocated}
                    onClick={() => void saveSketch(line.lineIndex)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {sketch.closed ? (
              <Button disabled={sketch.busy} onClick={() => void saveSketch(null)} size="sm" type="button" variant="secondary">
                {e.keepNoLine}
              </Button>
            ) : (
              <Button disabled={sketch.points.length < 3} onClick={() => setSketch({ ...sketch, at: null, closed: true, message: undefined })} size="sm" type="button" variant="primary">
                {e.closeOutline}
              </Button>
            )}
            <Button disabled={sketch.busy || sketch.points.length === 0} onClick={stepBack} size="sm" type="button" variant="quiet">
              <Undo2 aria-hidden="true" className="size-3.5" />
              {e.undo}
            </Button>
            <Button disabled={sketch.busy} onClick={() => setSketch(null)} size="sm" type="button" variant="quiet">
              {e.cancel}
            </Button>
            {sketch.busy ? (
              <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                <Spinner variant="saving" />
                {e.saving}
              </span>
            ) : null}
          </div>
          {sketch.message ? (
            <p className="text-[12px] text-ink-2" role="status">
              {sketch.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <ErrorLine>{error}</ErrorLine>
      {notice ? (
        <p className="text-[13px] text-ink-2" role="status">
          {notice}
        </p>
      ) : null}

      <ul aria-label={e.lines} className="divide-y divide-line">
        {state.lines.map((line) => {
          const located = regionOf.get(line.lineIndex)?.located ?? false;
          const on = highlight === line.lineIndex;
          return (
            <li className="flex items-center gap-2 py-1" key={line.lineIndex}>
              <button
                aria-pressed={on}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-hover aria-pressed:bg-hover"
                onClick={() => setHighlight(on ? null : line.lineIndex)}
                type="button"
              >
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(line.lineIndex) }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{line.name}</span>
                  <span className="block text-[12px] text-ink-3">
                    {quantity(line.quantity)}
                    {line.unitLabel ? ` ${pluralUnit(line.quantity, line.unitLabel, language)}` : ""}
                    {located ? "" : ` · ${e.notLocated}`}
                  </span>
                </span>
                {line.totalCents !== null ? <span className="shrink-0 tabular-nums text-ink">{money(line.totalCents, language)}</span> : null}
              </button>
              {!located ? (
                <Button className="max-w-40 shrink-0" disabled={drawing} onClick={() => startFind(line.lineIndex)} size="xs" type="button" variant="ghost">
                  <Search aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">{e.findLine(line.name)}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One of the quote's lines to put an outline on: its color, its name, and a check when the outline is on it. */
function LineChoice({
  lineIndex,
  name,
  located,
  notLocated,
  on,
  disabled,
  onClick,
}: {
  lineIndex: number;
  name: string;
  located: boolean;
  notLocated: string;
  /** On or off for a toggle; left out for a one-time choice. */
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={on}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(lineIndex) }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        {!located ? <span className="block text-[11px] text-ink-3">{notLocated}</span> : null}
      </span>
      {on !== undefined ? <Check aria-hidden="true" className={cn("size-4 shrink-0 text-accent", on ? "opacity-100" : "opacity-0")} /> : null}
    </button>
  );
}

/**
 * The outline being drawn: dark under white so it reads on grass and on sky, dashed until it's closed,
 * with a dot on each point and a larger one on the first once tapping it would close the outline.
 */
function SketchShape({ sketch }: { sketch: Sketch }) {
  const d = sketchPath(sketch.points, sketch.at, sketch.closed);
  const closable = !sketch.closed && sketch.points.length >= 3;
  return (
    <g pointerEvents="none">
      {d ? (
        <>
          <path d={d} fill="#ffffff" fillOpacity={sketch.closed ? 0.25 : 0.1} stroke="#000000" strokeLinejoin="round" strokeOpacity={0.5} strokeWidth={4} vectorEffect="non-scaling-stroke" />
          <path d={d} fill="none" stroke="#ffffff" strokeDasharray={sketch.closed ? undefined : "6 4"} strokeLinejoin="round" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </>
      ) : null}
      {sketch.points.map((point, i) => {
        const big = i === 0 && closable;
        // A zero-length line with round caps: a dot the same size on screen however the photo is scaled.
        const dot = `M${point.x} ${point.y}h0`;
        return (
          <g key={i}>
            <path d={dot} stroke="#000000" strokeLinecap="round" strokeOpacity={0.5} strokeWidth={big ? 18 : 10} vectorEffect="non-scaling-stroke" />
            <path d={dot} stroke={big ? "#ff9f0a" : "#ffffff"} strokeLinecap="round" strokeWidth={big ? 14 : 7} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </g>
  );
}

/** A tap off a boxed answer: a red dot, dark-ringed so it reads on grass and on sky, the same size however the photo is scaled. */
function NotItMark({ point }: { point: Point }) {
  const dot = `M${point.x} ${point.y}h0`;
  return (
    <g pointerEvents="none">
      <path d={dot} stroke="#000000" strokeLinecap="round" strokeOpacity={0.5} strokeWidth={16} vectorEffect="non-scaling-stroke" />
      <path d={dot} stroke="#ff3b30" strokeLinecap="round" strokeWidth={12} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/**
 * Its own width, not what's left of the photo past its left edge, so near the right edge it doesn't
 * squeeze into a column. Spans, not paragraphs: the kit's `p { text-wrap: pretty }` is outside any layer
 * and would undo `truncate`.
 */
function HoverLabel({ text, phrase, style }: { text: string; phrase: string; style: CSSProperties }) {
  return (
    <div className="pointer-events-none absolute z-10 w-max max-w-56 rounded-md bg-black/80 px-2 py-1 text-[12px] leading-snug whitespace-nowrap text-white shadow-md" style={style}>
      <span className="block truncate font-medium">{text}</span>
      {phrase ? <span className="block truncate text-white/70">{phrase}</span> : null}
    </div>
  );
}
