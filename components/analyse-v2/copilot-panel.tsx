"use client";

/**
 * Copilot panel of Analyse Ads: a chat pinned to the right that reads the
 * report on screen. Replies are DETACHED (lib/ai-jobs): the consultant can
 * leave the page, the answer keeps coming, the global notice says when it is
 * ready, and the thread (one per consultant and client) is reloaded on return.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, Square, X } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import { COPILOT_SUGGESTIONS } from "@/lib/ads-warehouse/copilot";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { AI_JOB_STARTED_EVENT, followJob, stopJob, type JobEvent } from "@/lib/ai-job-client";

interface Msg { role: "user" | "assistant"; content: string; at?: string }

interface Props {
  query: AdsQuery;
  accountKey: string;
  clientParam: string | null;
  groupLabel: string;
  clientName: string | null;
  initialPrompt: string | null;
  onClose: () => void;
}

export function CopilotPanel({ query, accountKey, clientParam, groupLabel, clientName, initialPrompt, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [run, setRun] = useState<{ jobId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const follower = useRef<AbortController | null>(null);
  const sentInitial = useRef<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/ads/copilot?accountKey=${encodeURIComponent(accountKey)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { threadId: string | null; messages: Msg[]; jobId: string | null };
    setMessages(j.messages ?? []);
    setLoaded(true);
    return j;
  }, [accountKey]);

  const follow = useCallback((jobId: string) => {
    follower.current?.abort();
    const ctl = new AbortController();
    follower.current = ctl;
    setRun({ jobId, text: "" });
    const onEvent = (e: JobEvent) => {
      if (e.type === "job") return;
      setRun((r) => {
        if (!r || r.jobId !== jobId) return r;
        if (e.type === "delta" && typeof e.text === "string") return { ...r, text: r.text + e.text };
        if (e.type === "content" && typeof e.text === "string" && !r.text) return { ...r, text: e.text };
        if (e.type === "error" && e.message) return { ...r, text: `${r.text}\n\n**Erreur :** ${e.message}` };
        return r;
      });
    };
    void followJob(jobId, onEvent, ctl.signal).then(async (outcome) => {
      if (outcome === "aborted") return;
      follower.current = null;
      setRun(null);
      await load().catch(() => undefined);
    }).catch((e) => { follower.current = null; setRun(null); setError(e instanceof Error ? e.message : "Suivi interrompu"); });
  }, [load]);

  // Thread + a reply still running (we left the page while it was answering).
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { void load().then((j) => { if (!cancelled && j?.jobId) follow(j.jobId); }).catch(() => undefined); });
    return () => { cancelled = true; follower.current?.abort(); follower.current = null; };
  }, [load, follow]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || run) return;
    setError(null);
    setMessages((m) => [...m, { role: "user", content: t, at: new Date().toISOString() }]);
    setInput("");
    try {
      const res = await fetch("/api/ads/copilot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, accountKey, clientParam, message: t, groupLabel, clientName }) });
      const j = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (res.status === 409 && j.jobId) { follow(j.jobId); return; }
      if (!res.ok || !j.jobId) throw new Error(j.error ?? `Erreur ${res.status}`);
      window.dispatchEvent(new Event(AI_JOB_STARTED_EVENT));
      follow(j.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le copilote n'a pas démarré");
    }
  }, [query, accountKey, clientParam, groupLabel, clientName, run, follow]);

  useEffect(() => {
    if (loaded && initialPrompt && sentInitial.current !== initialPrompt) { sentInitial.current = initialPrompt; queueMicrotask(() => { void send(initialPrompt); }); }
  }, [loaded, initialPrompt, send]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, run?.text]);

  return (
    <aside className="fixed right-0 top-12 bottom-0 z-40 w-[400px] max-w-[92vw] border-l border-gray-800 bg-gray-950 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-white"><Sparkles className="w-4 h-4 text-violet-300" /> Copilote</div>
        <button type="button" onClick={onClose} className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-500 border-b border-gray-800">Il lit le rapport affiché : {clientName ?? "ce client"}, {query.range.since} → {query.range.until}, par {groupLabel.toLowerCase()}. Tu peux changer de page pendant qu&apos;il répond : la réponse t&apos;attendra ici.</div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {!loaded && <div className="text-xs text-gray-500 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Chargement…</div>}
        {loaded && messages.length === 0 && !run && (
          <div className="space-y-1.5">
            {COPILOT_SUGGESTIONS.filter((s) => s.prompt).map((s) => <button key={s.id} type="button" onClick={() => send(s.prompt)} className="w-full text-left rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-300 hover:border-violet-500/50 hover:text-white">{s.label}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={`rounded-xl px-3 py-2 text-xs max-w-[95%] ${m.role === "user" ? "bg-violet-600 text-white" : "bg-gray-900 border border-gray-800 text-gray-200"}`}>
              {m.role === "user" ? <span className="whitespace-pre-wrap">{m.content}</span> : <AiMarkdown content={m.content} filesBase={null} className="prose-xs" />}
            </div>
          </div>
        ))}
        {run && (
          <div className="rounded-xl px-3 py-2 text-xs bg-gray-900 border border-violet-900/60 text-gray-200">
            {run.text ? <AiMarkdown content={run.text} filesBase={null} className="prose-xs" /> : <span className="inline-flex items-center gap-2 text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Le copilote lit le rapport…</span>}
          </div>
        )}
        {error && <div className="rounded-xl px-3 py-2 text-xs bg-red-950/60 border border-red-900 text-red-200">{error}</div>}
        <div ref={endRef} />
      </div>
      <form className="p-3 border-t border-gray-800 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} rows={2} placeholder="Pose une question sur ce rapport…" className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-500 resize-none" />
        {run ? (
          <button type="button" onClick={() => void stopJob(run.jobId).catch(() => undefined)} className="rounded-lg bg-gray-800 hover:bg-gray-700 p-2 text-gray-200" aria-label="Arrêter" title="Arrêter la réponse"><Square className="w-4 h-4" /></button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="rounded-lg bg-violet-600 hover:bg-violet-500 p-2 text-white disabled:opacity-50" aria-label="Envoyer"><Send className="w-4 h-4" /></button>
        )}
      </form>
    </aside>
  );
}
