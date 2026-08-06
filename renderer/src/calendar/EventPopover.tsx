import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  blockTypeLabel, capacityCopy, fmtDur, fmtMin, guidanceFor, placePopover, sourceLabel,
  type Item, type PopoverPlacement,
} from "./shared.ts";

// The detail popover behind a click on a calendar card.
//
// Its job is not to restate the card — the card already shows the title and the
// time. Its job is to explain the blocks the OWNER never typed: the break after
// deep work, the two comms windows, the transitions bracketing a meeting
// cluster, the shutdown ritual. For those the doctrine has a reason, and the
// guidance paragraph (BLOCK_GUIDANCE in shared.ts) is that reason in plain
// words: what the block is for, and what to actually do in it.
//
// Mechanics: portaled to <body> and positioned `fixed` against the card's
// viewport rect, because the day grid is a scroll container that would otherwise
// clip it. Placement flips above/below and clamps to the viewport (see
// placePopover), and re-runs on scroll and resize so it stays glued to its card.
// Closes on Escape, on click outside, and whenever its card leaves the DOM.

const WIDTH = 300;

export default function EventPopover({ item, anchorRef, task, onClose }: {
  item: Item;
  /** The card element this popover hangs off — read at layout time, never cached. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Resolved from the day's task list when the block has a task_id. */
  task: { title: string; status: string } | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<PopoverPlacement | null>(null);

  const reposition = useCallback(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    setPlace(
      placePopover(
        { top: a.top, left: a.left, width: a.width, height: a.height },
        { width: el.offsetWidth || WIDTH, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [anchorRef]);

  // Measure + place before paint so the popover never flashes at 0,0.
  useLayoutEffect(reposition, [reposition, item.key]);

  useEffect(() => {
    // `true` = capture, so the day grid's own scrolling reaches us too.
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [reposition]);

  // Escape hands focus back to the card it came from; a click elsewhere does not
  // (the owner is already looking at whatever they clicked).
  const returnFocus = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); returnFocus.current = true; onClose(); }
    };
    // mousedown (not click) so the card's own click handler cannot re-open it.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [anchorRef, onClose]);

  // Move focus in so screen readers land here, and give it back on Escape.
  useEffect(() => {
    ref.current?.focus();
    const anchor = anchorRef;
    return () => { if (returnFocus.current) anchor.current?.focus(); };
  }, [anchorRef]);

  const g = guidanceFor(item.type);
  const dur = item.endMin - item.startMin;
  const capacity = capacityCopy(item.capacityScore);
  const source = sourceLabel(item);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${item.title} details`}
      tabIndex={-1}
      className="no-drag rounded-2xl border outline-none"
      style={{
        position: "fixed",
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        width: WIDTH,
        maxWidth: "calc(100vw - 16px)",
        zIndex: 90,
        padding: "11px 13px 12px",
        borderColor: "color-mix(in srgb, var(--line) 85%, transparent)",
        background: "color-mix(in srgb, var(--panel) 45%, white)",
        boxShadow: "0 10px 30px rgba(91,70,54,0.16), 0 2px 6px rgba(91,70,54,0.08)",
        color: "var(--ink)",
        userSelect: "text", // body sets none — the guidance is worth being able to copy
        opacity: place ? 1 : 0, // hidden for the single frame before measurement
        transition: "opacity 120ms ease-out",
      }}
    >
      <div className="font-display text-[13px] font-semibold leading-snug">{item.title}</div>

      <div className="mt-0.5 text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>
        {fmtMin(item.startMin)} – {fmtMin(item.endMin)} · {fmtDur(dur)}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Pill>{blockTypeLabel(item.type)}</Pill>
        <Pill>{source}</Pill>
      </div>

      {capacity && (
        <div className="mt-1.5 text-[11px] tabular-nums" style={{ color: "var(--muted)" }}>{capacity}</div>
      )}

      {task && (
        <div className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
          Task: <span style={{ color: "var(--ink)" }}>{task.title}</span>
          {task.status && <> · {task.status.replace(/_/g, " ")}</>}
        </div>
      )}

      {item.anchor && (
        <div className="mt-1.5 text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
          The planner treated this as immovable and built the day around it.
        </div>
      )}

      <div
        className="mt-2.5 rounded-xl px-2.5 py-2"
        style={{
          background: "color-mix(in srgb, var(--wash) 75%, white)",
          border: "1px solid color-mix(in srgb, var(--line) 55%, transparent)",
        }}
      >
        <div className="text-[9px] font-medium uppercase tracking-wide" style={{ color: "var(--accent)", opacity: 0.9 }}>
          What this block is for
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: "var(--ink)" }}>{g.what}</p>
        <div className="mt-2 text-[9px] font-medium uppercase tracking-wide" style={{ color: "var(--accent)", opacity: 0.9 }}>
          How to use it
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>{g.how}</p>
      </div>
    </div>,
    document.body
  );
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-wide"
      style={{ background: "color-mix(in srgb, white 70%, transparent)", color: "var(--muted)", border: "1px solid var(--line)" }}
    >
      {children}
    </span>
  );
}
