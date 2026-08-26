"use client";

/**
 * Consultant copilot panel on /d/[id] (staff only).
 *
 * The AI streams a reply and proposes dashboard changes as ```action blocks;
 * each proposal renders as a card with Appliquer / Refuser. Applying goes
 * through the regular widget CRUD APIs (validation + ACL server-side) — the
 * AI itself never writes anything.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMessage { role: "user" | "assistant"; content: string }

interface Proposal {
  key: string;
  action: Record<string, unknown>;
  status: "pending" | "applying" | "applied" | "refused" | "failed";
  error?: string;
}

const ACTION_RE = /```action\s*\n([\s\S]*?)```/g;

function extractProposals(content: string, msgIndex: number): Proposal[] {
  const proposals: Proposal[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  ACTION_RE.lastIndex = 0;
  while ((m = ACTION_RE.exec(content))) {
    try {
      const action = JSON.parse(m[1]);
      if (action && typeof action === "object" && typeof action.action === "string") {
        proposals.push({ key: `${msgIndex}-${i}`, action, status: "pending" });
      }
    } catch { /* ignore malformed blocks */ }
    i++;
  }
  return proposals;
}

function proposalLabel(action: Record<string, unknown>): string {
  switch (action.action) {
    case "add_widget":
      return `Ajouter un widget ${action.type}${action.title ? ` « ${action.title} »` : ""}`;
    case "update_widget":
      return `Modifier le widget ${String(action.widgetId ?? "").slice(0, 8)}…`;
    case "remove_widget":
      return `Supprimer le widget ${String(action.widgetId ?? "").slice(0, 8)}…`;
    case "reorder":
      return "Réorganiser les widgets";
    default:
      return `Action inconnue : ${String(action.action)}`;
  }
}

export function CopilotPanel({
  dashboardId, onApplied, onClose,
}: {
  dashboardId: string;
  onApplied: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/dashboards/${dashboardId}/assistant`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((j) => {
        const msgs: ChatMessage[] = Array.isArray(j.messages) ? j.messages : [];
        setMessages(msgs);
        const all: Record<string, Proposal> = {};
        msgs.forEach((m, i) => {
          if (m.role === "assistant") {
            // history proposals default to refused-state (no re-apply from stale context)
            extractProposals(m.content, i).forEach((p) => { all[p.key] = { ...p, status: "refused" }; });
          }
        });
        setProposals(all);
      })
      .catch(() => {});
  }, [dashboardId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const persist = useCallback((msgs: ChatMessage[]) => {
    fetch(`/api/dashboards/${dashboardId}/assistant`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs.slice(-40) }),
    }).catch(() => {});
  }, [dashboardId]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setToolNote(null);
    const next: ChatMessage[] = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
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
          let event: Record<string, unknown>;
          try { event = JSON.parse(trimmed.slice(6)); } catch { continue; }
          if (event.type === "delta" && typeof event.text === "string") {
            acc += event.text;
            setStreamText(acc);
          } else if (event.type === "content" && typeof event.text === "string" && !acc) {
            acc = event.text;
            setStreamText(acc);
          } else if (event.type === "tool_call") {
            setToolNote(`Outil : ${String(event.name ?? "…")}`);
          } else if (event.type === "error") {
            throw new Error(String(event.message ?? "Erreur IA"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide du copilote");
      const finalMsgs: ChatMessage[] = [...next, { role: "assistant" as const, content: acc }];
      setMessages(finalMsgs);
      extractProposals(acc, finalMsgs.length - 1).forEach((p) => {
        setProposals((prev) => ({ ...prev, [p.key]: p }));
      });
      persist(finalMsgs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages(messages); // roll back the user message on failure
      setInput(text);
    } finally {
      setBusy(false);
      setStreamText(null);
      setToolNote(null);
    }
  }

  async function applyProposal(p: Proposal) {
    setProposals((prev) => ({ ...prev, [p.key]: { ...p, status: "applying" } }));
    const a = p.action;
    let res: Response;
    try {
      switch (a.action) {
        case "add_widget":
          res = await fetch(`/api/dashboards/${dashboardId}/widgets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: a.type, title: a.title ?? null, width: a.width ?? "half", config: a.config ?? {} }),
          });
          break;
        case "update_widget": {
          const patch: Record<string, unknown> = {};
          if (a.title !== undefined) patch.title = a.title;
          if (a.width !== undefined) patch.width = a.width;
          if (a.config !== undefined) patch.config = a.config;
          res = await fetch(`/api/dashboards/${dashboardId}/widgets/${a.widgetId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          break;
        }
        case "remove_widget":
          res = await fetch(`/api/dashboards/${dashboardId}/widgets/${a.widgetId}`, { method: "DELETE" });
          break;
        case "reorder":
          res = await fetch(`/api/dashboards/${dashboardId}/widgets`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: a.order }),
          });
          break;
        default:
          throw new Error(`Action non supportée : ${String(a.action)}`);
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur ${res.status}`);
      }
      setProposals((prev) => ({ ...prev, [p.key]: { ...p, status: "applied" } }));
      onApplied();
    } catch (e) {
      setProposals((prev) => ({
        ...prev,
        [p.key]: { ...p, status: "failed", error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      return (
        <div key={i} className="ml-8 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200">
          {m.content}
        </div>
      );
    }
    const clean = m.content.replace(ACTION_RE, "").trim();
    const msgProposals = Object.values(proposals).filter((p) => p.key.startsWith(`${i}-`));
    return (
      <div key={i} className="mr-4 space-y-2">
        {clean && (
          <div className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{clean}</ReactMarkdown>
          </div>
        )}
        {msgProposals.map((p) => (
          <div key={p.key} className="bg-gray-900 border border-violet-800/50 rounded-xl px-3 py-2">
            <div className="text-xs font-semibold text-violet-300">{proposalLabel(p.action)}</div>
            <pre className="text-[10px] text-gray-500 mt-1 overflow-x-auto">{JSON.stringify(p.action, null, 1)}</pre>
            {p.status === "pending" || p.status === "applying" ? (
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  disabled={p.status === "applying"}
                  onClick={() => applyProposal(p)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
                >
                  {p.status === "applying" ? "Application…" : "Appliquer"}
                </button>
                <button
                  type="button"
                  onClick={() => setProposals((prev) => ({ ...prev, [p.key]: { ...p, status: "refused" } }))}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300"
                >
                  Refuser
                </button>
              </div>
            ) : (
              <div className={`text-[11px] mt-1 ${p.status === "applied" ? "text-emerald-400" : p.status === "failed" ? "text-red-400" : "text-gray-500"}`}>
                {p.status === "applied" ? "✓ Appliqué" : p.status === "failed" ? `Échec : ${p.error}` : "Refusé"}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <aside className="fixed right-0 top-12 bottom-0 w-full sm:w-[420px] bg-gray-950 border-l border-gray-800 flex flex-col z-40 shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div>
          <h2 className="text-sm font-bold text-white">Copilote IA</h2>
          <p className="text-[11px] text-gray-500">Propose des widgets — rien n&apos;est appliqué sans validation</p>
        </div>
        <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-sm">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && !streamText && (
          <div className="text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-3 py-3">
            Exemples : « Ajoute une courbe du ROAS sur 90 jours », « Passe le tableau
            Google en pleine largeur », « Que dire des perfs de ce compte ? »
          </div>
        )}
        {messages.map(renderMessage)}
        {streamText !== null && (
          <div className="mr-4 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 whitespace-pre-wrap">
            {streamText || "…"}
            {toolNote && <div className="text-[11px] text-violet-400 mt-1">{toolNote}</div>}
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className="p-3 border-t border-gray-800 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Demandez un ajout, une analyse…"
          disabled={busy}
          className="flex-1 px-3 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-white focus:border-violet-500 focus:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
        >
          {busy ? "…" : "Envoyer"}
        </button>
      </form>
    </aside>
  );
}
