"use client";

/**
 * The journal rail of Mo (right, collapsible): what Mo did today across every
 * page — verdicts, publications, files, cards — each with its time, client and
 * label; a click opens the page and focuses the cards. ‹ › move by day.
 */

import { ChevronLeft, ChevronRight, Check, FileUp, HardDrive, Image as ImageIcon, LayoutGrid, PenTool, Scissors, Search, Send, Sparkles } from "lucide-react";
import type { JournalEntry, JournalKind } from "@/lib/mo/journal";
import { localDay } from "@/lib/mo/journal";
import { frameColorFor } from "@/lib/mo/frames";

interface Props {
  day: string;
  entries: JournalEntry[];
  loading: boolean;
  onDay: (day: string) => void;
  onOpen: (entry: JournalEntry) => void;
  className?: string;
}

const ICONS: Record<JournalKind, typeof Check> = { verdict: Check, creative_metrics: LayoutGrid, open_editor: PenTool, drive: HardDrive, competitor_ads: Search, publish_prepare: Send, publish_confirm: Send, upload: FileUp, cards: Sparkles };

const shiftDay = (day: string, n: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return localDay(d); };
const dayLabel = (day: string) => { const today = localDay(); if (day === today) return "Aujourd'hui"; if (day === shiftDay(today, -1)) return "Hier"; return new Date(`${day}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }); };
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function JournalRail({ day, entries, loading, onDay, onOpen, className }: Props) {
  const today = localDay();
  return (
    <aside data-journal-rail className={`flex flex-col rounded-2xl border border-white/10 bg-[#0d0a1a]/85 backdrop-blur-xl shadow-2xl text-gray-200 overflow-hidden ${className ?? ""}`}>
      <div className="px-3 pt-3 pb-2 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 flex-1">Journal · {dayLabel(day)}</span>
        <button type="button" onClick={() => onDay(shiftDay(day, -1))} title="Jour précédent" className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10"><ChevronLeft className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={() => onDay(shiftDay(day, 1))} disabled={day >= today} title="Jour suivant" className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto mo-scroll px-1.5 pb-2">
        {loading && !entries.length ? <div className="px-2 py-3 text-[12px] text-gray-500">Chargement…</div>
          : !entries.length ? <div className="px-2 py-3 text-[12px] text-gray-500 leading-snug">{day === today ? "Rien encore aujourd'hui : demande des créas, des chiffres, dépose un visuel…" : "Rien ce jour-là."}</div>
          : entries.map((e) => {
            const Icon = e.kind === "verdict" && /coup/i.test(e.label) ? Scissors : e.kind === "cards" && /créa|visuel/i.test(e.label) ? ImageIcon : ICONS[e.kind] ?? Sparkles;
            const color = e.clientId ? frameColorFor(e.clientId) : null;
            return (
              <button key={e.id} type="button" data-journal-entry={e.id} onClick={() => onOpen(e)} className="w-full text-left flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 group">
                <span className="text-[10px] text-gray-500 tabular-nums shrink-0 mt-0.5 w-9">{timeOf(e.at)}</span>
                <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${e.kind === "verdict" ? "text-emerald-300" : e.kind.startsWith("publish") ? "text-amber-200" : "text-violet-300"}`} />
                <span className="min-w-0 flex-1">
                  {(e.clientName || e.boardKind !== "home") && (
                    <span className="flex items-center gap-1 text-[10px] text-gray-400 truncate">
                      {color && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />}
                      <span className="truncate">{e.clientName ?? e.boardTitle}</span>
                    </span>
                  )}
                  <span className="block text-[12px] text-gray-200 leading-snug line-clamp-2 group-hover:text-white">{e.label}</span>
                </span>
              </button>
            );
          })}
      </div>
    </aside>
  );
}
