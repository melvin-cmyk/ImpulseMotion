"use client";

/**
 * Pilotage — one history for a client: what was sent from Pilotage (action
 * cards, with undo and HQ) and what the platforms' logs say anyone changed
 * (sessions: one person, one account, changes a few minutes apart), day by
 * day, newest first. A change made outside Pilotage can be explained by a
 * consultant (« Pourquoi ») — written in HQ — and carries its own J+7 / J+14
 * analyses when it moves the delivery. Filters: source, kind of setting, a
 * day (clicked on the curve), a text.
 */

import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquare } from "lucide-react";
import { Pill } from "@/components/ui/surface";
import { PLATFORM_FR } from "@/lib/pilot/ops";
import { parisDay } from "@/lib/pilot/impact";
import { groupSessions, type ChangeSource } from "@/lib/pilot/changes";
import { categoryOf, summarizeSession, type ChangeCategory } from "@/lib/pilot/history-stats";
import type { PlatformChangeView } from "@/lib/pilot/history";
import { ImpactCards } from "@/components/pilot/impact";
import { ActionCard } from "@/components/pilot/journal";
import { readJson, type PilotActionView } from "@/components/pilot/model";

export type SourceFilter = "all" | "impulsemotion" | "external" | "automated";
export interface HistoryFilter { source: SourceFilter; category: ChangeCategory | "all"; query: string; day: string | null }
export const NO_FILTER: HistoryFilter = { source: "all", category: "all", query: "", day: null };

const SOURCE_TONE: Record<ChangeSource, "violet" | "amber" | "default"> = { impulsemotion: "violet", external: "amber", automated: "default" };
const when = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const dayTitle = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" });
const plain = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

type Item = { kind: "action"; at: string; action: PilotActionView } | { kind: "session"; at: string; changes: PlatformChangeView[] };

const matchesQuery = (q: string, ...texts: Array<string | null | undefined>) => !q || texts.some((t) => t && plain(t).includes(q));

/** Actions and sessions in one order, filtered; the changes of an action shown in the list are folded into its card. */
export function mergeHistory(actions: PilotActionView[], changes: PlatformChangeView[], filter: HistoryFilter): Item[] {
  const q = plain(filter.query.trim());
  const actionIds = new Set(actions.map((a) => a.id));
  const loose = changes.filter((c) => !(c.pilotActionId && actionIds.has(c.pilotActionId)));
  const items: Item[] = [];
  if (filter.source === "all" || filter.source === "impulsemotion") {
    for (const a of actions) {
      const at = a.executedAt ?? a.createdAt;
      if (filter.day && parisDay(new Date(at)) !== filter.day) continue;
      if (filter.category !== "all" && !a.operations.some((o) => categoryOf(o.field, o.after) === filter.category)) continue;
      if (!matchesQuery(q, a.createdByName, a.why, a.accountName, ...a.operations.map((o) => o.objectName))) continue;
      items.push({ kind: "action", at, action: a });
    }
  }
  const kept = loose.filter((c) =>
    (filter.source === "all" || c.source === filter.source)
    && (!filter.day || parisDay(new Date(c.at)) === filter.day)
    && (filter.category === "all" || categoryOf(c.field, c.after) === filter.category)
    && matchesQuery(q, c.actorName, c.objectName, c.line, c.via, c.note));
  for (const session of groupSessions(kept)) items.push({ kind: "session", at: session[0].at, changes: session });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

function NoteEditor({ change, onChanged }: { change: PlatformChangeView; onChanged: (c: PlatformChangeView) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(change.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pilot/changes/${change.id}/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: text }) });
      const j = await readJson<{ change?: PlatformChangeView }>(res);
      if (!res.ok || !j.change) throw new Error(j.error ?? `Erreur ${res.status}`);
      onChanged(j.change);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {change.note ? <p className="text-gray-300"><span className="text-gray-500">Pourquoi</span> ({change.noteByName}) : {change.note}</p> : null}
        <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 text-gray-400 hover:text-white">
          <MessageSquare className="w-3.5 h-3.5" /> {change.note ? "Modifier le pourquoi" : "Expliquer cette modification"}
        </button>
        {change.note && change.hqWrittenAt && <span className="text-emerald-300/80 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Consigné dans HQ</span>}
        {change.note && !change.hqWrittenAt && change.hqError && <span className="text-amber-300">HQ : {change.hqError}</span>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={1000} autoFocus
        placeholder="Pourquoi cette modification a été faite (sera consigné dans le dossier HQ du client, à votre nom)"
        className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-violet-500"
      />
      <div className="flex items-center gap-3 text-xs">
        <button type="button" disabled={busy} onClick={() => void save()} className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 flex items-center gap-1">
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Enregistrer
        </button>
        <button type="button" onClick={() => { setOpen(false); setText(change.note); }} className="text-gray-400 hover:text-white">Annuler</button>
        {error && <span className="text-red-300">{error}</span>}
      </div>
    </div>
  );
}

const FOLD_ABOVE = 6;

function SessionCard({ changes, showClient, clientName, onChanged }: { changes: PlatformChangeView[]; showClient?: boolean; clientName?: string; onChanged: (c: PlatformChangeView) => void }) {
  const head = changes[0];
  const last = changes[changes.length - 1];
  const [open, setOpen] = useState(changes.length <= FOLD_ABOVE);
  const judged = changes.filter((c) => c.impacts.length && c.impacts.some((i) => i.status !== "skipped"));
  const objects = new Set(changes.map((c) => c.objectName).filter(Boolean));
  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <span className="text-gray-500 tabular-nums">{changes.length > 1 ? `${when(last.at)}–${when(head.at)}` : when(head.at)}</span>
        <span className="text-gray-200 font-medium">{head.actorName}</span>
        {showClient && clientName && <span>· {clientName}</span>}
        <span>· {PLATFORM_FR[head.platform] ?? head.platform}</span>
        <Pill tone={SOURCE_TONE[head.source] ?? "default"} className="text-[10px]">{head.sourceText}</Pill>
        <span className="text-gray-500">via {head.via}</span>
      </div>
      {changes.length > 1 && (
        <button type="button" onClick={() => setOpen(!open)} className="text-sm text-gray-200 flex items-center gap-1.5 text-left">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
          <span className="font-medium">{changes.length} changements</span>
          <span className="text-gray-400">— {summarizeSession(changes)}{objects.size > 1 ? ` sur ${objects.size} objets` : ""}</span>
        </button>
      )}
      {(open || changes.length === 1) && (
        <ul className="space-y-1 pl-5">
          {changes.map((c) => (
            <li key={c.id} className="text-sm text-gray-200 flex flex-wrap items-baseline gap-2">
              <span>{c.line}</span>
              {!c.significant && <span className="text-[10px] text-gray-500">sans effet sur la diffusion</span>}
            </li>
          ))}
        </ul>
      )}
      {head.source !== "impulsemotion" && <div className="pl-5"><NoteEditor change={changes.find((c) => c.note) ?? head} onChanged={onChanged} /></div>}
      {judged.map((c) => (
        <div key={c.id} className="space-y-1 pl-5">
          {changes.length > 1 && <p className="text-[11px] text-gray-500">Bilan de : {c.line}</p>}
          <ImpactCards impacts={c.impacts} platform={c.platform} />
        </div>
      ))}
      {!judged.length && changes.some((c) => c.impacts.length) && (
        <div className="pl-5"><ImpactCards impacts={changes.find((c) => c.impacts.length)!.impacts} platform={head.platform} /></div>
      )}
    </li>
  );
}

export function HistoryTimeline({ actions, changes, loading, filter, showClient, clientNames, onUndo, onActionChanged, onChangeChanged }: {
  actions: PilotActionView[];
  changes: PlatformChangeView[];
  loading: boolean;
  filter: HistoryFilter;
  showClient?: boolean;
  clientNames?: Record<string, string>;
  onUndo: (preview: PilotActionView) => void;
  onActionChanged: (action: PilotActionView) => void;
  onChangeChanged: (change: PlatformChangeView) => void;
}) {
  const items = useMemo(() => mergeHistory(actions.filter((a) => a.status !== "draft"), changes, filter), [actions, changes, filter]);
  const days = useMemo(() => {
    const out: Array<{ day: string; items: Item[] }> = [];
    for (const it of items) {
      const day = parisDay(new Date(it.at));
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(it); else out.push({ day, items: [it] });
    }
    return out;
  }, [items]);
  if (loading && !items.length) return <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Lecture de l&apos;historique…</p>;
  if (!items.length) return <p className="text-sm text-gray-500">Aucune modification {filter.day || filter.query || filter.category !== "all" || filter.source !== "all" ? "pour ces filtres" : "sur cette période"}.</p>;
  return (
    <div className="space-y-4">
      {days.map(({ day, items: list }) => (
        <div key={day}>
          <h4 className="sticky top-0 z-10 bg-gray-900/95 backdrop-blur text-xs uppercase tracking-wide text-gray-500 py-1.5 border-b border-gray-800">
            {dayTitle(day)} <span className="text-gray-600">· {list.reduce((n, it) => n + (it.kind === "action" ? it.action.operations.length : it.changes.length), 0)} changement(s)</span>
          </h4>
          <ul className="divide-y divide-gray-800/70">
            {list.map((it) => it.kind === "action"
              ? <ActionCard key={`a:${it.action.id}`} action={it.action} showClient={showClient} onUndo={onUndo} onChanged={onActionChanged} />
              : <SessionCard key={`s:${it.changes[0].id}`} changes={it.changes} showClient={showClient} clientName={clientNames?.[it.changes[0].alertClientId ?? ""]} onChanged={onChangeChanged} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}
