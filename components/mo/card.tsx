"use client";

/**
 * One floating card of Mo's board, rendered by type: KPIs, table, chart,
 * creatives, note. Dragged by its header (snapped by the page), resized by
 * its edges and corners, brought to the front on pointer down, selectable;
 * folds, closes. A source footer says where the numbers come from.
 *
 * During a drag or a resize the card writes its own transform / size to the
 * DOM at once and the page commits the state a frame later.
 */

import { memo, useMemo, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, BarChart3, ChevronDown, ChevronUp, Image as ImageIcon, LayoutGrid, Link2, Minus, StickyNote, Table2, TrendingUp, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { CARD_SIZES, type MoCard } from "@/lib/mo/model";
import { MIN_HEADER_H, type HandleDir, type Rect } from "@/lib/mo/geometry";
import { useCardDrag } from "@/components/mo/board";

const SERIES_COLORS = ["#a78bfa", "#f0abfc", "#67e8f9", "#fde68a", "#86efac", "#fca5a5"];

const ICONS = { kpis: LayoutGrid, table: Table2, chart: TrendingUp, creatives: ImageIcon, note: StickyNote } as const;

export interface MoCardViewProps {
  card: MoCard;
  fresh: boolean;
  /** Entrance delay (ms) when fresh: staggers a turn's cards. */
  delayMs?: number;
  selected: boolean;
  refTitle: string | null;
  getK: () => number;
  /** Drag: incremental world deltas → the page answers with the (snapped) position to show. */
  onMove: (id: string, dx: number, dy: number, alt: boolean) => { x: number; y: number };
  onMoveEnd: (id: string, moved: boolean) => void;
  onResizeStart: (id: string) => void;
  /** Resize: cumulative world deltas from the handle's start → the page answers with the rect to show. */
  onResize: (id: string, dir: HandleDir, dx: number, dy: number, alt: boolean) => Rect;
  onResizeEnd: (id: string) => void;
  onFront: (id: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onToggle: (id: string) => void;
  onClose: (id: string) => void;
  onFocusRef: (id: string) => void;
  onHoverRef: (id: string | null) => void;
}

const HANDLES: Array<{ dir: HandleDir; cls: string; cursor: string }> = [
  { dir: "n", cls: "left-3 right-3 -top-1 h-2", cursor: "cursor-ns-resize" },
  { dir: "s", cls: "left-3 right-3 -bottom-1 h-2", cursor: "cursor-ns-resize" },
  { dir: "w", cls: "top-3 bottom-3 -left-1 w-2", cursor: "cursor-ew-resize" },
  { dir: "e", cls: "top-3 bottom-3 -right-1 w-2", cursor: "cursor-ew-resize" },
  { dir: "nw", cls: "-left-1.5 -top-1.5 w-3.5 h-3.5", cursor: "cursor-nwse-resize" },
  { dir: "se", cls: "-right-1.5 -bottom-1.5 w-3.5 h-3.5", cursor: "cursor-nwse-resize" },
  { dir: "ne", cls: "-right-1.5 -top-1.5 w-3.5 h-3.5", cursor: "cursor-nesw-resize" },
  { dir: "sw", cls: "-left-1.5 -bottom-1.5 w-3.5 h-3.5", cursor: "cursor-nesw-resize" },
];

function applyRect(el: HTMLDivElement | null, r: { x: number; y: number; w?: number; h?: number | null }) {
  if (!el) return;
  el.style.transform = `translate(${r.x}px, ${r.y}px)`;
  if (r.w !== undefined) el.style.width = `${r.w}px`;
  if (r.h !== undefined) el.style.height = r.h === null ? "" : `${r.h}px`;
}

function Handle({ dir, cls, cursor, cardId, getK, onStart, onResize, onEnd }: { dir: HandleDir; cls: string; cursor: string; cardId: string; getK: () => number; onStart: () => void; onResize: (dir: HandleDir, dx: number, dy: number, alt: boolean) => void; onEnd: () => void }) {
  const acc = useRef({ dx: 0, dy: 0 });
  const drag = useCardDrag(getK, (dx, dy, e) => { acc.current.dx += dx; acc.current.dy += dy; onResize(dir, acc.current.dx, acc.current.dy, e.altKey); }, (moved) => { if (moved) onEnd(); }, () => { acc.current = { dx: 0, dy: 0 }; onStart(); });
  return <div data-handle={dir} data-card-id={cardId} className={`absolute z-10 ${cls} ${cursor} touch-none`} {...drag} />;
}

export const MoCardView = memo(function MoCardView({ card, fresh, delayMs = 0, selected, refTitle, getK, onMove, onMoveEnd, onResizeStart, onResize, onResizeEnd, onFront, onSelect, onToggle, onClose, onFocusRef, onHoverRef }: MoCardViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const Icon = ICONS[card.type] ?? BarChart3;
  const h = card.minimized ? MIN_HEADER_H : card.h ?? CARD_SIZES[card.type].h;
  // Width shown to the body while a resize is in progress (the state follows a frame later).
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const width = liveWidth ?? card.w;

  const drag = useCardDrag(
    getK,
    (dx, dy, e) => applyRect(el.current, onMove(card.id, dx, dy, e.altKey)),
    (moved) => onMoveEnd(card.id, moved),
  );

  return (
    <div
      ref={el}
      data-card
      data-card-id={card.id}
      className={`absolute left-0 top-0 flex flex-col rounded-2xl border bg-[#100c1f] shadow-[0_20px_60px_-20px_rgba(124,58,237,0.45)] text-gray-100 cursor-default ${fresh ? "mo-card-in" : ""} ${selected ? "border-violet-400 ring-2 ring-violet-400/40" : fresh ? "border-violet-400/60" : "border-white/10"}`}
      style={{ transform: `translate(${card.x}px, ${card.y}px)`, width: card.w, height: h, zIndex: card.z ?? 0, animationDelay: fresh && delayMs ? `${delayMs}ms` : undefined }}
      onPointerDownCapture={(e) => { if (e.button === 0) { onFront(card.id); onSelect(card.id, e.shiftKey); } }}
    >
      <div className="flex items-start gap-2 px-3.5 pt-3 pb-2 cursor-grab active:cursor-grabbing border-b border-white/5 select-none touch-none" {...drag}>
        <span className="mt-0.5 inline-flex w-6 h-6 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300 shrink-0"><Icon className="w-3.5 h-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight truncate" title={card.title}>{card.title}</div>
          {card.minimized && card.subtitle && <div className="text-[11px] text-gray-400 truncate mt-0.5">{card.subtitle}</div>}
          {card.ref && refTitle && (
            <button type="button" onClick={() => onFocusRef(card.ref!)} onMouseEnter={() => onHoverRef(card.id)} onMouseLeave={() => onHoverRef(null)} className="mt-1 inline-flex items-center gap-1 text-[10px] text-violet-300/90 hover:text-violet-200 truncate max-w-full">
              <Link2 className="w-3 h-3 shrink-0" /> comparé à « {refTitle} »
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1">
          <button type="button" onClick={() => onToggle(card.id)} className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10" aria-label={card.minimized ? "Déplier" : "Replier"}>{card.minimized ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}</button>
          <button type="button" onClick={() => onClose(card.id)} className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      {!card.minimized && (
        <>
          <div className="flex-1 min-h-0 overflow-auto px-3.5 py-3 mo-scroll select-text touch-auto cursor-auto">
            <CardBody card={card} width={width} />
          </div>
          <div className="flex items-center gap-2 px-3.5 py-1.5 border-t border-white/5 text-[10px] text-gray-500 select-none">
            <span className="truncate" title={card.subtitle ?? ""}>{card.subtitle || "Source non précisée"}</span>
            <span className="ml-auto shrink-0 tabular-nums">{relativeTime(card.at)}</span>
          </div>
        </>
      )}
      {!card.minimized && HANDLES.map((hd) => (
        <Handle key={hd.dir} {...hd} cardId={card.id} getK={getK}
          onStart={() => onResizeStart(card.id)}
          onResize={(dir, dx, dy, alt) => { const r = onResize(card.id, dir, dx, dy, alt); applyRect(el.current, r); setLiveWidth(r.w); }}
          onEnd={() => { setLiveWidth(null); onResizeEnd(card.id); }} />
      ))}
    </div>
  );
});

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function CardBody({ card, width }: { card: MoCard; width: number }) {
  switch (card.type) {
    case "kpis": return <Kpis items={card.items} width={width} />;
    case "table": return <Table columns={card.columns} rows={card.rows} align={card.align} />;
    case "chart": return <Chart kind={card.kind} series={card.series} unit={card.unit} labels={card.x} width={width} />;
    case "creatives": return <Creatives items={card.items} width={width} />;
    case "note": return <AiMarkdown content={card.markdown} filesBase={null} className="prose-xs" />;
  }
}

function Kpis({ items, width }: { items: Extract<MoCard, { type: "kpis" }>["items"]; width: number }) {
  const cols = width < 340 ? 1 : items.length <= 2 ? 2 : items.length === 4 ? 2 : 3;
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((it, i) => {
        const Arrow = it.delta?.trim().startsWith("-") ? ArrowDownRight : it.delta?.trim().startsWith("+") || /^\d/.test(it.delta?.trim() ?? "") ? ArrowUpRight : Minus;
        return (
          <div key={i} className="rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2.5 min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-gray-400 truncate" title={it.hint ?? it.label}>{it.label}</div>
            <div className="text-[22px] font-semibold tabular-nums mt-0.5 leading-tight truncate" title={it.value}>{it.value}</div>
            {it.delta && (
              <span className={`mt-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${it.tone === "good" ? "bg-emerald-500/15 text-emerald-300" : it.tone === "bad" ? "bg-rose-500/15 text-rose-300" : "bg-white/5 text-gray-400"}`} title={it.hint}>
                <Arrow className="w-3 h-3" /> {it.delta}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const NUMERIC = /^[\s\d.,%€$+\-−–—kKM]+(\s?(€|%|\$|k|M))?$/;

function Table({ columns, rows, align }: { columns: string[]; rows: string[][]; align?: Array<"left" | "right"> }) {
  // Numeric columns right-aligned even when the model forgot the alignment.
  const right = useMemo(() => columns.map((_, j) => align?.[j] === "right" || (j > 0 && rows.length > 0 && rows.every((r) => !r[j] || NUMERIC.test(r[j])))), [columns, rows, align]);
  const stickyFirst = columns.length > 4;
  return (
    <table className="w-full text-[12px] border-collapse">
      <thead>
        <tr>{columns.map((c, i) => <th key={i} className={`sticky top-0 z-[1] bg-[#17112a] text-[10px] uppercase tracking-wide text-gray-400 font-medium px-2 py-1.5 border-b border-white/10 whitespace-nowrap ${right[i] ? "text-right" : "text-left"} ${stickyFirst && i === 0 ? "left-0 z-[2]" : ""}`}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={`hover:bg-white/[0.04] ${i % 2 ? "bg-white/[0.02]" : ""}`}>
            {r.map((cell, j) => <td key={j} className={`px-2 py-1.5 border-b border-white/5 ${right[j] ? "text-right tabular-nums whitespace-nowrap" : "text-left"} ${j === 0 ? "font-medium text-gray-100" : "text-gray-300"} ${stickyFirst && j === 0 ? `sticky left-0 ${i % 2 ? "bg-[#140f25]" : "bg-[#100c1f]"}` : ""}`}>{cell}</td>)}
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={columns.length} className="px-2 py-3 text-gray-500 text-center">Aucune ligne</td></tr>}
      </tbody>
    </table>
  );
}

function Chart({ kind, series, unit, labels, width }: { kind: "line" | "bar"; series: Extract<MoCard, { type: "chart" }>["series"]; unit?: string; labels: string[]; width: number }) {
  const data = useMemo(() => labels.map((l, i) => { const row: Record<string, string | number | null> = { x: l }; for (const s of series) row[s.name] = s.values[i] ?? null; return row; }), [labels, series]);
  const fmt = (v: unknown) => (typeof v === "number" ? `${v.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}` : "—");
  const short = (v: unknown) => (typeof v === "number" ? (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} k` : v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })) : "");
  const hasPoints = series.some((s) => s.values.some((v) => v !== null));
  if (!hasPoints) return <div className="h-full min-h-[120px] flex items-center justify-center text-xs text-gray-500">Aucune valeur à tracer</div>;
  const narrow = width < 420;
  const common = { data, margin: { top: 8, right: 8, left: -12, bottom: 0 } };
  const axes = (
    <>
      <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
      <XAxis dataKey="x" tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} interval={narrow ? "preserveStartEnd" : undefined} minTickGap={narrow ? 24 : 12} />
      <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} width={48} tickFormatter={short} tickCount={narrow ? 4 : 6} />
      <Tooltip contentStyle={{ background: "#120e22", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, fontSize: 12 }} formatter={(v) => fmt(v)} />
      {series.length > 1 && !narrow && <Legend wrapperStyle={{ fontSize: 11 }} />}
    </>
  );
  return (
    <div className="w-full h-full min-h-[160px]">
      <ResponsiveContainer width="100%" height="100%">
        {kind === "bar" ? (
          <BarChart {...common}>{axes}{series.map((s, i) => <Bar key={s.name} dataKey={s.name} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[4, 4, 0, 0]} />)}</BarChart>
        ) : (
          <LineChart {...common}>{axes}{series.map((s, i) => <Line key={s.name} type="monotone" dataKey={s.name} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />)}</LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function CreativeImage({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  return (
    <div className="aspect-[4/5] bg-black/40 flex items-center justify-center relative overflow-hidden">
      {state === "loading" && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
      {state === "error" ? <ImageIcon className="w-6 h-6 text-gray-600" /> : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/proxy-image?url=${encodeURIComponent(src)}`} alt={alt} className={`w-full h-full object-cover transition-opacity ${state === "ok" ? "opacity-100" : "opacity-0"}`} loading="lazy" onLoad={() => setState("ok")} onError={() => setState("error")} />
      )}
    </div>
  );
}

function Creatives({ items, width }: { items: Extract<MoCard, { type: "creatives" }>["items"]; width: number }) {
  const cols = width < 420 ? 1 : width < 560 ? 2 : 3;
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((it, i) => (
        <div key={i} className="rounded-xl overflow-hidden border border-white/5 bg-white/[0.03]">
          {it.image ? <CreativeImage src={it.image} alt={it.name} /> : <div className="aspect-[4/5] bg-black/40 flex items-center justify-center"><ImageIcon className="w-6 h-6 text-gray-600" /></div>}
          <div className="px-2.5 py-2">
            <div className="text-[12px] font-medium truncate" title={it.name}>{it.name}</div>
            <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
              {Object.entries(it.metrics).map(([k, v]) => <span key={k} className="text-[11px] text-gray-300 truncate"><span className="text-gray-500">{k}</span> <span className="tabular-nums font-medium">{v}</span></span>)}
            </div>
            {it.note && <div className="text-[11px] text-violet-200/80 mt-1 line-clamp-2">{it.note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
