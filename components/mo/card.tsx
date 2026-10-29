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

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownRight, ArrowUpRight, BarChart3, Check, ChevronDown, ChevronUp, ExternalLink, FileSpreadsheet, FileText, FileUp, Frame, HardDrive, Image as ImageIcon, LayoutGrid, Link2, Loader2, MessageCircleQuestion, Minus, Rocket, RotateCcw, Send, StickyNote, Table2, TrendingUp, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { CARD_SIZES, type MoCard } from "@/lib/mo/model";
import { isSheetCard } from "@/lib/mo/act";
import { MIN_HEADER_H, type HandleDir, type Rect } from "@/lib/mo/geometry";
import { useCardDrag } from "@/components/mo/board";
import { CardActions, VerdictBadge, actionForKey, actionsFor, type CreativeAction } from "@/components/mo/card-actions";

const SERIES_COLORS = ["#a78bfa", "#f0abfc", "#67e8f9", "#fde68a", "#86efac", "#fca5a5"];

const ICONS = { kpis: LayoutGrid, table: Table2, chart: TrendingUp, creatives: ImageIcon, note: StickyNote, ask: MessageCircleQuestion, file: FileUp, action: Send, frame: Frame } as const;

/** What the page is doing on this card right now (a spinner on the button): `item:<index>:<action>`, `confirm` or `sheet`. */
export type CardBusy = string | null;
/** An action on the whole card (header button, or S on the selected card): its rows exported as a Google Sheet. */
export type WholeCardAction = "sheet";
export interface PublishEdits { primaryText: string; headline: string; linkUrl: string }

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
  /** An option of an « ask » card was clicked: it is the next message. */
  onAnswer?: (id: string, option: string) => void;
  /** An action on one visual of a creatives card (hover toolbar, or G / X / P on the selected card). */
  onItemAction?: (id: string, index: number, action: CreativeAction) => void;
  /** The visual the pointer or the focus is on (for « garde celle-là » said in the composer). */
  onItemHover?: (id: string, index: number | null) => void;
  /** « Confirmer » on a publication card, with the texts as edited. */
  onConfirmPublish?: (id: string, edits: PublishEdits) => void;
  /** « Google Sheet » in the header of a table / KPI / creatives card (or S on the selected card). */
  onCardAction?: (id: string, action: WholeCardAction) => void;
  busy?: CardBusy;
}

export const HANDLES: Array<{ dir: HandleDir; cls: string; cursor: string }> = [
  { dir: "n", cls: "left-3 right-3 -top-1 h-2", cursor: "cursor-ns-resize" },
  { dir: "s", cls: "left-3 right-3 -bottom-1 h-2", cursor: "cursor-ns-resize" },
  { dir: "w", cls: "top-3 bottom-3 -left-1 w-2", cursor: "cursor-ew-resize" },
  { dir: "e", cls: "top-3 bottom-3 -right-1 w-2", cursor: "cursor-ew-resize" },
  { dir: "nw", cls: "-left-1.5 -top-1.5 w-3.5 h-3.5", cursor: "cursor-nwse-resize" },
  { dir: "se", cls: "-right-1.5 -bottom-1.5 w-3.5 h-3.5", cursor: "cursor-nwse-resize" },
  { dir: "ne", cls: "-right-1.5 -top-1.5 w-3.5 h-3.5", cursor: "cursor-nesw-resize" },
  { dir: "sw", cls: "-left-1.5 -bottom-1.5 w-3.5 h-3.5", cursor: "cursor-nesw-resize" },
];

export function applyRect(el: HTMLDivElement | null, r: { x: number; y: number; w?: number; h?: number | null }) {
  if (!el) return;
  el.style.transform = `translate(${r.x}px, ${r.y}px)`;
  if (r.w !== undefined) el.style.width = `${r.w}px`;
  if (r.h !== undefined) el.style.height = r.h === null ? "" : `${r.h}px`;
}

export function Handle({ dir, cls, cursor, cardId, getK, onStart, onResize, onEnd }: { dir: HandleDir; cls: string; cursor: string; cardId: string; getK: () => number; onStart: () => void; onResize: (dir: HandleDir, dx: number, dy: number, alt: boolean) => void; onEnd: () => void }) {
  const acc = useRef({ dx: 0, dy: 0 });
  const drag = useCardDrag(getK, (dx, dy, e) => { acc.current.dx += dx; acc.current.dy += dy; onResize(dir, acc.current.dx, acc.current.dy, e.altKey); }, (moved) => { if (moved) onEnd(); }, () => { acc.current = { dx: 0, dy: 0 }; onStart(); });
  return <div data-handle={dir} data-card-id={cardId} className={`absolute z-10 ${cls} ${cursor} touch-none`} {...drag} />;
}

export const MoCardView = memo(function MoCardView({ card, fresh, delayMs = 0, selected, refTitle, getK, onMove, onMoveEnd, onResizeStart, onResize, onResizeEnd, onFront, onSelect, onToggle, onClose, onFocusRef, onHoverRef, onAnswer, onItemAction, onItemHover, onConfirmPublish, onCardAction, busy = null }: MoCardViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const Icon = ICONS[card.type] ?? BarChart3;
  const h = card.minimized ? MIN_HEADER_H : card.h ?? CARD_SIZES[card.type].h;
  const sheetable = !!onCardAction && isSheetCard(card);
  // S on the selected card: its rows go to Google Sheets.
  useEffect(() => {
    if (!selected || !sheetable) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault(); e.stopPropagation();
      onCardAction!(card.id, "sheet");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected, sheetable, onCardAction, card.id]);
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
      data-card-type={card.type}
      className={`absolute left-0 top-0 flex flex-col rounded-2xl border bg-[#100c1f] shadow-[0_20px_60px_-20px_rgba(124,58,237,0.45)] text-gray-100 cursor-default ${fresh ? "mo-card-in" : ""} ${selected ? "border-violet-400 ring-2 ring-violet-400/40" : fresh ? "border-violet-400/60" : card.type === "ask" ? "border-fuchsia-400/40" : card.type === "action" ? (card.status === "sent" ? "border-emerald-400/40" : card.status === "failed" ? "border-rose-400/40" : "border-amber-300/40") : "border-white/10"}`}
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
          {card.type !== "file" && card.link && (
            <a data-card-link href={card.link} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} title={card.link}
              className="mt-1 inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20 hover:text-white max-w-full">
              <FileSpreadsheet className="w-3 h-3 shrink-0" /> <span className="truncate">{card.linkLabel || "Ouvrir"}</span> <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-70" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1">
          {sheetable && (
            <button type="button" data-card-sheet disabled={!!busy} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onCardAction!(card.id, "sheet"); }} className="p-1 rounded-md text-gray-500 hover:text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-50" title={card.link ? "Exporter à nouveau en Google Sheet (S)" : "Exporter en Google Sheet (S)"} aria-label="Exporter en Google Sheet">
              {busy === "sheet" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
            </button>
          )}
          <button type="button" onClick={() => onToggle(card.id)} className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10" aria-label={card.minimized ? "Déplier" : "Replier"}>{card.minimized ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}</button>
          <button type="button" onClick={() => onClose(card.id)} className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      {!card.minimized && (
        <>
          <div className="flex-1 min-h-0 overflow-auto px-3.5 py-3 mo-scroll select-text touch-auto cursor-auto">
            <CardBody card={card} width={width} selected={selected} busy={busy} onAnswer={onAnswer ? (opt) => onAnswer(card.id, opt) : undefined}
              onItemAction={onItemAction ? (i, a) => onItemAction(card.id, i, a) : undefined} onItemHover={onItemHover ? (i) => onItemHover(card.id, i) : undefined}
              onConfirmPublish={onConfirmPublish ? (edits) => onConfirmPublish(card.id, edits) : undefined} />
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

/** The placeholder drawn where the answer will land, from the send to the first real card. */
export interface Ghost {
  id: string;
  /** The sentence sent (for « Réessayer »). */
  text: string;
  title: string;
  x: number; y: number; w: number; h: number; z: number;
  state: "pending" | "error";
  message?: string;
  startedAt: number;
}

/**
 * Ghost card: same place and size as the card to come, pulsing, « en cours ».
 * On error it becomes a short error card with « Réessayer ». Not draggable.
 */
export function MoGhostCard({ ghost, onRetry, onClose }: { ghost: Ghost; onRetry: () => void; onClose: () => void }) {
  const error = ghost.state === "error";
  return (
    <div
      data-ghost
      data-ghost-state={ghost.state}
      className={`absolute left-0 top-0 flex flex-col rounded-2xl border text-gray-100 ${error ? "border-rose-400/40 bg-[#1a0d16]" : "border-violet-400/40 border-dashed bg-[#100c1f]/80 mo-ghost"}`}
      style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)`, width: ghost.w, height: error ? Math.min(ghost.h, 200) : ghost.h, zIndex: ghost.z }}
    >
      <div className="flex items-start gap-2 px-3.5 pt-3 pb-2 border-b border-white/5 select-none">
        <span className={`mt-0.5 inline-flex w-6 h-6 items-center justify-center rounded-lg shrink-0 ${error ? "bg-rose-500/15 text-rose-300" : "bg-violet-500/15 text-violet-300"}`}>{error ? <X className="w-3.5 h-3.5" /> : <Loader2 className="w-3.5 h-3.5 animate-spin" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight truncate" title={ghost.title}>{ghost.title}</div>
          <div className={`text-[11px] mt-0.5 ${error ? "text-rose-300/80" : "text-violet-300/80"}`}>{error ? "pas de carte" : "en cours"}</div>
        </div>
        {error && <button type="button" onClick={onClose} className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>}
      </div>
      {error ? (
        <div className="px-3.5 py-3 flex flex-col gap-2.5">
          <div className="text-[12px] text-gray-300 leading-snug line-clamp-3">{ghost.message || "Mo n'a pas pu répondre."}</div>
          <button type="button" onClick={onRetry} className="self-start inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] text-gray-200 hover:bg-white/10 hover:text-white"><RotateCcw className="w-3 h-3" /> Réessayer</button>
        </div>
      ) : (
        <div className="flex-1 px-3.5 py-3 flex flex-col gap-2">
          <div className="h-3 w-2/3 rounded bg-white/[0.06]" />
          <div className="h-3 w-1/2 rounded bg-white/[0.05]" />
          <div className="flex-1 min-h-[40px] rounded-xl bg-white/[0.03]" />
        </div>
      )}
    </div>
  );
}

/** A file being sent after a drop: its local preview where it was dropped, then the real card replaces it. */
export interface Upload { id: string; name: string; mime: string; bytes: number; x: number; y: number; z: number; preview: string | null; state: "pending" | "error"; message?: string }

export function MoUploadCard({ up, onClose }: { up: Upload; onClose: () => void }) {
  const error = up.state === "error";
  const size = CARD_SIZES.file;
  return (
    <div data-upload data-upload-state={up.state} className={`absolute left-0 top-0 flex flex-col rounded-2xl border text-gray-100 ${error ? "border-rose-400/40 bg-[#1a0d16]" : "border-violet-400/40 border-dashed bg-[#100c1f]/90 mo-ghost"}`} style={{ transform: `translate(${up.x}px, ${up.y}px)`, width: size.w, height: error ? 200 : size.h, zIndex: up.z }}>
      <div className="flex items-start gap-2 px-3.5 pt-3 pb-2 border-b border-white/5 select-none">
        <span className={`mt-0.5 inline-flex w-6 h-6 items-center justify-center rounded-lg shrink-0 ${error ? "bg-rose-500/15 text-rose-300" : "bg-violet-500/15 text-violet-300"}`}>{error ? <X className="w-3.5 h-3.5" /> : <Loader2 className="w-3.5 h-3.5 animate-spin" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight truncate" title={up.name}>{up.name}</div>
          <div className={`text-[11px] mt-0.5 ${error ? "text-rose-300/80" : "text-violet-300/80"}`}>{error ? "pas rangé" : "envoi…"}</div>
        </div>
        {error && <button type="button" onClick={onClose} className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10" aria-label="Fermer"><X className="w-3.5 h-3.5" /></button>}
      </div>
      {error ? <div className="px-3.5 py-3 text-[12px] text-gray-300 leading-snug line-clamp-4">{up.message || "Le fichier n'a pas pu être rangé."}</div>
        : <div className="flex-1 min-h-0 px-3.5 py-3">{up.preview ? <div className="rounded-xl overflow-hidden border border-white/5 bg-black/40"><CreativeImage src={up.preview} alt={up.name} ratio="aspect-square" /></div> : <div className="h-full min-h-[120px] rounded-xl border border-white/5 bg-white/[0.03] flex items-center justify-center"><FileText className="w-10 h-10 text-violet-300/60" /></div>}</div>}
    </div>
  );
}

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

function CardBody({ card, width, selected, busy, onAnswer, onItemAction, onItemHover, onConfirmPublish }: { card: MoCard; width: number; selected: boolean; busy: CardBusy; onAnswer?: (option: string) => void; onItemAction?: (index: number, action: CreativeAction) => void; onItemHover?: (index: number | null) => void; onConfirmPublish?: (edits: PublishEdits) => void }) {
  switch (card.type) {
    case "ask": return <Ask question={card.question} options={card.options} onAnswer={onAnswer} />;
    case "kpis": return <Kpis items={card.items} width={width} />;
    case "table": return <Table columns={card.columns} rows={card.rows} align={card.align} />;
    case "chart": return <Chart kind={card.kind} series={card.series} unit={card.unit} labels={card.x} width={width} />;
    case "creatives": return <Creatives items={card.items} width={width} selected={selected} busy={busy} onAction={onItemAction} onHover={onItemHover} />;
    case "note": return <AiMarkdown content={card.markdown} filesBase={null} className="prose-xs" />;
    case "file": return <FileBody card={card} />;
    case "action": return <PublishBody card={card} busy={busy === "confirm"} onConfirm={onConfirmPublish} />;
    // Frames are drawn by MoFrameView (components/mo/frame.tsx), never as a card body.
    case "frame": return null;
  }
}

const fmtBytes = (n?: number) => (n === undefined ? "" : n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${Math.round(n / 1024)} Ko` : `${(n / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`);

/** A dropped file: the picture (a visual) or the document icon (a brief), its name, the Drive link. */
function FileBody({ card }: { card: Extract<MoCard, { type: "file" }> }) {
  const isImage = !!card.image;
  return (
    <div className="flex flex-col gap-2 h-full">
      {isImage ? <div className="rounded-xl overflow-hidden border border-white/5 bg-black/40"><CreativeImage src={card.image!} alt={card.name} ratio="aspect-square" /></div>
        : <div className="flex-1 min-h-[120px] rounded-xl border border-white/5 bg-white/[0.03] flex flex-col items-center justify-center gap-2 text-gray-400"><FileText className="w-10 h-10 text-violet-300/70" /><span className="text-[11px] uppercase tracking-wide">{/pdf/i.test(card.mime) ? "PDF" : /word|docx?/i.test(card.mime) ? "Word" : "Document"}</span></div>}
      <div className="min-w-0">
        <div className="text-[12px] font-medium truncate" title={card.name}>{card.name}</div>
        <div className="text-[11px] text-gray-500">{[fmtBytes(card.bytes), card.folder === "briefs" ? "Brief" : card.assetId ? "Dans les créas du client" : null].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-auto">
        {card.link && <a href={card.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-gray-200 hover:bg-white/10 hover:text-white"><HardDrive className="w-3 h-3" /> Ouvrir dans le Drive</a>}
        {card.assetId && <a href={`/api/studio/assets/${card.assetId}/file`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-gray-200 hover:bg-white/10 hover:text-white"><ExternalLink className="w-3 h-3" /> Fichier</a>}
      </div>
    </div>
  );
}

/**
 * A publication prepared through the Pilotage: the summary, the texts (editable
 * until it leaves), « Confirmer » (the only thing that sends: the ad is created
 * PAUSED), the outcome and the link to the Pilotage.
 */
function PublishBody({ card, busy, onConfirm }: { card: Extract<MoCard, { type: "action" }>; busy: boolean; onConfirm?: (edits: PublishEdits) => void }) {
  const [primaryText, setPrimaryText] = useState(card.primaryText);
  const [headline, setHeadline] = useState(card.headline ?? "");
  const [linkUrl, setLinkUrl] = useState(card.linkUrl);
  // The card was rewritten by the server (re-prepared, sent): the fields follow (derived state, reset on a new draft).
  const draftKey = `${card.actionId}|${card.primaryText}|${card.headline ?? ""}|${card.linkUrl}`;
  const [seenDraft, setSeenDraft] = useState(draftKey);
  if (seenDraft !== draftKey) { setSeenDraft(draftKey); setPrimaryText(card.primaryText); setHeadline(card.headline ?? ""); setLinkUrl(card.linkUrl); }
  const editable = card.status !== "sent";
  const linkOk = /^https:\/\/\S+$/.test(linkUrl.trim());
  const canConfirm = editable && !busy && card.writesOpen && primaryText.trim().length > 0 && linkOk && !!onConfirm;
  const field = "w-full rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-violet-400/60 disabled:opacity-70";
  return (
    <div className="flex flex-col gap-2.5 text-[12px]" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex gap-3">
        {card.image && <div className="w-24 shrink-0 rounded-lg overflow-hidden border border-white/5 bg-black/40"><CreativeImage src={card.image} alt={card.name} /></div>}
        <dl className="flex-1 min-w-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
          <dt className="text-gray-500">Compte</dt><dd className="truncate text-gray-200" title={card.account}>{card.account}</dd>
          <dt className="text-gray-500">Ensemble</dt><dd className="truncate text-gray-200" title={card.adset}>{card.adset}</dd>
          <dt className="text-gray-500">Page</dt><dd className="truncate text-gray-200" title={card.page}>{card.page}</dd>
          <dt className="text-gray-500">Nom</dt><dd className="truncate text-gray-200" title={card.name}>{card.name}</dd>
          <dt className="text-gray-500">Statut</dt><dd className={card.status === "sent" ? "text-emerald-300" : card.status === "failed" ? "text-rose-300" : "text-amber-200"}>{card.status === "sent" ? `Créée EN PAUSE${card.adId ? ` · pub ${card.adId}` : ""}` : card.status === "failed" ? "Échec de l'envoi" : "À confirmer · créée en pause, rien ne dépense"}</dd>
        </dl>
      </div>
      {card.textsFrom && <div className="rounded-lg border border-violet-400/20 bg-violet-500/10 px-2.5 py-1.5 text-[11px] text-violet-100">Textes et lien repris de la créa « {card.textsFrom} » (la plus dépensée sur 30 jours) : relis-les, ils sont modifiables.</div>}
      <label className="block"><span className="text-[10px] uppercase tracking-wide text-gray-500">Texte principal</span>
        <textarea data-publish-field="primaryText" value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} disabled={!editable || busy} rows={3} className={`${field} mt-0.5 resize-y min-h-[56px] mo-scroll`} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block"><span className="text-[10px] uppercase tracking-wide text-gray-500">Titre</span>
          <input data-publish-field="headline" value={headline} onChange={(e) => setHeadline(e.target.value)} disabled={!editable || busy} className={`${field} mt-0.5`} placeholder="(facultatif)" /></label>
        <label className="block"><span className="text-[10px] uppercase tracking-wide text-gray-500">Bouton</span>
          <input value={card.cta ?? "(bouton par défaut)"} disabled className={`${field} mt-0.5`} /></label>
      </div>
      <label className="block"><span className="text-[10px] uppercase tracking-wide text-gray-500">Lien de destination</span>
        <input data-publish-field="linkUrl" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} disabled={!editable || busy} className={`${field} mt-0.5 ${linkUrl && !linkOk ? "border-rose-400/60" : ""}`} placeholder="https://…" /></label>
      {card.hq && <div className={`text-[11px] ${/ATTENTION/.test(card.hq) ? "text-amber-200" : "text-gray-500"}`}>{card.hq}</div>}
      {!card.writesOpen && editable && <div className="rounded-lg border border-amber-300/30 bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-100">Les écritures Meta sont fermées sur cet environnement (PILOT_WRITES) : la confirmation serait refusée.</div>}
      {card.error && <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-200">{card.error}</div>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {editable ? (
          <button type="button" data-publish-confirm disabled={!canConfirm} onClick={() => onConfirm?.({ primaryText: primaryText.trim(), headline: headline.trim(), linkUrl: linkUrl.trim() })} className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-3.5 py-1.5 text-[12px] font-semibold text-white">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {card.status === "failed" ? "Réessayer" : "Confirmer"}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-200 px-3 py-1.5 text-[12px] font-semibold"><Check className="w-3.5 h-3.5" /> Publiée en pause</span>
        )}
        <button type="button" disabled title="Bientôt : pour l'instant l'activation se fait dans le Gestionnaire de publicités" className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-[12px] text-gray-500 opacity-60 cursor-not-allowed"><Rocket className="w-3.5 h-3.5" /> Mettre en ligne</button>
        <a href={card.pilotage} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-white"><ExternalLink className="w-3 h-3" /> Pilotage</a>
      </div>
    </div>
  );
}

/** Mo's question with its options as chips: a click is the next message. */
function Ask({ question, options, onAnswer }: { question: string; options: string[]; onAnswer?: (option: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-[14px] text-gray-100 leading-snug">{question}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={o} type="button" onClick={(e) => { e.stopPropagation(); onAnswer?.(o); }} disabled={!onAnswer} className="rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-[12px] text-violet-100 hover:bg-violet-500/30 hover:border-violet-300 disabled:opacity-60">{o}</button>
        ))}
      </div>
    </div>
  );
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

export function CreativeImage({ src, alt, ratio = "aspect-[4/5]" }: { src: string; alt: string; ratio?: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  // Our own files and local previews (blob:, data:) load as they are; a platform picture goes through the proxy.
  const url = /^(\/|blob:|data:)/.test(src) ? src : `/api/media/proxy-image?url=${encodeURIComponent(src)}`;
  return (
    <div className={`${ratio} bg-black/40 flex items-center justify-center relative overflow-hidden`}>
      {state === "loading" && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
      {state === "error" ? <ImageIcon className="w-6 h-6 text-gray-600" /> : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} className={`w-full h-full object-cover transition-opacity ${state === "ok" ? "opacity-100" : "opacity-0"}`} loading="lazy" onLoad={() => setState("ok")} onError={() => setState("error")} />
      )}
    </div>
  );
}

const isTyping = () => { const el = document.activeElement as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable); };

function Creatives({ items, width, selected, busy, onAction, onHover }: { items: Extract<MoCard, { type: "creatives" }>["items"]; width: number; selected: boolean; busy: CardBusy; onAction?: (index: number, action: CreativeAction) => void; onHover?: (index: number | null) => void }) {
  const cols = width < 420 ? 1 : width < 560 ? 2 : 3;
  const [hot, setHot] = useState<number | null>(null);
  const hotRef = useRef<number | null>(null);
  const setHover = (i: number | null) => { hotRef.current = i; setHot(i); onHover?.(i); };
  // G / X / P on the selected card act on the visual the pointer or the focus is on (the only one when there is one).
  useEffect(() => {
    if (!selected || !onAction) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = actionForKey(e.key);
      if (!a) return;
      const i = hotRef.current ?? (items.length === 1 ? 0 : null);
      if (i === null || !actionsFor(items[i]).includes(a)) return;
      e.preventDefault(); e.stopPropagation();
      onAction(i, a);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selected, onAction, items]);
  const busyOf = (i: number): CreativeAction | null => { const m = busy?.match(/^item:(\d+):(\w+)$/); return m && Number(m[1]) === i ? (m[2] as CreativeAction) : null; };
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((it, i) => (
        <div key={i} data-item={i} data-item-verdict={it.verdict ?? undefined} tabIndex={onAction ? 0 : undefined}
          onMouseEnter={() => setHover(i)} onMouseLeave={() => { if (hotRef.current === i) setHover(null); }} onFocus={() => setHover(i)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && hotRef.current === i) setHover(null); }}
          className={`group relative rounded-xl overflow-hidden border bg-white/[0.03] outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 ${it.verdict === "keep" ? "border-emerald-400/40" : it.verdict === "cut" ? "border-white/5 opacity-60" : hot === i && selected ? "border-violet-400/40" : "border-white/5"}`}>
          <div className="relative">
            {it.image ? <CreativeImage src={it.image} alt={it.name} /> : <div className="aspect-[4/5] bg-black/40 flex items-center justify-center"><ImageIcon className="w-6 h-6 text-gray-600" /></div>}
            <VerdictBadge verdict={it.verdict} />
            {onAction && <CardActions item={it} busy={busyOf(i)} onAction={(a) => onAction(i, a)} />}
          </div>
          <div className="px-2.5 py-2">
            <div className="text-[12px] font-medium truncate" title={it.name}>{it.link ? <a href={it.link} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>{it.name}</a> : it.name}</div>
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
