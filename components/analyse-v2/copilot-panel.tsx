"use client";

/**
 * Copilot panel of Analyse Ads: a chat pinned to the right that reads the
 * report currently on screen (the server rebuilds the same query). Opens
 * from the suggestion chips under the filters or from the "Copilote" button.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, X } from "lucide-react";
import type { AdsQuery } from "@/lib/ads-warehouse/query";
import { COPILOT_SUGGESTIONS } from "@/lib/ads-warehouse/copilot";
import { AiMarkdown } from "@/components/ai/ai-markdown";

interface Msg { role: "user" | "assistant"; content: string; error?: boolean }

interface Props {
  query: AdsQuery;
  groupLabel: string;
  clientName: string | null;
  initialPrompt: string | null;
  onClose: () => void;
}

export function CopilotPanel({ query, groupLabel, clientName, initialPrompt, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef<string | null>(null);

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: t }];
    setMessages(next); setInput(""); setBusy(true);
    try {
      const res = await fetch("/api/ads/copilot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...query, accounts: query.accountIds.map((id) => ({ platform: "meta", id })), messages: next.map((m) => ({ role: m.role, content: m.content })), groupLabel, clientName }) });
      const j = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
      if (!res.ok || !j.reply) throw new Error(j.error ?? `Erreur ${res.status}`);
      setMessages((m) => [...m, { role: "assistant", content: j.reply! }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Le copilote n'a pas répondu : ${e instanceof Error ? e.message : "erreur"}`, error: true }]);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (initialPrompt && sentInitial.current !== initialPrompt) { sentInitial.current = initialPrompt; void send(initialPrompt); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per suggestion
  }, [initialPrompt]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  return (
    <aside className="w-[380px] shrink-0 border-l border-gray-800 bg-gray-950 flex flex-col h-[calc(100vh-56px)] sticky top-14">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-white"><Sparkles className="w-4 h-4 text-violet-300" /> Copilote</div>
        <button type="button" onClick={onClose} className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-gray-800" aria-label="Fermer"><X className="w-4 h-4" /></button>
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-500 border-b border-gray-800">Il lit le rapport affiché : {clientName ?? "ce compte"}, {query.range.since} → {query.range.until}, par {groupLabel.toLowerCase()}. Change un filtre et repose ta question, il suit.</div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !busy && (
          <div className="space-y-1.5">
            {COPILOT_SUGGESTIONS.filter((s) => s.prompt).map((s) => <button key={s.id} type="button" onClick={() => send(s.prompt)} className="w-full text-left rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-300 hover:border-violet-500/50 hover:text-white">{s.label}</button>)}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={`rounded-xl px-3 py-2 text-xs max-w-[95%] ${m.role === "user" ? "bg-violet-600 text-white" : m.error ? "bg-red-950/60 border border-red-900 text-red-200" : "bg-gray-900 border border-gray-800 text-gray-200"}`}>
              {m.role === "user" ? <span className="whitespace-pre-wrap">{m.content}</span> : <AiMarkdown content={m.content} filesBase={null} className="prose-xs" />}
            </div>
          </div>
        ))}
        {busy && <div className="inline-flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Le copilote lit le rapport…</div>}
        <div ref={endRef} />
      </div>
      <form className="p-3 border-t border-gray-800 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} rows={2} placeholder="Pose une question sur ce rapport…" className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-500 resize-none" />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-violet-600 hover:bg-violet-500 p-2 text-white disabled:opacity-50" aria-label="Envoyer"><Send className="w-4 h-4" /></button>
      </form>
    </aside>
  );
}
