"use client";

/**
 * Agents IA (Motion's AI agent workflows): a catalog of analyses the AI runs
 * on the client's account (AgentsPanel, ?tab=agents) or on one creative
 * (CreativeAgents, in the creative's sheet). A run answers in sections the
 * team scores 👍 / 👎, keeps in the playbook, and questions further.
 */

import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, MessageSquare, Play, Send, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import { AGENT_BY_KEY, AGENT_WORKFLOWS, type AgentRunView, type AgentScope } from "@/lib/ads-warehouse/agents-catalog";
import { AddToPlaybook } from "./playbook";

const when = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function useRuns(accountKey: string, creativeKey?: string) {
  const [runs, setRuns] = useState<AgentRunView[] | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/ads/agents?accountKey=${encodeURIComponent(accountKey)}${creativeKey ? `&creativeKey=${encodeURIComponent(creativeKey)}` : ""}`, { cache: "no-store" });
    if (r.ok) setRuns(((await r.json()) as { runs: AgentRunView[] }).runs);
  }, [accountKey, creativeKey]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  return { runs, setRuns, load };
}

/** The catalog of one scope + launching (one run at a time). */
function Launcher({ scope, accountKey, query, creativeKey, onDone }: { scope: AgentScope; accountKey: string; query: AdsQuery | null; creativeKey?: string; onDone: (run: AgentRunView) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(workflow: string) {
    if (!query || busy) return;
    setBusy(workflow); setError(null);
    try {
      const r = await fetch("/api/ads/agents/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, accountKey, workflow, creativeKey, input }) });
      const j = (await r.json().catch(() => ({}))) as { run?: AgentRunView; error?: string };
      if (!r.ok || !j.run) throw new Error(j.error ?? `Erreur ${r.status}`);
      setInput(""); setOpen(null); onDone(j.run);
    } catch (e) { setError(e instanceof Error ? e.message : "Échec de l'agent"); } finally { setBusy(null); }
  }
  const list = AGENT_WORKFLOWS.filter((w) => w.scope === scope);
  return (
    <div>
      <div className={scope === "account" ? "grid grid-cols-1 md:grid-cols-3 gap-3" : "space-y-2"}>
        {list.map((w) => (
          <div key={w.key} className={`rounded-xl border bg-ui-card p-4 ${open === w.key ? "border-ui-accent" : "border-ui-line"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-ui-fg flex items-center gap-1.5"><Bot className="w-4 h-4 text-ui-accent-ink" />{w.title}</div>
                <div className="mt-1 text-xs text-ui-fg2">{w.description}</div>
              </div>
              {open !== w.key && <button type="button" disabled={!!busy || !query} onClick={() => { setOpen(w.key); setInput(""); setError(null); }} className="shrink-0 h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-ui-inverse text-xs font-medium text-ui-on-inverse disabled:opacity-40"><Play className="w-3.5 h-3.5" />Lancer</button>}
            </div>
            {open === w.key && (
              <div className="mt-3 space-y-2">
                <input value={input} onChange={(e) => setInput(e.target.value)} disabled={!!busy} placeholder={`Consigne (optionnel). ${w.inputHint}`} className="w-full h-8 rounded-lg border border-ui-line bg-ui-bg px-2 text-sm text-ui-fg placeholder:text-ui-muted" onKeyDown={(e) => { if (e.key === "Enter") void run(w.key); }} />
                <div className="flex items-center justify-end gap-2">
                  {busy === w.key ? <span className="text-xs text-ui-fg2 inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />L&apos;agent lit les données… (environ 1 min)</span> : <>
                    <button type="button" onClick={() => setOpen(null)} className="h-8 px-3 rounded-lg border border-ui-line-strong text-xs text-ui-fg2">Annuler</button>
                    <button type="button" onClick={() => void run(w.key)} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-ui-accent text-xs font-medium text-ui-on-accent"><Play className="w-3.5 h-3.5" />Lancer l&apos;agent</button>
                  </>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
    </div>
  );
}

/** A finished (or failed) run: sections with scores, playbook, follow-ups. */
export function RunView({ run, accountKey, onChange, onDelete }: { run: AgentRunView; accountKey: string; onChange: (r: AgentRunView) => void; onDelete: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wf = AGENT_BY_KEY[run.workflow];
  async function score(section: number, value: 1 | -1) {
    const next = run.scores[String(section)] === value ? 0 : value;
    const r = await fetch(`/api/ads/agents/${run.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountKey, score: { section, value: next } }) });
    if (r.ok) onChange(((await r.json()) as { run: AgentRunView }).run);
  }
  async function ask() {
    const prompt = q.trim();
    if (prompt.length < 3 || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/ads/agents/${run.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountKey, prompt }) });
      const j = (await r.json().catch(() => ({}))) as { run?: AgentRunView; error?: string };
      if (!r.ok || !j.run) throw new Error(j.error ?? `Erreur ${r.status}`);
      setQ(""); onChange(j.run);
    } catch (e) { setError(e instanceof Error ? e.message : "Question impossible"); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm("Supprimer cette analyse ?")) return;
    const r = await fetch(`/api/ads/agents/${run.id}?accountKey=${encodeURIComponent(accountKey)}`, { method: "DELETE" });
    if (r.ok) onDelete();
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-medium text-ui-fg">{wf?.title ?? run.workflow}</div>
          <div className="text-xs text-ui-muted">{run.label}{run.label ? " · " : ""}{when(run.createdAt)}{run.createdByName ? ` · ${run.createdByName}` : ""}</div>
          {run.input && <div className="mt-1 text-xs text-ui-fg2">Consigne : {run.input}</div>}
        </div>
        <button type="button" onClick={() => void remove()} title="Supprimer l'analyse" className="p-1.5 text-ui-muted hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
      </div>
      {run.status === "running" && <div className="py-10 text-center text-sm text-ui-fg2"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Analyse en cours…</div>}
      {run.status === "error" && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{run.error || "L'agent a échoué."}</div>}
      {run.sections.map((s, i) => (
        <div key={i} className="rounded-xl border border-ui-line bg-ui-card p-4">
          <div className="text-sm font-medium text-ui-fg">{s.title}</div>
          <div className="mt-1.5 text-sm text-ui-fg whitespace-pre-wrap leading-relaxed">{s.body}</div>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" title="Utile" onClick={() => void score(i, 1)} className={`p-1 rounded ${run.scores[String(i)] === 1 ? "text-emerald-300" : "text-ui-muted hover:text-ui-fg"}`}><ThumbsUp className="w-3.5 h-3.5" /></button>
            <button type="button" title="Pas utile" onClick={() => void score(i, -1)} className={`p-1 rounded ${run.scores[String(i)] === -1 ? "text-red-300" : "text-ui-muted hover:text-ui-fg"}`}><ThumbsDown className="w-3.5 h-3.5" /></button>
            <AddToPlaybook compact accountKey={accountKey} source="copilot" defaultTitle={s.title.slice(0, 140)} aiNote={s.body} refInfo={run.creativeKey ? { creativeKey: run.creativeKey, label: run.label, linkUrl: `/analyse?creative=${encodeURIComponent(run.creativeKey)}` } : undefined} />
          </div>
        </div>
      ))}
      {run.followups.map((f, i) => (
        <div key={i} className="rounded-xl border border-ui-line bg-ui-bg p-4 space-y-2">
          <div className="text-sm text-ui-accent-ink flex gap-2"><MessageSquare className="w-4 h-4 shrink-0 mt-0.5" />{f.prompt}</div>
          <div className="text-sm text-ui-fg whitespace-pre-wrap leading-relaxed">{f.answer}</div>
          <div className="text-[11px] text-ui-muted">{f.by}{f.by ? " · " : ""}{when(f.at)}</div>
        </div>
      ))}
      {run.status === "done" && (
        <div>
          <div className="flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} placeholder="Une question sur cette analyse ? (ex. détaille l'itération 2)" className="flex-1 h-9 rounded-lg border border-ui-line bg-ui-card px-3 text-sm text-ui-fg placeholder:text-ui-muted" />
            <button type="button" onClick={() => void ask()} disabled={busy || q.trim().length < 3} className="h-9 px-3 inline-flex items-center gap-1.5 rounded-lg bg-ui-inverse text-sm font-medium text-ui-on-inverse disabled:opacity-40">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}Demander</button>
          </div>
          {error && <div className="mt-1 text-xs text-red-300">{error}</div>}
        </div>
      )}
    </div>
  );
}

function History({ runs, selected, onSelect }: { runs: AgentRunView[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <ul className="space-y-1">
      {runs.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onSelect(r.id)} className={`w-full text-left rounded-lg px-3 py-2 ${selected === r.id ? "bg-ui-raised" : "hover:bg-ui-raised"}`}>
            <div className="text-sm text-ui-fg truncate flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.status === "done" ? "bg-emerald-400" : r.status === "error" ? "bg-red-400" : "bg-amber-400"}`} />
              {AGENT_BY_KEY[r.workflow]?.title ?? r.workflow}
            </div>
            <div className="text-[11px] text-ui-muted truncate">{r.label || "—"} · {when(r.createdAt)}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** ?tab=agents: account agents + every run of the client. */
export function AgentsPanel({ accountKey, query, clientName }: { accountKey: string; query: AdsQuery | null; clientName: string | null }) {
  const { runs, setRuns } = useRuns(accountKey);
  const [selected, setSelected] = useState<string | null>(null);
  const current = runs?.find((r) => r.id === selected) ?? null;
  const upsert = (r: AgentRunView) => setRuns((list) => [r, ...(list ?? []).filter((x) => x.id !== r.id)]);
  return (
    <div className="px-6 pb-10 space-y-6">
      <div>
        <div className="mb-2 text-xs text-ui-muted">Agents sur le compte{clientName ? ` ${clientName}` : ""} (30 derniers jours comparés aux 30 d&apos;avant, playbook et glossaire du client). Pour une créa précise : ouvre-la, onglet « Agents IA ».</div>
        <Launcher scope="account" accountKey={accountKey} query={query} onDone={(r) => { upsert(r); setSelected(r.id); }} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <div>
          <div className="mb-2 text-xs font-medium text-ui-fg2">Historique</div>
          {runs === null ? <Loader2 className="w-4 h-4 animate-spin text-ui-muted" /> : runs.length ? <History runs={runs} selected={current?.id ?? null} onSelect={setSelected} /> : <div className="text-xs text-ui-muted">Aucune analyse pour ce client.</div>}
        </div>
        <div>{current ? <RunView key={current.id} run={current} accountKey={accountKey} onChange={upsert} onDelete={() => { setRuns((l) => (l ?? []).filter((x) => x.id !== current.id)); setSelected(null); }} /> : runs?.length ? <div className="py-10 text-center text-sm text-ui-muted">Choisis une analyse dans l&apos;historique, ou lance un agent.</div> : null}</div>
      </div>
    </div>
  );
}

/** « Agents IA » tab of a creative's sheet. */
export function CreativeAgents({ accountKey, query, creativeKey }: { accountKey: string | null; query: AdsQuery; creativeKey: string }) {
  if (!accountKey) return <div className="py-16 text-center text-sm text-ui-fg2">Choisis un client pour lancer un agent.</div>;
  return <CreativeAgentsInner accountKey={accountKey} query={query} creativeKey={creativeKey} />;
}

function CreativeAgentsInner({ accountKey, query, creativeKey }: { accountKey: string; query: AdsQuery; creativeKey: string }) {
  const { runs, setRuns } = useRuns(accountKey, creativeKey);
  const [selected, setSelected] = useState<string | null>(null);
  const current = runs?.find((r) => r.id === selected) ?? null;
  const upsert = (r: AgentRunView) => setRuns((list) => [r, ...(list ?? []).filter((x) => x.id !== r.id)]);
  if (current) return (
    <div className="space-y-3">
      <button type="button" onClick={() => setSelected(null)} className="text-xs text-ui-fg2 hover:text-ui-fg">← Agents de la créa</button>
      <RunView key={current.id} run={current} accountKey={accountKey} onChange={upsert} onDelete={() => { setRuns((l) => (l ?? []).filter((x) => x.id !== current.id)); setSelected(null); }} />
    </div>
  );
  return (
    <div className="space-y-5">
      <Launcher scope="creative" accountKey={accountKey} query={query} creativeKey={creativeKey} onDone={(r) => { upsert(r); setSelected(r.id); }} />
      {!!runs?.length && <div><div className="mb-2 text-xs font-medium text-ui-fg2">Analyses de cette créa</div><History runs={runs} selected={null} onSelect={setSelected} /></div>}
    </div>
  );
}
