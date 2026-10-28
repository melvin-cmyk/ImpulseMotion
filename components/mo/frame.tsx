"use client";

/**
 * A client frame on Mo's board: a named, tinted zone drawn behind the cards
 * of one client. Dragged by its header (the page moves its cards along),
 * resized by its edges, folded with the chevron (its cards hide), right-click
 * or « ⋯ » for the menu (« Détacher en page », fold, remove). A dashed ghost
 * variant marks the frame about to be created while a quick answer runs.
 */

import { memo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, MoreHorizontal } from "lucide-react";
import type { MoFrame } from "@/lib/mo/frames";
import { FRAME_FOLDED_H } from "@/lib/mo/frames";
import type { HandleDir, Rect } from "@/lib/mo/geometry";
import { useCardDrag } from "@/components/mo/board";
import { HANDLES, Handle, applyRect } from "@/components/mo/card";

export interface MoFrameViewProps {
  frame: MoFrame;
  /** Number of cards inside (shown in the header). */
  count: number;
  selected: boolean;
  getK: () => number;
  onMove: (id: string, dx: number, dy: number, alt: boolean) => { x: number; y: number };
  onMoveEnd: (id: string, moved: boolean) => void;
  onResizeStart: (id: string) => void;
  onResize: (id: string, dir: HandleDir, dx: number, dy: number, alt: boolean) => Rect;
  onResizeEnd: (id: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onToggle: (id: string) => void;
  /** The menu asked for (right-click or ⋯), with the screen point. */
  onMenu: (id: string, x: number, y: number) => void;
  /** Double-click on the name: open / create the client's page. */
  onOpenPage?: (id: string) => void;
}

/** rgba of a hex colour with the given alpha. */
export function tint(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(167,139,250,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

export const MoFrameView = memo(function MoFrameView({ frame, count, selected, getK, onMove, onMoveEnd, onResizeStart, onResize, onResizeEnd, onSelect, onToggle, onMenu, onOpenPage }: MoFrameViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const [liveH, setLiveH] = useState<number | null>(null);
  const folded = !!frame.minimized;
  const h = folded ? FRAME_FOLDED_H : liveH ?? frame.h ?? 320;
  const drag = useCardDrag(getK, (dx, dy, e) => applyRect(el.current, onMove(frame.id, dx, dy, e.altKey)), (moved) => onMoveEnd(frame.id, moved));
  return (
    <div
      ref={el}
      data-frame
      data-card-id={frame.id}
      data-client-id={frame.clientId}
      data-folded={folded ? "1" : undefined}
      className={`absolute left-0 top-0 rounded-3xl border-2 ${selected ? "ring-2 ring-offset-0" : ""}`}
      style={{ transform: `translate(${frame.x}px, ${frame.y}px)`, width: frame.w, height: h, zIndex: 0, borderColor: tint(frame.color, selected ? 0.9 : 0.45), background: `linear-gradient(180deg, ${tint(frame.color, 0.1)} 0%, ${tint(frame.color, 0.04)} 100%)`, ["--tw-ring-color" as string]: tint(frame.color, 0.35) }}
      onPointerDownCapture={(e) => { if (e.button === 0 && (e.target as HTMLElement).closest("[data-frame-header]")) onSelect(frame.id, e.shiftKey); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(frame.id, e.clientX, e.clientY); }}
    >
      <div data-frame-header className="flex items-center gap-2 h-11 px-4 cursor-grab active:cursor-grabbing select-none touch-none" {...drag}>
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: frame.color, boxShadow: `0 0 12px ${tint(frame.color, 0.8)}` }} />
        {/* A span, not a button: the whole header drags the frame; a double-click on the name opens the client's page. */}
        <span data-frame-name onDoubleClick={() => onOpenPage?.(frame.id)} className="text-[13px] font-semibold tracking-tight truncate" style={{ color: tint(frame.color, 1) }} title={`${frame.clientName} · double-clic : ouvrir sa page`}>{frame.clientName}</span>
        <span className="text-[11px] text-gray-400 tabular-nums shrink-0">{count} carte{count > 1 ? "s" : ""}</span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button type="button" onClick={() => onToggle(frame.id)} className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10" aria-label={folded ? "Déplier le cadre" : "Replier le cadre"}>{folded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}</button>
          <button type="button" data-frame-menu onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(frame.id, r.left, r.bottom + 4); }} className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10" aria-label="Menu du cadre"><MoreHorizontal className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      {!folded && HANDLES.map((hd) => (
        <Handle key={hd.dir} {...hd} cardId={frame.id} getK={getK}
          onStart={() => onResizeStart(frame.id)}
          onResize={(dir, dx, dy, alt) => { const r = onResize(frame.id, dir, dx, dy, alt); applyRect(el.current, r); setLiveH(r.h); }}
          onEnd={() => { setLiveH(null); onResizeEnd(frame.id); }} />
      ))}
    </div>
  );
});

/** The dashed outline of the frame a quick answer is about to open (same place as the real one). */
export function MoGhostFrame({ rect, name, color }: { rect: Rect; name: string; color: string }) {
  return (
    <div data-ghost-frame className="absolute left-0 top-0 rounded-3xl border-2 border-dashed pointer-events-none mo-ghost" style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h, zIndex: 0, borderColor: tint(color, 0.5), background: tint(color, 0.05) }}>
      <div className="flex items-center gap-2 h-11 px-4"><span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} /><span className="text-[13px] font-semibold" style={{ color: tint(color, 1) }}>{name}</span></div>
    </div>
  );
}
