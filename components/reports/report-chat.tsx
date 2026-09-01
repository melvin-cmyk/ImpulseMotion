"use client";

/**
 * Q&A drawer on a report. The assistant reads the report's frozen snapshot
 * (server-side prompt). Threads persist on the report (PATCH { chat }).
 * "Ajouter au rapport" appends an answer under "## Compléments".
 */

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ChatMessage { role: "user" | "assistant"; content: string }

const SUGGESTIONS = [
  "Quelles sont les 3 créas à couper cette semaine et pourquoi ?",
  "Explique la variation du CPA par rapport à la période précédente.",
  "Rédige un mail de 5 lignes au client qui résume ce rapport.",
  "Quel budget recommandes-tu pour le mois prochain ?",
];

export function ReportChat({
  reportId,
  initial,
  onClose,
  onAppended,
}: {
  reportId: string;
  initial: ChatMessage[];
  onClose: () => void;
  onAppended: (md: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appendingIdx, setAppendingIdx] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function persist(next: ChatMessage[]) {
    try {
      await fetch(`/api/reports/${reportId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: next.slice(-60) }),
      });
    } catch { /* best effort */ }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);
    setStreamText("");
    setToolNote(null);

    const ctl = new AbortController();
    abortRef.current = ctl;
    let acc = "";
    let sawDone = false;
    try {
      const res = await fetch(`/api/reports/${reportId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-30) }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Erreur ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          let event: { type?: string; text?: string; name?: string; message?: string };
          try { event = JSON.parse(trimmed.slice(6)); } catch { continue; }
          if (event.type === "delta" && typeof event.text === "string") { acc += event.text; setStreamText(acc); }
          else if (event.type === "content" && typeof event.text === "string" && !acc) { acc = event.text; setStreamText(acc); }
          else if (event.type === "tool_call") setToolNote(`Consulte ${String(event.name ?? "un outil").replace(/^mcp__[^_]+(?:-[^_]+)*__/, "")}…`);
          else if (event.type === "tool_result") setToolNote(null);
          else if (event.type === "done") sawDone = true;
          else if (event.type === "error") {
            if (!acc.trim()) throw new Error(String(event.message ?? "Erreur IA"));
            setError(String(event.message ?? "Erreur IA"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide — réessayez");
      const final: ChatMessage[] = [...next, { role: "assistant", content: acc.trim() + (sawDone ? "" : "\n\n_(réponse possiblement tronquée)_") }];
      setMessages(final);
      void persist(final);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Erreur");
      setMessages(messages);
      setInput(content);
    } finally {
      setBusy(false);
      setStreamText(null);
      setToolNote(null);
      abortRef.current = null;
    }
  }

  async function append(idx: number) {
    const msg = messages[idx];
    if (!msg || msg.role !== "assistant") return;
    setAppendingIdx(idx);
    try {
      const question = messages[idx - 1]?.role === "user" ? messages[idx - 1].content : null;
      const md = question ? `**${question}**\n\n${msg.content}` : msg.content;
      const res = await fetch(`/api/reports/${reportId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appendMd: md }),
      });
      const j = await res.json();
      if (res.ok && j.report?.contentMd) onAppended(j.report.contentMd);
    } finally {
      setAppendingIdx(null);
    }
  }

  return (
    <aside className="fixed right-0 top-12 bottom-0 z-40 w-full sm:w-[440px] bg-gray-950 border-l border-gray-800 flex flex-col animate-im-slide-right print:hidden">
      <header className="h-11 px-4 flex items-center justify-between border-b border-gray-800 shrink-0">
        <div className="text-sm font-semibold text-white">✦ Chat sur ce rapport</div>
        <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-sm" aria-label="Fermer">✕</button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && streamText === null && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">Posez une question sur les chiffres de ce rapport. L&apos;IA lit le même snapshot de données que le rapport.</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="block w-full text-left text-xs px-3 py-2 rounded-lg bg-gray-900 border border-gray-800 text-gray-300 hover:border-violet-500 hover:text-white transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="max-w-[85%] bg-violet-600 text-white text-sm px-3 py-2 rounded-2xl rounded-br-sm whitespace-pre-wrap">{m.content}</div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl rounded-bl-sm px-3 py-2">
                <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-table:text-xs">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    disabled={appendingIdx === i}
                    onClick={() => append(i)}
                    className="text-[11px] text-violet-300 hover:text-white disabled:opacity-50"
                  >
                    {appendingIdx === i ? "Ajout…" : "+ Ajouter au rapport"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        {streamText !== null && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl rounded-bl-sm px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
            {streamText || <span className="text-gray-500">{toolNote ?? "Réflexion…"}</span>}
            {streamText && toolNote && <div className="text-[11px] text-gray-500 mt-1">{toolNote}</div>}
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        className="border-t border-gray-800 p-3 flex gap-2 shrink-0"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
          rows={2}
          placeholder="Votre question…"
          className="flex-1 resize-none bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-violet-500"
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()} className="px-3 rounded-lg bg-gray-800 text-gray-300 text-sm">Stop</button>
        ) : (
          <button type="submit" disabled={!input.trim()} className="px-3 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm font-semibold">Envoyer</button>
        )}
      </form>
    </aside>
  );
}
