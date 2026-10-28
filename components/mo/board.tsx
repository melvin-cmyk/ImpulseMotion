"use client";

/**
 * The infinite board of Mo: pan with the wheel or by dragging the background,
 * zoom with ctrl/⌘ + wheel, a two-finger pinch or the buttons; cards are
 * dragged by their header (useCardDrag). Coordinates: world units = CSS px at
 * zoom 1; the view is a translate + scale.
 *
 * Gestures write the transform straight to the DOM and commit to React state
 * once per frame (wheel) or at the end (pan), so a board of thirty cards stays
 * smooth.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type ReactNode } from "react";
import { fitView, type Rect } from "@/lib/mo/geometry";

export interface View { x: number; y: number; k: number }
export interface BoardHandle {
  /** Fit the given rectangles (world) in the viewport; k clamped to [kMin, kMax]. */
  fit(rects: Rect[], padding?: number, opts?: { kMin?: number; kMax?: number }): void;
  /** Centre the viewport on a rectangle (world). */
  focus(rect: Rect): void;
  getView(): View;
  zoomBy(factor: number): void;
}

const MIN_K = 0.2, MAX_K = 2.2;
const DRAG_THRESHOLD = 4;

interface Props {
  children: ReactNode;
  /** Something drawn in world space under the cards (links). */
  underlay?: ReactNode;
  /** Something drawn in world space over the cards (alignment guides). */
  overlay?: ReactNode;
  onViewChange?: (v: View) => void;
  /** A click (no drag) on the empty background. */
  onBackgroundClick?: () => void;
  className?: string;
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export const Board = forwardRef<BoardHandle, Props>(function Board({ children, underlay, overlay, onViewChange, onBackgroundClick, className }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 120, y: 120, k: 1 });
  const viewRef = useRef(view);
  const anim = useRef<number>(0);
  const commitRaf = useRef<number>(0);
  /** Active pointers on the background (one = pan, two = pinch). */
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<{ kind: "pan" | "pinch"; moved: boolean; sx: number; sy: number; ox: number; oy: number; dist?: number; k0?: number; mx?: number; my?: number } | null>(null);

  /** Writes the view to the DOM now; commits to React state now or at the next frame. */
  const applyView = useCallback((v: View, commit: "now" | "frame" | "none") => {
    viewRef.current = v;
    if (layer.current) layer.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    if (commit === "now") { cancelAnimationFrame(commitRaf.current); setView(v); }
    else if (commit === "frame" && !commitRaf.current) commitRaf.current = requestAnimationFrame(() => { commitRaf.current = 0; setView(viewRef.current); });
  }, []);

  const setViewAnimated = useCallback((target: View) => {
    cancelAnimationFrame(anim.current);
    if (prefersReducedMotion()) { applyView(target, "now"); return; }
    const from = { ...viewRef.current };
    const t0 = performance.now();
    const dur = 420;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      applyView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e }, p < 1 ? "none" : "now");
      if (p < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [applyView]);

  const zoomAround = useCallback((k: number, px: number, py: number, animate: boolean) => {
    const v = viewRef.current;
    const kk = Math.min(MAX_K, Math.max(MIN_K, k));
    const next = { k: kk, x: px - (px - v.x) * (kk / v.k), y: py - (py - v.y) * (kk / v.k) };
    if (animate) setViewAnimated(next); else applyView(next, "frame");
  }, [applyView, setViewAnimated]);

  useImperativeHandle(ref, () => ({
    fit(rects, padding = 80, opts) {
      const host = el.current; if (!host) return;
      const v = fitView(rects, host.clientWidth, host.clientHeight, padding, opts?.kMin ?? MIN_K, opts?.kMax ?? 1);
      if (v) setViewAnimated(v);
    },
    focus(rect) {
      const host = el.current; if (!host) return;
      const v = fitView([rect], host.clientWidth, host.clientHeight, 100, MIN_K, 1);
      if (v) setViewAnimated({ ...v, y: v.y - 20 });
    },
    getView: () => viewRef.current,
    zoomBy(f) { const host = el.current; if (!host) return; zoomAround(viewRef.current.k * f, host.clientWidth / 2, host.clientHeight / 2, true); },
  }), [setViewAnimated, zoomAround]);

  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);
  useEffect(() => () => { cancelAnimationFrame(anim.current); cancelAnimationFrame(commitRaf.current); }, []);

  // Wheel: pan (shift = horizontal), or zoom around the pointer with ctrl/⌘ (trackpad pinch sends ctrlKey).
  useEffect(() => {
    const host = el.current; if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      // deltaMode 1 = lines (Firefox), 2 = pages.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = host.getBoundingClientRect();
        zoomAround(v.k * Math.exp(-dy * 0.0022), e.clientX - rect.left, e.clientY - rect.top, false);
      } else if (e.shiftKey && !dx) {
        applyView({ ...v, x: v.x - dy }, "frame");
      } else {
        applyView({ ...v, x: v.x - dx, y: v.y - dy }, "frame");
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [applyView, zoomAround]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("[data-card], button, a, input, select, textarea")) return;
    cancelAnimationFrame(anim.current);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const v = viewRef.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", moved: true, sx: 0, sy: 0, ox: v.x, oy: v.y, dist: Math.hypot(a.x - b.x, a.y - b.y), k0: v.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    } else {
      gesture.current = { kind: "pan", moved: false, sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current; if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const host = el.current; if (!host) return;
      const rect = host.getBoundingClientRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const k = Math.min(MAX_K, Math.max(MIN_K, (g.k0 ?? 1) * (dist / Math.max(1, g.dist ?? 1))));
      const mx = (a.x + b.x) / 2 - rect.left, my = (a.y + b.y) / 2 - rect.top;
      // Zoom around the start midpoint, then follow the midpoint's travel.
      const px = (g.mx ?? 0) - rect.left, py = (g.my ?? 0) - rect.top;
      const x = px - (px - g.ox) * (k / (g.k0 ?? 1)) + (mx - px);
      const y = py - (py - g.oy) * (k / (g.k0 ?? 1)) + (my - py);
      applyView({ x, y, k }, "none");
      return;
    }
    if (g.kind === "pan") {
      const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      applyView({ ...viewRef.current, x: g.ox + dx, y: g.oy + dy }, "none");
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (pointers.current.size === 0) {
      gesture.current = null;
      if (!g.moved) onBackgroundClick?.();
      applyView(viewRef.current, "now");
    } else if (g.kind === "pinch") {
      // One finger left: continue as a pan from here.
      const [p] = [...pointers.current.values()];
      gesture.current = { kind: "pan", moved: true, sx: p.x, sy: p.y, ox: viewRef.current.x, oy: viewRef.current.y };
    }
  };

  return (
    <div ref={el} className={`relative overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing ${className ?? ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div ref={layer} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {underlay}
        {children}
        {overlay}
      </div>
      <div className="absolute bottom-5 right-5 flex items-center gap-1 rounded-full border border-white/10 bg-black/50 backdrop-blur px-1.5 py-1 text-xs text-gray-300">
        <button type="button" onClick={() => { const host = el.current; if (host) zoomAround(viewRef.current.k / 1.25, host.clientWidth / 2, host.clientHeight / 2, true); }} className="w-7 h-7 rounded-full hover:bg-white/10" aria-label="Zoom arrière">−</button>
        <span className="tabular-nums w-11 text-center">{Math.round(view.k * 100)} %</span>
        <button type="button" onClick={() => { const host = el.current; if (host) zoomAround(viewRef.current.k * 1.25, host.clientWidth / 2, host.clientHeight / 2, true); }} className="w-7 h-7 rounded-full hover:bg-white/10" aria-label="Zoom avant">+</button>
      </div>
    </div>
  );
});

/**
 * Drag by a handle: world deltas (scaled by the view) once the pointer moved
 * 4 px; a plain click never calls onMove. onEnd says whether it moved.
 */
export function useCardDrag(
  getK: () => number,
  onMove: (dx: number, dy: number, e: React.PointerEvent) => void,
  onEnd?: (moved: boolean) => void,
  onStart?: (e: React.PointerEvent) => void,
) {
  const d = useRef<{ id: number; sx: number; sy: number; lx: number; ly: number; moving: boolean } | null>(null);
  const finish = (e: React.PointerEvent) => {
    const c = d.current; if (!c || c.id !== e.pointerId) return;
    d.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    onEnd?.(c.moving);
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
      e.stopPropagation();
      d.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moving: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const c = d.current; if (!c || c.id !== e.pointerId) return;
      if (!c.moving) {
        if (Math.hypot(e.clientX - c.sx, e.clientY - c.sy) < DRAG_THRESHOLD) return;
        c.moving = true;
        onStart?.(e);
      }
      const k = getK() || 1;
      onMove((e.clientX - c.lx) / k, (e.clientY - c.ly) / k, e);
      c.lx = e.clientX; c.ly = e.clientY;
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: (e: React.PointerEvent) => { if (d.current?.id === e.pointerId) finish(e); },
  };
}
