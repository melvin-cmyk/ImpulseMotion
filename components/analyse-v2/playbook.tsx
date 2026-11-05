"use client";

/**
 * Playbook of a client (Motion's Playbook): « À valider » (learnings the AI
 * proposed — accept or decline) and « Enregistrées » (the team's learnings),
 * plus the « Ajouter au playbook » button used on a creative's sheet and on
 * copilot answers. Saved learnings are read by the Analyse Ads copilot.
 */

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { BookOpen, Check, ExternalLink, Loader2, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import type { PlaybookEntry, PlaybookRef, PlaybookSource } from "@/lib/ads-warehouse/playbook";
import { PILL, Popover } from "./pill";

/** Fired after any playbook change, so the sidebar badge refreshes. */
export const PLAYBOOK_CHANGED_EVENT = "impulsemotion:playbook-changed";
const changed = () => window.dispatchEvent(new Event(PLAYBOOK_CHANGED_EVENT));
const MIN_CHARS = 20;

const SOURCE_LABEL: Record<PlaybookSource, string> = { manual: "Note", creative: "Créa", copilot: "Copilote", ai: "Proposé par l'IA" };
const fmtDate = (d: string) => new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });

async function addEntry(body: { accountKey: string; title: string; userNote?: string; aiNote?: string; source: PlaybookSource; ref?: PlaybookRef }): Promise<string | null> {
  const r = await fetch("/api/ads/playbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.ok) { changed(); return null; }
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Erreur ${r.status}`;
}

/** « Ajouter au playbook » — a popover with a title and a note. */
export function AddToPlaybook({ accountKey, source, defaultTitle, aiNote, refInfo, compact }: { accountKey: string | null; source: PlaybookSource; defaultTitle: string; aiNote?: string; refInfo?: PlaybookRef; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle);
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  const tooShort = (title + note + (aiNote ?? "")).trim().length < MIN_CHARS;
  async function save() {
    if (!accountKey || !title.trim() || tooShort) return;
    setState({ busy: true });
    const error = await addEntry({ accountKey, title: title.trim(), userNote: note.trim(), aiNote, source, ref: refInfo });
    setState(error ? { error } : { done: true });
    if (!error) { setNote(""); setTimeout(() => { setOpen(false); setState({}); }, 900); }
  }
  if (!accountKey) return null;
  return (
    <Popover width={320} align="right" side={compact ? "top" : "bottom"} open={open} onOpenChange={(o) => { setOpen(o); if (o) { setTitle(defaultTitle); setState({}); } }} trigger={({ toggle }) => (
      compact
        ? <button type="button" onClick={toggle} title="Ajouter au playbook du client" className="inline-flex items-center gap-1 text-[11px] text-ui-muted hover:text-ui-accent-ink"><BookOpen className="w-3 h-3" />Ajouter au playbook</button>
        : <button type="button" onClick={toggle} className={PILL} title="Garder un apprentissage sur cette créa dans le playbook du client"><BookOpen className="w-4 h-4 text-ui-fg2" />Playbook</button>
    )}>
      <div className="p-2 space-y-2" onClick={(e) => e.stopPropagation()}>
        <div className="text-xs font-medium text-ui-fg2">Ajouter au playbook du client</div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ce qu'on retient (titre)" className="w-full h-8 rounded-lg border border-ui-line bg-ui-card px-2 text-sm text-ui-fg placeholder:text-ui-muted" />
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={aiNote ? "Ton commentaire (optionnel) : la réponse de l'IA est gardée avec." : "Pourquoi, avec les chiffres (ex. CPA 30 % sous la moyenne)…"} className="w-full rounded-lg border border-ui-line bg-ui-card px-2 py-1.5 text-sm text-ui-fg placeholder:text-ui-muted resize-none" />
        {state.error && <div className="text-xs text-red-300">{state.error}</div>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-ui-muted">{tooShort ? `${MIN_CHARS} caractères minimum` : "L'IA s'en servira dans ses analyses."}</span>
          <button type="button" onClick={() => void save()} disabled={state.busy || !title.trim() || tooShort} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-ui-inverse text-sm font-medium text-ui-on-inverse disabled:opacity-40">
            {state.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : state.done ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}{state.done ? "Ajouté" : "Ajouter"}
          </button>
        </div>
      </div>
    </Popover>
  );
}

/** Number of AI proposals awaiting review (sidebar badge). */
export function usePlaybookReviewCount(accountKey: string | null): number {
  const [state, setState] = useState<{ key: string; n: number }>({ key: "", n: 0 });
  useEffect(() => {
    if (!accountKey) return;
    let cancelled = false;
    const load = () => { void fetch(`/api/ads/playbook?accountKey=${encodeURIComponent(accountKey)}&count=1`).then((r) => (r.ok ? r.json() : null)).then((j: { review?: number } | null) => { if (!cancelled && j) setState({ key: accountKey, n: j.review ?? 0 }); }).catch(() => undefined); };
    load();
    window.addEventListener(PLAYBOOK_CHANGED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(PLAYBOOK_CHANGED_EVENT, load); };
  }, [accountKey]);
  return state.key === accountKey ? state.n : 0;
}

export function PlaybookPanel({ accountKey, query, clientName }: { accountKey: string; query: AdsQuery | null; clientName: string | null }) {
  const [data, setData] = useState<{ key: string; saved: PlaybookEntry[]; review: PlaybookEntry[] } | null>(null);
  const [tab, setTab] = useState<"review" | "saved" | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"add" | "propose" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/ads/playbook?accountKey=${encodeURIComponent(accountKey)}`, { cache: "no-store" });
    if (r.ok) { const j = (await r.json()) as { saved: PlaybookEntry[]; review: PlaybookEntry[] }; setData({ key: accountKey, ...j }); }
  }, [accountKey]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const current = data && data.key === accountKey ? data : null;
  // Motion opens « To Review » when there is something to review.
  const shown = tab ?? (current?.review.length ? "review" : "saved");

  async function add() {
    if (!title.trim()) return;
    setBusy("add"); setError(null);
    const err = await addEntry({ accountKey, title: title.trim(), userNote: note.trim(), source: "manual" });
    setBusy(null);
    if (err) { setError(err); return; }
    setTitle(""); setNote(""); setTab("saved"); void load();
  }
  async function propose() {
    if (!query) return;
    setBusy("propose"); setError(null);
    try {
      const r = await fetch("/api/ads/playbook/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, accountKey }) });
      const j = (await r.json().catch(() => ({}))) as { created?: number; error?: string };
      if (!r.ok) throw new Error(j.error ?? `Erreur ${r.status}`);
      changed(); setTab("review"); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Proposition impossible"); } finally { setBusy(null); }
  }
  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/ads/playbook/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    changed(); void load();
  }
  async function remove(e: PlaybookEntry) {
    if (!confirm(`Supprimer « ${e.title} » du playbook ?`)) return;
    await fetch(`/api/ads/playbook/${e.id}`, { method: "DELETE" });
    changed(); void load();
  }

  const list = shown === "review" ? current?.review ?? [] : current?.saved ?? [];
  return (
    <div className="px-6 pb-10">
      <div className="rounded-xl border border-ui-line bg-ui-card p-4 mb-5">
        <div className="flex items-center gap-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} placeholder="Un apprentissage à garder (ex. Les témoignages parents battent les visuels produit)" className="flex-1 h-9 rounded-[10px] border border-ui-line bg-ui-bg px-3 text-sm text-ui-fg placeholder:text-ui-muted" />
          <button type="button" onClick={() => void add()} disabled={!title.trim() || busy !== null} className="h-9 inline-flex items-center gap-1.5 rounded-[10px] bg-ui-inverse px-3 text-sm font-medium text-ui-on-inverse hover:opacity-90 disabled:opacity-40">{busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}Ajouter</button>
        </div>
        {title.trim() && <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Pourquoi, avec les chiffres…" className="mt-2 w-full rounded-[10px] border border-ui-line bg-ui-bg px-3 py-2 text-sm text-ui-fg placeholder:text-ui-muted resize-none" />}
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-ui-muted">Le copilote Analyse Ads lit les apprentissages enregistrés{clientName ? ` de ${clientName}` : ""} avant de répondre.</p>
          <button type="button" onClick={() => void propose()} disabled={!query || busy !== null} className={PILL} title="L'IA lit les créas des 30 derniers jours et propose des apprentissages à valider">
            {busy === "propose" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-ui-accent-ink" />}{busy === "propose" ? "L'IA lit les créas…" : "Proposer des apprentissages"}
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
      </div>

      <div className="flex items-center gap-1 border-b border-ui-line mb-4">
        {(["review", "saved"] as const).map((t) => {
          const n = t === "review" ? current?.review.length ?? 0 : current?.saved.length ?? 0;
          return (
            <button key={t} type="button" onClick={() => setTab(t)} className={`h-9 px-3 -mb-px border-b-2 text-sm inline-flex items-center gap-1.5 ${shown === t ? "border-white text-ui-fg" : "border-transparent text-ui-fg2 hover:text-ui-fg"}`}>
              {t === "review" ? "À valider" : "Enregistrées"}
              {n > 0 && <span className={`rounded-md px-1.5 text-[11px] ${t === "review" ? "bg-ui-accent-soft text-ui-accent-ink" : "bg-ui-raised text-ui-fg2"}`}>{n}</span>}
            </button>
          );
        })}
      </div>

      {!current ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-ui-fg2"><Loader2 className="w-4 h-4 animate-spin" /> Chargement du playbook…</div>
        : list.length === 0 ? (
          <div className="py-16 text-center max-w-md mx-auto">
            <BookOpen className="w-6 h-6 mx-auto text-ui-accent-ink" />
            <div className="mt-2 text-base font-medium text-ui-fg">{shown === "review" ? "Rien à valider" : "Playbook vide"}</div>
            <p className="mt-1 text-sm text-ui-fg2">{shown === "review" ? "« Proposer des apprentissages » : l'IA lit les créas des 30 derniers jours et propose ce qu'il faut retenir." : "Garde ici ce que l'équipe apprend sur les créas : à la main, depuis la fiche d'une créa ou depuis une réponse du copilote."}</p>
          </div>
        ) : (
          <div className="space-y-3">{list.map((e) => <EntryCard key={e.id} e={e} onPatch={(b) => void patch(e.id, b)} onRemove={() => void remove(e)} />)}</div>
        )}
    </div>
  );
}

/** Opens the creative of an entry in the current client's report (keeps ?client=…, drops ?tab=). */
function openCreative(ev: MouseEvent, ref: PlaybookRef) {
  if (!ref.creativeKey) return;
  ev.preventDefault();
  const u = new URL(window.location.href);
  u.searchParams.delete("tab");
  u.searchParams.set("creative", ref.creativeKey);
  window.location.assign(u.toString());
}

function EntryCard({ e, onPatch, onRemove }: { e: PlaybookEntry; onPatch: (b: Record<string, unknown>) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(e.userNote);
  const [expanded, setExpanded] = useState(false);
  const long = e.aiNote.length > 420;
  return (
    <div className="rounded-xl border border-ui-line bg-ui-card p-4 flex gap-4">
      {e.ref.imageUrl && (
        <Link href={e.ref.linkUrl ?? "#"} onClick={(ev) => openCreative(ev, e.ref)} className="shrink-0 w-16 h-20 rounded-lg overflow-hidden bg-ui-bg border border-ui-line" title={e.ref.label ?? "Ouvrir la créa"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
          <img src={e.ref.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        </Link>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-ui-fg">{e.title}</div>
            <div className="mt-0.5 text-[11px] text-ui-muted">{SOURCE_LABEL[e.source]} · {e.createdByName || "—"} · {fmtDate(e.createdAt)}{e.status === "saved" && e.source === "ai" && e.statusByName ? ` · validé par ${e.statusByName}` : ""}</div>
          </div>
          {e.status === "review" ? (
            <span className="flex items-center gap-1.5 shrink-0">
              <button type="button" onClick={() => onPatch({ status: "declined" })} className="h-8 px-2.5 inline-flex items-center gap-1 rounded-lg border border-ui-line-strong text-xs text-ui-fg2 hover:text-ui-fg"><X className="w-3.5 h-3.5" />Refuser</button>
              <button type="button" onClick={() => onPatch({ status: "saved" })} className="h-8 px-2.5 inline-flex items-center gap-1 rounded-lg bg-ui-inverse text-xs font-medium text-ui-on-inverse hover:opacity-90"><Check className="w-3.5 h-3.5" />Garder</button>
            </span>
          ) : (
            <span className="flex items-center gap-1 shrink-0 text-ui-muted">
              <button type="button" onClick={() => { setEditing((v) => !v); setNote(e.userNote); }} title="Modifier la note" className="p-1 hover:text-ui-fg"><Pencil className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={onRemove} title="Supprimer" className="p-1 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-2 flex gap-2">
            <textarea value={note} onChange={(ev) => setNote(ev.target.value)} rows={2} autoFocus className="flex-1 rounded-lg border border-ui-line bg-ui-bg px-2 py-1.5 text-sm text-ui-fg resize-none" />
            <button type="button" onClick={() => { onPatch({ userNote: note }); setEditing(false); }} className="self-end h-8 px-3 rounded-lg bg-ui-inverse text-xs font-medium text-ui-on-inverse">OK</button>
          </div>
        ) : e.userNote ? <p className="mt-2 text-sm text-ui-fg whitespace-pre-wrap">{e.userNote}</p> : null}
        {e.aiNote && (
          <div className="mt-2 rounded-lg bg-ui-bg border border-ui-line px-3 py-2 text-xs text-ui-fg2 whitespace-pre-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] text-ui-accent-ink mb-1"><Sparkles className="w-3 h-3" />{e.source === "copilot" ? "Réponse du copilote" : "Note de l'IA"}</span>
            <div>{long && !expanded ? `${e.aiNote.slice(0, 420)}…` : e.aiNote}</div>
            {long && <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 text-[11px] text-ui-muted hover:text-ui-fg">{expanded ? "Réduire" : "Tout lire"}</button>}
          </div>
        )}
        {e.ref.label && e.ref.linkUrl && <Link href={e.ref.linkUrl} onClick={(ev) => openCreative(ev, e.ref)} className="mt-2 inline-flex items-center gap-1 text-[11px] text-ui-muted hover:text-ui-fg"><ExternalLink className="w-3 h-3" />{e.ref.label}</Link>}
      </div>
    </div>
  );
}
