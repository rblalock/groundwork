"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LoadingState, Spinner } from "@/components/spinner";
import type { Language } from "@/core/language";
import { pluralUnit } from "@/core/units";
import { money, quantity } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import {
  applyAssignment,
  assignmentsOf,
  editedAgo,
  pricedPhotoApi,
  type PricedBox,
  type PricedCandidate,
  type PricedPhotoApi,
  type PricedPhotoEditorState,
  type PricedRegion,
} from "@/lib/priced-photo-editor";
import { Button } from "@/ui/beautiful/atoms/Button";
import { cn } from "@/ui/lib/utils";
import { ErrorLine, inputClass, NativeSelect } from "../pages/client-kit";

// Editing a quote's priced photo by hand (lib/priced-photo-editor.ts). Everything SAM found in the photo
// is outlined over it; tapping an outline lists the quote's lines to put it on, and a box dragged on the
// photo asks SAM to look again there for something it missed. Each change saves the whole set, and the
// server draws the priced PNG again from it.

/** One color per line, in line order: the same ones the priced PNG draws with (core/priced-photo.ts). */
const PALETTE = ["#ff9f0a", "#0a84ff", "#ff375f", "#bf5af2", "#ffd60a", "#64d2ff", "#ff3b30", "#30d158"];
const colorOf = (lineIndex: number) => PALETTE[lineIndex % PALETTE.length];

/** A tap, not a drag, makes a box this share of the photo's width around where it landed. */
const TAP_BOX = 0.15;

type Point = { x: number; y: number };
type Hover = { id: string; x: number; y: number; flipX: boolean; flipY: boolean };
/** The outline whose lines are showing, where its list hangs (in % of the photo), and the lines' order when it opened. */
type Picked = { id: string; x: number; y: number; order: number[]; keyboard: boolean };
type Finding = { lineIndex: number | null; phrase: string; box: PricedBox | null; busy: boolean; message?: string };

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

  const drawing = finding !== null;
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

  function hoverAt(candidate: PricedCandidate, event: ReactPointerEvent) {
    if (event.pointerType === "touch" || open) return;
    const rect = stageRef.current!.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setHover({ id: candidate.id, x, y, flipX: x > rect.width * 0.6, flipY: y > rect.height * 0.75 });
  }

  function startFind(lineIndex: number | null) {
    const line = lineIndex === null ? undefined : state?.lines.find((l) => l.lineIndex === lineIndex);
    setOpen(false);
    setNotice(undefined);
    setError(undefined);
    setDraft(null);
    setFinding({ lineIndex, phrase: line ? (line.phrase ?? line.name) : "", box: null, busy: false });
  }

  function drawStart(event: ReactPointerEvent<SVGSVGElement>) {
    if (!finding || finding.busy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
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

  function drawEnd() {
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
    if (!finding || !finding.phrase.trim()) return;
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

  async function done() {
    setClosing(true);
    await inflight.current;
    onClose(confirmed.current);
  }

  const pickedCandidate = picked ? state.candidates.find((c) => c.id === picked.id) : undefined;
  const pickedLines = picked ? (onLines.get(picked.id) ?? []) : [];
  const shownBox = draft?.box ?? finding?.box ?? null;
  const focusedCandidate = !hover && !open && focused ? state.candidates.find((c) => c.id === focused) : undefined;

  return (
    <div className="space-y-3">
      <div
        // While a box is drawn, a drag never selects text and a touch never scrolls the page.
        className={cn("relative w-full overflow-hidden rounded-[8px] bg-inset shadow-hairline", drawing && "touch-none select-none")}
        ref={stageRef}
        style={{ aspectRatio: `${state.width} / ${state.height}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
        <img alt={e.photoAlt} className="absolute inset-0 size-full select-none" draggable={false} src={state.photoUrl} />
        <svg
          className={cn("absolute inset-0 size-full", drawing && !finding?.busy && "cursor-crosshair")}
          onPointerCancel={() => setDraft(null)}
          onPointerDown={drawing ? drawStart : undefined}
          onPointerMove={drawing ? drawMove : undefined}
          onPointerUp={drawing ? drawEnd : undefined}
          preserveAspectRatio="none"
          ref={svgRef}
          viewBox={`0 0 ${state.width} ${state.height}`}
        >
          {drawn.map((candidate) => {
            const lines = onLines.get(candidate.id) ?? [];
            const color = lines.length ? colorOf(lines[0]) : null;
            const expanded = open && picked?.id === candidate.id;
            const lit = hover?.id === candidate.id || focused === candidate.id || expanded || (highlight !== null && lines.includes(highlight));
            const dim = (highlight !== null && !lines.includes(highlight)) || drawing;
            return (
              <path
                aria-expanded={expanded}
                aria-haspopup="dialog"
                aria-label={`${candidate.phrase}: ${linesText(candidate.id)}`}
                className="cursor-pointer outline-none transition-[stroke-opacity,fill-opacity,stroke-width] duration-150"
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
                onPointerEnter={(event) => hoverAt(candidate, event)}
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
        </svg>

        {drawing && !finding.box && !draft ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-[12px] text-white">{e.dragBox}</p>
        ) : null}

        {hover ? (
          <HoverLabel
            phrase={state.candidates.find((c) => c.id === hover.id)?.phrase ?? ""}
            style={{
              left: hover.x,
              top: hover.y,
              transform: `translate(${hover.flipX ? "calc(-100% - 12px)" : "12px"}, ${hover.flipY ? "calc(-100% - 12px)" : "12px"})`,
            }}
            text={linesText(hover.id)}
          />
        ) : focusedCandidate ? (
          <HoverLabel
            phrase={focusedCandidate.phrase}
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
                  <PopoverPrimitive.Title className="truncate px-2 pt-1.5 pb-1 text-[12px] font-normal text-ink-3">{pickedCandidate.phrase}</PopoverPrimitive.Title>
                  <ul className="max-h-72 overflow-y-auto">
                    {picked.order.map((lineIndex) => {
                      const line = state.lines.find((l) => l.lineIndex === lineIndex);
                      if (!line) return null;
                      const on = pickedLines.includes(lineIndex);
                      const located = regionOf.get(lineIndex)?.located ?? false;
                      return (
                        <li key={lineIndex}>
                          <button
                            aria-pressed={on}
                            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                            onClick={() => toggle(picked.id, lineIndex)}
                            type="button"
                          >
                            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(lineIndex) }} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{line.name}</span>
                              {!located ? <span className="block text-[11px] text-ink-3">{e.notLocated}</span> : null}
                            </span>
                            <Check aria-hidden="true" className={cn("size-4 shrink-0 text-accent", on ? "opacity-100" : "opacity-0")} />
                          </button>
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
                  </div>
                </>
              ) : null}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {/* Under the photo, not over it: the quote page's sticky section bar covers the top of the card. */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[12px] text-ink-3 text-pretty">
          {state.editedAt
            ? state.editedBy
              ? e.editedBy(state.editedBy, editedAgo(state.editedAt, language))
              : e.edited(editedAgo(state.editedAt, language))
            : e.hint}
        </p>
        <Button disabled={drawing} onClick={() => startFind(null)} size="xs" type="button" variant="quiet">
          <Search aria-hidden="true" className="size-3.5" />
          {e.findInPhoto}
        </Button>
        <Button disabled={closing || finding?.busy} onClick={done} size="sm" type="button" variant="primary">
          {closing ? <Spinner variant="saving" /> : null}
          {e.done}
        </Button>
      </div>

      {finding ? (
        // Relative so its sr-only label is placed inside it: with no positioned box above it, the label
        // hangs off the document, which then scrolls and shifts the whole app shell.
        <form className="relative space-y-2 rounded-[10px] bg-inset p-3" onSubmit={find}>
          <p className="text-[12px] text-ink-2">{finding.lineIndex !== null ? e.findLine(nameOf.get(finding.lineIndex) ?? "") : e.findInPhoto}</p>
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
                setFinding({ ...finding, lineIndex, phrase: finding.phrase.trim() || !line ? finding.phrase : (line.phrase ?? line.name) });
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
            <Button disabled={finding.busy || !finding.phrase.trim()} size="sm" type="submit" variant="primary">
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
          {finding.message ? (
            <p className="text-[12px] text-ink-2" role="status">
              {finding.message}
            </p>
          ) : !finding.box ? (
            <p className="text-[12px] text-ink-3">{e.dragBox}</p>
          ) : null}
        </form>
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

function HoverLabel({ text, phrase, style }: { text: string; phrase: string; style: CSSProperties }) {
  return (
    <div className="pointer-events-none absolute z-10 max-w-56 rounded-md bg-black/80 px-2 py-1 text-[12px] leading-snug text-white shadow-md" style={style}>
      <p className="truncate font-medium">{text}</p>
      {phrase ? <p className="truncate text-white/70">{phrase}</p> : null}
    </div>
  );
}
