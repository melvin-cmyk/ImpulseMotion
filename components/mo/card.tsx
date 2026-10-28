"use client";

/**
 * One floating card of Mo's board, rendered by type: KPIs, table, chart,
 * creatives, note. Dragged by its header; folds, closes.
 */

import { memo, useMemo } from "react";
import { BarChart3, ChevronDown, ChevronUp, Image as ImageIcon, LayoutGrid, Link2, StickyNote, Table2, TrendingUp, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { CARD_SIZES, type MoCard } from "@/lib/mo/model";
import { useCardDrag } from "@/components/mo/board";

const SERIES_COLORS = ["#a78bfa", "#f0abfc", "#67e8f9", "#fde68a", "#86efac", "#fca5a5"];

const ICONS = { kpis: LayoutGrid, table: Table2, chart: TrendingUp, creatives: ImageIcon, note: StickyNote } as const;

interface Props {
  card: MoCard;
  fresh: boolean;
  refTitle: string | null;
  getK: () => number;
  onMove: (id: string, dx: number, dy: number) => void;
  onMoveEnd: (id: string) => void;
  onToggle: (id: string) => void;
  onClose: (id: string) => void;
  onFocusRef: (id: string) => void;
}

export const MoCardView = memo(function MoCardView({ card, fresh, refTitle, getK, onMove, onMoveEnd, onToggle, onClose, onFocusRef }: Props) {
  const drag = useCardDrag(getK, (dx, dy) => onMove(card.id, dx, dy), () => onMoveEnd(card.id));
  const Icon = ICONS[card.type] ?? BarChart3;
  const h = card.minimized ? undefined : card.h ?? CARD_SIZES[card.type].h;
  return (
    <div
      data-card
      className={`absolute flex flex-col rounded-2xl border bg-[#0d0a1a]/85 backdrop-blur-xl shadow-[0_20px_60px_-20px_rgba(124,58,237,0.45)] text-gray-100 ${fresh ? "border-violet-400/60 mo-card-in" : "border-white/10"}`}
      style={{ left: card.x, top: card.y, width: card.w, height: h }}
    >
      <div className="flex items-start gap-2 px-3.5 pt-3 pb-2 cursor-grab active:cursor-grabbing border-b border-white/5" {...drag}>
        <span className="mt-0.5 inline-flex w-6 h-6 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300 shrink-0"><Icon className="w-3.5 h-3.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight truncate" title={card.title}>{card.title}</div>
          {card.subtitle && <div className="text-[11px] text-gray-400 truncate mt-0.5">{card.subtitle}</div>}
          {card.ref && refTitle && (
            <button type="button" onClick={() => onFocusRef(card.ref!)} className="mt-1 inline-flex items-center gap-1 text-[10px] text-violet-300/90 hover:text-violet-200 truncate max-w-full">
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
        <div className="flex-1 min-h-0 overflow-auto px-3.5 py-3 mo-scroll">
          <CardBody card={card} />
        </div>
      )}
    </div>
  );
});

function CardBody({ card }: { card: MoCard }) {
  switch (card.type) {
    case "kpis": return <Kpis items={card.items} />;
    case "table": return <Table columns={card.columns} rows={card.rows} align={card.align} />;
    case "chart": return <Chart kind={card.kind} series={card.series} unit={card.unit} labels={card.x} />;
    case "creatives": return <Creatives items={card.items} />;
    case "note": return <AiMarkdown content={card.markdown} filesBase={null} className="prose-xs" />;
  }
}

function Kpis({ items }: { items: Extract<MoCard, { type: "kpis" }>["items"] }) {
  const cols = items.length <= 2 ? 2 : items.length === 4 ? 2 : 3;
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((it, i) => (
        <div key={i} className="rounded-xl bg-white/[0.04] border border-white/5 px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wide text-gray-400 truncate" title={it.hint ?? it.label}>{it.label}</div>
          <div className="text-xl font-semibold tabular-nums mt-0.5 leading-tight">{it.value}</div>
          {it.delta && <div className={`text-[11px] mt-0.5 ${it.tone === "good" ? "text-emerald-300" : it.tone === "bad" ? "text-rose-300" : "text-gray-400"}`}>{it.delta}</div>}
        </div>
      ))}
    </div>
  );
}

function Table({ columns, rows, align }: { columns: string[]; rows: string[][]; align?: Array<"left" | "right"> }) {
  return (
    <table className="w-full text-[12px] border-collapse">
      <thead>
        <tr>{columns.map((c, i) => <th key={i} className={`sticky top-0 bg-[#120e22] text-[10px] uppercase tracking-wide text-gray-400 font-medium px-2 py-1.5 border-b border-white/10 ${align?.[i] === "right" ? "text-right" : "text-left"}`}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-white/[0.03]">
            {r.map((cell, j) => <td key={j} className={`px-2 py-1.5 border-b border-white/5 ${align?.[j] === "right" ? "text-right tabular-nums" : "text-left"} ${j === 0 ? "font-medium text-gray-100" : "text-gray-300"}`}>{cell}</td>)}
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={columns.length} className="px-2 py-3 text-gray-500 text-center">Aucune ligne</td></tr>}
      </tbody>
    </table>
  );
}

function Chart({ kind, series, unit, labels }: { kind: "line" | "bar"; series: Extract<MoCard, { type: "chart" }>["series"]; unit?: string; labels: string[] }) {
  const data = useMemo(() => labels.map((l, i) => { const row: Record<string, string | number | null> = { x: l }; for (const s of series) row[s.name] = s.values[i] ?? null; return row; }), [labels, series]);
  const fmt = (v: unknown) => (typeof v === "number" ? `${v.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}` : "—");
  const common = { data, margin: { top: 8, right: 8, left: -12, bottom: 0 } };
  const axes = (
    <>
      <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
      <XAxis dataKey="x" tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} />
      <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} width={48} />
      <Tooltip contentStyle={{ background: "#120e22", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, fontSize: 12 }} formatter={(v) => fmt(v)} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
    </>
  );
  return (
    <div className="w-full h-full min-h-[200px]">
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

function Creatives({ items }: { items: Extract<MoCard, { type: "creatives" }>["items"] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {items.map((it, i) => (
        <div key={i} className="rounded-xl overflow-hidden border border-white/5 bg-white/[0.03]">
          <div className="aspect-[4/3] bg-black/40 flex items-center justify-center">
            {it.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/media/proxy-image?url=${encodeURIComponent(it.image)}`} alt={it.name} className="w-full h-full object-cover" loading="lazy" />
            ) : <ImageIcon className="w-6 h-6 text-gray-600" />}
          </div>
          <div className="px-2.5 py-2">
            <div className="text-[12px] font-medium truncate" title={it.name}>{it.name}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              {Object.entries(it.metrics).map(([k, v]) => <span key={k} className="text-[11px] text-gray-300"><span className="text-gray-500">{k}</span> <span className="tabular-nums font-medium">{v}</span></span>)}
            </div>
            {it.note && <div className="text-[11px] text-violet-200/80 mt-1 line-clamp-2">{it.note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
