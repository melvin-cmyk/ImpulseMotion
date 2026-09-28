"use client";

/**
 * The guide: a small chat at the bottom right that tells a consultant where
 * to go in the application (POST /api/guide). It knows the map of the app,
 * not the data — questions about figures are sent to the AI Assistant.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Loader2, RotateCcw, Send, X } from "lucide-react";

type Message = { role: "user" | "assistant"; content: string };

const STORAGE_KEY = "impulse_guide_v1";
const MAX_LENGTH = 500;
// Pages that are a chat already, or that are printed: the bubble would be in the way.
const HIDDEN = [/^\/ai(\/|$)/, /^\/bot(\/|$)/, /^\/login/, /\/print$/];
const SUGGESTIONS = [
  "Quel client traiter en priorité ?",
  "Comment générer un rapport client ?",
  "Où voir les créas qui fatiguent ?",
  "Comment relier un canal Slack aux alertes ?",
];

/** Links and bold of one line; the guide writes nothing else inline. */
function inline(text: string, onNavigate: () => void): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\((\/[^)\s]*)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[2]
      ? <Link key={m.index} href={m[2]} onClick={onNavigate} className="font-medium text-violet-300 underline underline-offset-2 hover:text-white">{m[1]}</Link>
      : <strong key={m.index} className="font-semibold text-white">{m[3]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** An answer of the guide: short paragraphs and numbered or bulleted steps. */
function Answer({ text, onNavigate }: { text: string; onNavigate: () => void }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const step = /^(\d+)[.)]\s+(.*)$/.exec(line);
        const bullet = /^[-•*]\s+(.*)$/.exec(line);
        if (step) return <p key={i} className="flex gap-2"><span className="shrink-0 font-semibold text-violet-300">{step[1]}.</span><span>{inline(step[2], onNavigate)}</span></p>;
        if (bullet) return <p key={i} className="flex gap-2"><span className="shrink-0 text-violet-300">•</span><span>{inline(bullet[1], onNavigate)}</span></p>;
        return <p key={i}>{inline(line, onNavigate)}</p>;
      })}
    </div>
  );
}

function restore(): Message[] {
  try {
    const list = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((m) => m && typeof m.content === "string").slice(-20) : [];
  } catch {
    return [];
  }
}

export function GuideBot() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // After mount only: the server has no sessionStorage.
    const t = setTimeout(() => setMessages(restore()), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-20))); } catch { /* storage unavailable */ }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (HIDDEN.some((re) => re.test(pathname ?? ""))) return null;

  async function ask(question: string) {
    const text = question.trim().slice(0, MAX_LENGTH);
    if (!text || busy) return;
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, path: pathname }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.reply) throw new Error(json.error ?? `Erreur ${res.status}`);
      setMessages([...next, { role: "assistant", content: json.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Guide indisponible");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ouvrir le guide de l'application"
        title="Besoin d'aide pour trouver une page ?"
        className="fixed bottom-5 right-5 z-50 flex h-12 items-center gap-2 rounded-full bg-violet-600 px-4 text-sm font-semibold text-white shadow-lg shadow-black/40 transition-colors hover:bg-violet-500 print:hidden"
      >
        <Compass className="h-5 w-5" />
        Guide
      </button>
    );
  }

  return (
    <section
      role="dialog"
      aria-label="Guide de l'application"
      className="fixed bottom-5 right-5 z-50 flex max-h-[min(34rem,calc(100vh-2.5rem))] w-[min(23rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/60 print:hidden"
    >
      <header className="flex items-center justify-between gap-2 border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-violet-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">Guide</h2>
            <p className="text-[11px] text-gray-500">Où aller, quoi cliquer</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button type="button" onClick={() => { setMessages([]); setError(null); }} title="Recommencer" aria-label="Recommencer la conversation" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-900 hover:text-gray-200">
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={() => setOpen(false)} title="Fermer" aria-label="Fermer le guide" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-900 hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-gray-300">Dites-moi ce que vous voulez faire, je vous indique la page et les étapes.</p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} disabled={busy} className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-left text-xs text-gray-300 hover:border-violet-500/50 hover:text-white disabled:opacity-50">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${m.role === "user" ? "bg-violet-600 text-white" : "bg-gray-900 text-gray-200"}`}>
              {m.role === "user" ? m.content : (
                <Answer text={m.content} onNavigate={() => setOpen(false)} />
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Je cherche la bonne page…
          </div>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void ask(input); }} className="flex items-end gap-2 border-t border-gray-800 p-3">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_LENGTH))}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
          rows={1}
          placeholder="Que voulez-vous faire ?"
          aria-label="Votre question"
          className="max-h-24 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-violet-500 focus:outline-none"
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Envoyer" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-40">
          <Send className="h-4 w-4" />
        </button>
      </form>
    </section>
  );
}
