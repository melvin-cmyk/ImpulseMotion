"use client";

/**
 * The infinite board of Mo: pan with the wheel or by dragging the background,
 * zoom with ctrl/⌘ + wheel (or the buttons), cards dragged by their header.
 * Coordinates: world units = CSS px at zoom 1; the view is a translate + scale.
 */

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type ReactNode } from "react";

export interface View { x: number; y: number; k: number }
export interface BoardHandle {
  /** Fit the given rectangles (world) in the viewport. */
  fit(rects: Array<{ x: number; y: number; w: number; h: number }>, padding?: number): void;
  /** Centre the viewport on a rectangle (world). */
  focus(rect: { x: number; y: number; w: number; h: number }): void;
  getView(): View;
}

const MIN_K = 0.2, MAX_K = 2.2;

interface Props {
  children: ReactNode;
  /** Something drawn in world space under the cards (links). */
  underlay?: ReactNode;
  onViewChange?: (v: View) => void;
  className?: string;
}

export const Board = forwardRef<BoardHandle, Props>(function Board({ children, underlay, onViewChange, className }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 120, y: 120, k: 1 });
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const anim = useRef<number>(0);
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);

  const setViewAnimated = useCallback((target: View) => {
    cancelAnimationFrame(anim.current);
    const from = { ...viewRef.current };
    const t0 = performance.now();
    const dur = 420;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      setView(v);
      if (p < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);

  useImperativeHandle(ref, () => ({
    fit(rects, padding = 80) {
      const host = el.current; if (!host || !rects.length) return;
      const minX = Math.min(...rects.map((r) => r.x)), minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.w)), maxY = Math.max(...rects.map((r) => r.y + r.h));
      const W = host.clientWidth, H = host.clientHeight;
      const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((W - padding * 2) / (maxX - minX), (H - padding * 2) / (maxY - minY), 1)));
      setViewAnimated({ k, x: (W - (maxX - minX) * k) / 2 - minX * k, y: (H - (maxY - minY) * k) / 2 - minY * k });
    },
    focus(rect) {
      const host = el.current; if (!host) return;
      const W = host.clientWidth, H = host.clientHeight;
      const k = Math.min(1, Math.max(MIN_K, Math.min((W - 160) / rect.w, (H - 200) / rect.h, 1)));
      setViewAnimated({ k, x: (W - rect.w * k) / 2 - rect.x * k, y: (H - rect.h * k) / 2 - rect.y * k - 20 });
    },
    getView: () => viewRef.current,
  }), [setViewAnimated]);

  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);

  // Wheel: pan, or zoom around the pointer with ctrl/⌘ (trackpad pinch sends ctrlKey).
  useEffect(() => {
    const host = el.current; if (!host) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(anim.current);
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = host.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.0022)));
        setView({ k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) });
      } else {
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest("[data-card]")) return;
    cancelAnimationFrame(anim.current);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
  };
  const onPointerUp = (e: React.PointerEvent) => { if (drag.current?.id === e.pointerId) drag.current = null; };

  const zoomBy = (f: number) => {
    const host = el.current; if (!host) return;
    const v = viewRef.current;
    const px = host.clientWidth / 2, py = host.clientHeight / 2;
    const k = Math.min(MAX_K, Math.max(MIN_K, v.k * f));
    setViewAnimated({ k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) });
  };

  return (
    <div ref={el} className={`relative overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing ${className ?? ""}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {underlay}
        {children}
      </div>
      <div className="absolute bottom-5 right-5 flex items-center gap-1 rounded-full border border-white/10 bg-black/50 backdrop-blur px-1.5 py-1 text-xs text-gray-300">
        <button type="button" onClick={() => zoomBy(1 / 1.25)} className="w-7 h-7 rounded-full hover:bg-white/10" aria-label="Zoom arrière">−</button>
        <span className="tabular-nums w-11 text-center">{Math.round(view.k * 100)} %</span>
        <button type="button" onClick={() => zoomBy(1.25)} className="w-7 h-7 rounded-full hover:bg-white/10" aria-label="Zoom avant">+</button>
      </div>
    </div>
  );
});

/** Drag by a handle: calls onMove with world deltas (scaled by the view). */
export function useCardDrag(getK: () => number, onMove: (dx: number, dy: number) => void, onEnd?: () => void) {
  const d = useRef<{ id: number; lx: number; ly: number } | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
      e.stopPropagation();
      d.current = { id: e.pointerId, lx: e.clientX, ly: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const c = d.current; if (!c || c.id !== e.pointerId) return;
      const k = getK() || 1;
      onMove((e.clientX - c.lx) / k, (e.clientY - c.ly) / k);
      c.lx = e.clientX; c.ly = e.clientY;
    },
    onPointerUp: (e: React.PointerEvent) => { if (d.current?.id === e.pointerId) { d.current = null; onEnd?.(); } },
  };
}
