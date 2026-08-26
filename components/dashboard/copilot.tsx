"use client";

/**
 * Consultant copilot panel on /d/[id] (staff only).
 *
 * The AI streams a reply and proposes dashboard changes as ```action blocks;
 * each proposal renders as a card with Appliquer / Refuser. Applying goes
 * through the regular widget CRUD APIs (validation + ACL server-side) — the
 * AI itself never writes anything.
 *
 * Reliability contract (hardened after the multi-agent review):
 * - proposals are validated client-side BEFORE showing an Appliquer button
 * - block extraction tolerates ```action, ```json and untagged fences
 * - proposal statuses persist with the thread (survive reloads)
 * - a stream that ends without a `done` event is flagged as truncated
 * - apply successes/failures are fed back to the model on the next message
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { validateWidgetConfig, validateWidgetWidth, type ResolvedWidget } from "@/lib/dashboard-types";

interface ChatMessage { role: "user" | "assistant"; content: string }

type ProposalStatus = "pending" | "applying" | "applied" | "refused" | "failed" | "invalid";

interface Proposal {
  key: string;
  action: Record<string, unknown>;
  status: ProposalStatus;
  error?: string;
}

const MAX_THREAD_MESSAGES = 40;

// Tolerant fence matcher: ```action, ```json, or bare ``` — the JSON content
// decides whether it's really a proposal.
const FENCE_RE = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g;

function parseActionBlock(inner: string): Record<string, unknown> | null {
  const text = inner.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") return parsed;
  } catch { /* not a proposal */ }
  return null;
}

/** Validate a proposal locally so a doomed Appliquer click never renders. */
function validateProposal(
  action: Record<string, unknown>,
  widgets: ResolvedWidget[],
): string | null {
  try {
    switch (action.action) {
      case "add_widget":
        validateWidgetConfig(String(action.type ?? ""), action.config ?? {});
        if (action.width !== undefined) validateWidgetWidth(action.width);
        return null;
      case "update_widget": {
        const target = widgets.find((w) => w.id === action.widgetId);
        if (!target) return `Widget introuvable: ${String(action.widgetId ?? "?")} — demandez à l'IA de relister les widgets`;
        if (action.config !== undefined) {
          validateWidgetConfig(target.type, { ...target.config, ...(action.config as Record<string, unknown>) });
        }
        return null;
      }
      case "remove_widget":
        return widgets.some((w) => w.id === action.widgetId)
          ? null
          : `Widget introuvable: ${String(action.widgetId ?? "?")}`;
      case "reorder": {
        if (!Array.isArray(action.order)) return "reorder: 'order' doit être une liste d'ids";
        const known = new Set(widgets.map((w) => w.id));
        const stale = (action.order as string[]).filter((id) => !known.has(id));
        return stale.length ? `Ids inconnus dans l'ordre: ${stale.join(", ")}` : null;
      }
      default:
        return `Action inconnue: ${String(action.action)}`;
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function extractProposals(content: string, msgIndex: number): Array<{ key: string; action: Record<string, unknown> }> {
  const out: Array<{ key: string; action: Record<string, unknown> }> = [];
  let m: RegExpExecArray | null;
  let i = 0;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(content))) {
    const action = parseActionBlock(m[1]);
    if (action) out.push({ key: `${msgIndex}-${i}`, action });
    i++;
  }
  return out;
}

/** Strip only the fences that parsed as proposals — malformed blocks stay
 *  visible as text instead of vanishing. */
function stripProposalBlocks(content: string): string {
  return content.replace(FENCE_RE, (full, inner) => (parseActionBlock(inner) ? "" : full)).trim();
}

function proposalLabel(action: Record<string, unknown>, widgets: ResolvedWidget[]): string {
  const widgetName = (id: unknown) => {
    const w = widgets.find((x) => x.id === id);
    return w ? `« ${w.title ?? w.type} »` : String(id ?? "").slice(0, 8) + "…";
  };
  switch (action.action) {
    case "add_widget":
      return `Ajouter un widget ${action.type}${action.title ? ` « ${action.title} »` : ""}`;
    case "update_widget":
      return `Modifier le widget ${widgetName(action.widgetId)}`;
    case "remove_widget":
      return `Supprimer le widget ${widgetName(action.widgetId)}`;
    case "reorder":
      return "Réorganiser les widgets";
    default:
      return `Action inconnue : ${String(action.action)}`;
  }
}

export function CopilotPanel({
  dashboardId, widgets, onApplied, onClose,
}: {
  dashboardId: string;
  widgets: ResolvedWidget[];
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
  const [truncated, setTruncated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Results of applied/refused/failed proposals, fed to the model next turn.
  const pendingNotesRef = useRef<string[]>([]);
  const busyRef = useRef(false);

  useEffect(() => {
    fetch(`/api/dashboards/${dashboardId}/assistant`)
      .then((r) => (r.ok ? r.json() : { messages: [], proposals: {} }))
      .then((j) => {
        // Never clobber a conversation already in flight in this panel.
        if (busyRef.current) return;
        const msgs: ChatMessage[] = Array.isArray(j.messages) ? j.messages : [];
        const stored: Record<string, string> = j.proposals && typeof j.proposals === "object" ? j.proposals : {};
        setMessages((current) => (current.length > 0 ? current : msgs));
        const all: Record<string, Proposal> = {};
        msgs.forEach((m, i) => {
          if (m.role !== "assistant") return;
          for (const p of extractProposals(m.content, i)) {
            const storedStatus = stored[p.key] as ProposalStatus | undefined;
            // Historic proposals without a stored status are stale — the
            // dashboard has moved on; mark them expired-as-refused.
            all[p.key] = { ...p, status: storedStatus ?? "refused" };
          }
        });
        setProposals((current) => (Object.keys(current).length > 0 ? current : all));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  const persist = useCallback((msgs: ChatMessage[], props: Record<string, Proposal>) => {
    const statuses: Record<string, string> = {};
    for (const [key, p] of Object.entries(props)) statuses[key] = p.status === "applying" ? "pending" : p.status;
    fetch(`/api/dashboards/${dashboardId}/assistant`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs.slice(-MAX_THREAD_MESSAGES), proposals: statuses }),
    }).catch(() => {});
  }, [dashboardId]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setTruncated(false);
    setBusy(true);
    busyRef.current = true;
    setToolNote(null);

    // Feed apply outcomes back so the model can correct itself.
    const notes = pendingNotesRef.current;
    pendingNotesRef.current = [];
    const content = notes.length
      ? `[Résultat des propositions précédentes : ${notes.join(" ; ")}]\n\n${text}`
      : text;

    const next: ChatMessage[] = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    let sawDone = false;
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-MAX_THREAD_MESSAGES) }),
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
          } else if (event.type === "done") {
            sawDone = true;
          } else if (event.type === "error") {
            // Keep partial text if any — surface the error alongside.
            if (!acc.trim()) throw new Error(String(event.message ?? "Erreur IA"));
            setError(String(event.message ?? "Erreur IA"));
          }
        }
      }
      if (!acc.trim()) throw new Error("Réponse vide du copilote — réessayez");
      if (!sawDone) setTruncated(true);

      const finalMsgs: ChatMessage[] = [...next, { role: "assistant" as const, content: acc }];
      setMessages(finalMsgs);
      const newProposals: Record<string, Proposal> = {};
      for (const p of extractProposals(acc, finalMsgs.length - 1)) {
        const invalid = validateProposal(p.action, widgets);
        newProposals[p.key] = invalid
          ? { ...p, status: "invalid", error: invalid }
          : { ...p, status: "pending" };
      }
      setProposals((prev) => {
        const merged = { ...prev, ...newProposals };
        persist(finalMsgs, merged);
        return merged;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessages(messages); // roll back the user message on failure
      setInput(text);
    } finally {
      setBusy(false);
      busyRef.current = false;
      setStreamText(null);
      setToolNote(null);
    }
  }

  function updateProposal(key: string, patch: Partial<Proposal>) {
    setProposals((prev) => {
      const merged = { ...prev, [key]: { ...prev[key], ...patch } };
      persist(messages, merged);
      return merged;
    });
  }

  async function applyProposal(p: Proposal) {
    updateProposal(p.key, { status: "applying" });
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
      pendingNotesRef.current.push(`"${proposalLabel(a, widgets)}" appliquée avec succès`);
      updateProposal(p.key, { status: "applied" });
      onApplied();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      pendingNotesRef.current.push(`"${proposalLabel(a, widgets)}" a ÉCHOUÉ : ${message}`);
      updateProposal(p.key, { status: "failed", error: message });
    }
  }

  function refuseProposal(p: Proposal) {
    pendingNotesRef.current.push(`"${proposalLabel(p.action, widgets)}" refusée par le consultant`);
    updateProposal(p.key, { status: "refused" });
  }

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      return (
        <div key={i} className="ml-8 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
          {m.content.replace(/^\[Résultat des propositions précédentes[^\]]*\]\n\n/, "")}
        </div>
      );
    }
    const clean = stripProposalBlocks(m.content);
    const msgProposals = Object.values(proposals).filter((p) => p.key.startsWith(`${i}-`));
    return (
      <div key={i} className="mr-4 space-y-2">
        {clean && (
          <div className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{clean}</ReactMarkdown>
          </div>
        )}
        {msgProposals.map((p) => (
          <div key={p.key} className={`bg-gray-900 border rounded-xl px-3 py-2 ${p.status === "invalid" ? "border-amber-800/60" : "border-violet-800/50"}`}>
            <div className="text-xs font-semibold text-violet-300">{proposalLabel(p.action, widgets)}</div>
            <pre className="text-[10px] text-gray-500 mt-1 overflow-x-auto">{JSON.stringify(p.action, null, 1)}</pre>
            {p.status === "invalid" ? (
              <div className="text-[11px] mt-1 text-amber-400">
                Proposition invalide : {p.error} — reformulez votre demande.
              </div>
            ) : p.status === "pending" || p.status === "applying" ? (
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
                  onClick={() => refuseProposal(p)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-gray-800 hover:bg-gray-700 text-gray-300"
                >
                  Refuser
                </button>
              </div>
            ) : (
              <div className={`text-[11px] mt-1 ${p.status === "applied" ? "text-emerald-400" : p.status === "failed" ? "text-red-400" : "text-gray-500"}`}>
                {p.status === "applied" ? "✓ Appliqué — le dashboard est à jour" : p.status === "failed" ? `Échec : ${p.error}` : "Refusé"}
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
        {truncated && (
          <div className="text-[11px] text-amber-400 bg-amber-950/30 border border-amber-900/40 rounded-lg px-3 py-2">
            La réponse a peut-être été interrompue — si une proposition manque, redemandez-la.
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
