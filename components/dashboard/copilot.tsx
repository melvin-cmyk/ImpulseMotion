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

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { validateWidgetConfig, validateWidgetWidth, type ResolvedWidget } from "@/lib/dashboard-types";

/** Image attached to a user message: base64 (no data: prefix) + its media type. */
interface ChatImage { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string; name?: string }

/** File dropped by the consultant, stored in the conversation's sandbox workspace (relay). */
interface ChatFile { name: string; path: string; bytes: number }

interface ChatMessage { role: "user" | "assistant"; content: string; images?: ChatImage[]; files?: ChatFile[] }

// Vercel caps request bodies at 4.5 MB; base64 adds a third.
const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
const UPLOAD_EXT_RE = /\.(xlsx?|xlsm|csv|tsv|txt|md|json|pdf|docx?|pptx?)$/i;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`Lecture impossible : ${file.name}`));
    reader.readAsDataURL(file);
  });
}

const MAX_IMAGES_PER_MESSAGE = 4;
// Images are downsized in the browser so a screenshot costs ~100–300 KB and
// the whole POST stays far under Vercel's 4.5 MB body limit.
const IMAGE_MAX_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.85;

/** Downscale + re-encode a picked image; PNG stays PNG only when small (screenshots with text). */
async function prepareImage(file: File): Promise<ChatImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Image illisible : ${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas indisponible");
    ctx.drawImage(img, 0, 0, w, h);
    const keepPng = file.type === "image/png" && file.size <= 600_000 && scale === 1;
    const mediaType: ChatImage["mediaType"] = keepPng ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mediaType, IMAGE_JPEG_QUALITY);
    return { mediaType, data: dataUrl.slice(dataUrl.indexOf(",") + 1), name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ProposalStatus = "pending" | "applying" | "applied" | "refused" | "failed" | "invalid";

interface Proposal {
  key: string;
  action: Record<string, unknown>;
  status: ProposalStatus;
  error?: string;
}

const MAX_THREAD_MESSAGES = 40;

type CopilotModel = "sonnet" | "opus";
type CopilotEffort = "low" | "medium" | "high";
const MODEL_OPTIONS: Array<{ value: CopilotModel; label: string; hint: string }> = [
  { value: "opus", label: "Opus", hint: "Le plus fort pour orchestrer des analyses" },
  { value: "sonnet", label: "Sonnet", hint: "Rapide et économe" },
];
const EFFORT_OPTIONS: Array<{ value: CopilotEffort; label: string; hint: string }> = [
  { value: "low", label: "Réflexion courte", hint: "Le moins cher" },
  { value: "medium", label: "Réflexion moyenne", hint: "Bon compromis pour les analyses" },
  { value: "high", label: "Réflexion longue", hint: "Le plus fort, le plus cher" },
];
const PREFS_KEY = "copilot:prefs";

function loadPrefs(): { model: CopilotModel; effort: CopilotEffort } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        model: MODEL_OPTIONS.some((o) => o.value === p.model) ? p.model : "opus",
        effort: EFFORT_OPTIONS.some((o) => o.value === p.effort) ? p.effort : "low",
      };
    }
  } catch { /* private mode, blocked storage */ }
  return { model: "opus", effort: "low" };
}

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
  dashboardId, widgets, onApplied, onClose, sheetsShareEmail,
}: {
  dashboardId: string;
  widgets: ResolvedWidget[];
  onApplied: () => void;
  onClose: () => void;
  /** Google account the consultant must share a Sheet with (editor) so the copilot can read it. */
  sheetsShareEmail: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  const [pendingFiles, setPendingFiles] = useState<ChatFile[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<{ model: CopilotModel; effort: CopilotEffort }>({ model: "opus", effort: "low" });
  const [showSheetHelp, setShowSheetHelp] = useState(false);
  const [memorizing, setMemorizing] = useState(false);
  const [memoNote, setMemoNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => { setPrefs(loadPrefs()); }, []);

  function updatePrefs(patch: Partial<{ model: CopilotModel; effort: CopilotEffort }>) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const persist = useCallback((msgs: ChatMessage[], props: Record<string, Proposal>) => {
    const statuses: Record<string, string> = {};
    for (const [key, p] of Object.entries(props)) statuses[key] = p.status === "applying" ? "pending" : p.status;
    fetch(`/api/dashboards/${dashboardId}/assistant`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs.slice(-MAX_THREAD_MESSAGES), proposals: statuses }),
    }).catch(() => {});
  }, [dashboardId]);

  /** Files from the picker, a paste or a drop: images are downsized and sent
   *  with the message; documents (Excel, CSV, PDF, Word…) go to the
   *  conversation's sandbox workspace, where the AI reads them with Python. */
  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setError(null);
    const images = list.filter((f) => f.type.startsWith("image/"));
    const docs = list.filter((f) => !f.type.startsWith("image/") && UPLOAD_EXT_RE.test(f.name));
    const other = list.length - images.length - docs.length;
    if (other > 0) setError("Formats acceptés : images, Excel, CSV, PDF, Word, PowerPoint, texte.");
    const room = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
    if (images.length > room) setError(`${MAX_IMAGES_PER_MESSAGE} images maximum par message.`);
    const prepared: ChatImage[] = [];
    for (const f of images.slice(0, Math.max(0, room))) {
      try { prepared.push(await prepareImage(f)); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
    if (prepared.length) setPendingImages((prev) => [...prev, ...prepared].slice(0, MAX_IMAGES_PER_MESSAGE));
    for (const f of docs) {
      if (f.size > UPLOAD_MAX_BYTES) {
        setError(`${f.name} dépasse ${fmtBytes(UPLOAD_MAX_BYTES)} — pour un gros tableur, partagez-le en Google Sheet.`);
        setShowSheetHelp(true);
        continue;
      }
      setUploading(f.name);
      try {
        const data = await readAsBase64(f);
        const res = await fetch(`/api/dashboards/${dashboardId}/assistant/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, data }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
        setPendingFiles((prev) => [...prev.filter((p) => p.path !== body.path), { name: f.name, path: body.path, bytes: body.bytes }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(null);
      }
    }
  }

  /** Summarise the thread into a dated note in the client's HQ project journal. */
  async function memorize() {
    if (memorizing || busy || messages.length < 2) return;
    setMemorizing(true);
    setMemoNote(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/assistant/memorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages.slice(-MAX_THREAD_MESSAGES).map((m) => ({ role: m.role, content: m.content })) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
      setMemoNote({ ok: true, text: `Note ajoutée au journal HQ du projet « ${body.project} ».` });
      pendingNotesRef.current.push("les conclusions de la conversation ont été consignées dans le journal HQ du client");
    } catch (e) {
      setMemoNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setMemorizing(false);
    }
  }

  function copyShareEmail() {
    navigator.clipboard?.writeText(sheetsShareEmail).then(() => {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 1500);
    }).catch(() => {});
  }

  async function send() {
    const text = input.trim();
    const images = pendingImages;
    const files = pendingFiles;
    if ((!text && !images.length && !files.length) || busy || uploading) return;
    setInput("");
    setPendingImages([]);
    setPendingFiles([]);
    setError(null);
    setTruncated(false);
    setBusy(true);
    busyRef.current = true;
    setToolNote(null);

    // Feed apply outcomes back so the model can correct itself.
    const notes = pendingNotesRef.current;
    pendingNotesRef.current = [];
    const body = text || (files.length ? "Voici le(s) fichier(s), analyse-les." : images.length > 1 ? "Voici des images." : "Voici une image.");
    // Uploaded documents live in the sandbox workspace: tell the model where.
    const fileNote = files.length
      ? `\n\n[Fichiers déposés dans /work/${files.map((f) => `${f.path} (${fmtBytes(f.bytes)})`).join(", /work/")} — lis-les avec run_python]`
      : "";
    const content = (notes.length
      ? `[Résultat des propositions précédentes : ${notes.join(" ; ")}]\n\n${body}`
      : body) + fileNote;

    const next: ChatMessage[] = [...messages, { role: "user" as const, content, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) }];
    setMessages(next);
    setStreamText("");

    let acc = "";
    let sawDone = false;
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-MAX_THREAD_MESSAGES), model: prefs.model, effort: prefs.effort }),
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
      setPendingImages(images);
      setPendingFiles(files);
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
            body: JSON.stringify({ type: a.type, title: a.title ?? null, width: a.width ?? "half", config: a.config ?? {}, pageId: typeof a.pageId === "string" ? a.pageId : null }),
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

  const filesBase = `/api/dashboards/${dashboardId}/assistant/files`;

  function renderMessage(m: ChatMessage, i: number) {
    if (m.role === "user") {
      return (
        <div key={i} className="ml-8 bg-violet-950/50 border border-violet-900/40 rounded-xl px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
          {m.images && m.images.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {m.images.map((im, k) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={k}
                  src={`data:${im.mediaType};base64,${im.data}`}
                  alt={im.name ?? `Image ${k + 1}`}
                  title={im.name}
                  className="h-16 w-16 object-cover rounded-md border border-violet-900/60"
                />
              ))}
            </div>
          )}
          {m.files && m.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {m.files.map((f) => (
                <span key={f.path} className="text-[11px] px-2 py-0.5 rounded-md bg-gray-900 border border-violet-900/60 text-gray-300" title={f.path}>
                  📄 {f.name} <span className="text-gray-500">{fmtBytes(f.bytes)}</span>
                </span>
              ))}
            </div>
          )}
          {m.content.replace(/^\[Résultat des propositions précédentes[^\]]*\]\n\n/, "").replace(/\n\n\[Fichiers déposés dans [^\]]*\]$/, "")}
        </div>
      );
    }
    const clean = stripProposalBlocks(m.content);
    const msgProposals = Object.values(proposals).filter((p) => p.key.startsWith(`${i}-`));
    return (
      <div key={i} className="mr-4 space-y-2">
        {clean && (
          <div className="prose prose-invert prose-sm max-w-none text-gray-300 bg-gray-900 border border-gray-800 rounded-xl px-3 py-2">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              // `sandbox:out/x.png` → the files proxy of this dashboard (staff + scope checked server-side).
              urlTransform={(url: string) => (url.startsWith("sandbox:") ? `${filesBase}/${url.slice(8).replace(/^\/+/, "")}` : defaultUrlTransform(url))}
              components={{
                img: ({ src, alt }: { src?: string; alt?: string }) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-lg border border-gray-800 my-2" loading="lazy" />
                ),
                a: ({ href, children }: { href?: string; children?: ReactNode }) => {
                  const local = typeof href === "string" && href.startsWith(filesBase);
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer" className={local ? "inline-flex items-center gap-1 text-violet-300 hover:text-violet-200 no-underline border border-violet-900/60 rounded-md px-2 py-0.5" : undefined}>
                      {local ? "⬇ " : null}{children}
                    </a>
                  );
                },
              }}
            >
              {clean}
            </ReactMarkdown>
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
      <div className="px-4 py-3 border-b border-gray-800 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Copilote IA</h2>
            <p className="text-[11px] text-gray-500">Propose des widgets — rien n&apos;est appliqué sans validation</p>
          </div>
          <div className="flex items-center gap-2">
            {messages.length >= 2 && (
              <button
                type="button"
                onClick={memorize}
                disabled={memorizing || busy}
                title="Résume les conclusions de cette conversation dans le journal HQ du client"
                className="px-2 py-1 rounded-md text-[11px] font-semibold bg-gray-900 border border-gray-800 text-gray-300 hover:text-white hover:border-violet-700 disabled:opacity-50"
              >
                {memorizing ? "Mémorisation…" : "Mémoriser dans HQ"}
              </button>
            )}
            <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-sm">✕</button>
          </div>
        </div>
        {memoNote && (
          <div className={`text-[11px] rounded-md px-2 py-1 border ${memoNote.ok ? "text-emerald-300 bg-emerald-950/30 border-emerald-900/50" : "text-amber-300 bg-amber-950/30 border-amber-900/50"}`}>
            {memoNote.text}
          </div>
        )}
        <div className="flex gap-2" title="Changer de modèle en cours de conversation redémarre la session côté IA (l'historique est renvoyé).">
          <label className="sr-only" htmlFor="copilot-model">Modèle</label>
          <select
            id="copilot-model"
            value={prefs.model}
            disabled={busy}
            onChange={(e) => updatePrefs({ model: e.target.value as CopilotModel })}
            className="flex-1 min-w-0 px-2 py-1 rounded-md text-[11px] bg-gray-900 border border-gray-800 text-gray-300 focus:border-violet-500 focus:outline-none disabled:opacity-60"
          >
            {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
          </select>
          <label className="sr-only" htmlFor="copilot-effort">Réflexion</label>
          <select
            id="copilot-effort"
            value={prefs.effort}
            disabled={busy}
            onChange={(e) => updatePrefs({ effort: e.target.value as CopilotEffort })}
            className="flex-1 min-w-0 px-2 py-1 rounded-md text-[11px] bg-gray-900 border border-gray-800 text-gray-300 focus:border-violet-500 focus:outline-none disabled:opacity-60"
          >
            {EFFORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && !streamText && (
          <div className="text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded-xl px-3 py-3 space-y-1.5">
            <p>
              Exemples : « Ajoute une courbe du ROAS sur 90 jours », « Passe le tableau
              Google en pleine largeur », « Que dire des perfs de ce compte ? »
            </p>
            <p>
              Joignez des images, Excel, CSV, PDF ou Word avec le trombone, en les collant ou en les déposant :
              l&apos;IA les analyse avec Python et peut produire graphiques et exports.
              Un Google Sheet vivant ? Partagez-le avec <span className="text-gray-300">{sheetsShareEmail}</span> puis collez le lien.
            </p>
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
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); if (!busy) void addFiles(e.dataTransfer.files); }}
        className="p-3 border-t border-gray-800 space-y-2"
      >
        {showSheetHelp && (
          <div className="text-[11px] text-gray-300 bg-gray-900 border border-violet-900/50 rounded-lg px-3 py-2 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="font-semibold text-violet-300">Partager un Excel ou un CSV</div>
              <button type="button" onClick={() => setShowSheetHelp(false)} className="text-gray-500 hover:text-white">✕</button>
            </div>
            <ol className="list-decimal pl-4 space-y-0.5 text-gray-400">
              <li>Importez le fichier dans Google Sheets (Fichier → Importer).</li>
              <li>
                Partagez la feuille avec{" "}
                <button type="button" onClick={copyShareEmail} title="Copier l'adresse" className="font-mono text-gray-200 hover:text-white underline decoration-dotted">
                  {sheetsShareEmail}
                </button>{" "}
                en <span className="text-gray-200">Éditeur</span>.{copiedEmail && <span className="text-emerald-400"> Copié</span>}
              </li>
              <li>Collez le lien de la feuille ici, avec le nom de l&apos;onglet à lire.</li>
            </ol>
          </div>
        )}
        {(pendingFiles.length > 0 || uploading) && (
          <div className="flex flex-wrap gap-1.5">
            {pendingFiles.map((f) => (
              <span key={f.path} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-gray-900 border border-gray-700 text-gray-300">
                📄 {f.name} <span className="text-gray-500">{fmtBytes(f.bytes)}</span>
                <button type="button" aria-label="Retirer le fichier" onClick={() => setPendingFiles((prev) => prev.filter((p) => p.path !== f.path))} className="text-gray-500 hover:text-red-400 ml-1">✕</button>
              </span>
            ))}
            {uploading && <span className="text-[11px] text-gray-500 px-2 py-0.5">Envoi de {uploading}…</span>}
          </div>
        )}
        {pendingImages.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pendingImages.map((im, k) => (
              <div key={k} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:${im.mediaType};base64,${im.data}`} alt={im.name ?? `Image ${k + 1}`} title={im.name} className="h-14 w-14 object-cover rounded-md border border-gray-700" />
                <button
                  type="button"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== k))}
                  aria-label="Retirer l'image"
                  className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-gray-800 border border-gray-600 text-gray-300 text-[10px] leading-none hover:bg-red-700"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.xlsx,.xls,.xlsm,.csv,.tsv,.txt,.md,.json,.pdf,.doc,.docx,.ppt,.pptx"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="Joindre des images ou des fichiers (Excel, CSV, PDF, Word…)"
            aria-label="Joindre un fichier"
            className="px-2.5 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-gray-400 hover:text-white hover:border-gray-600 disabled:opacity-50"
          >
            📎
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length && !busy) { e.preventDefault(); void addFiles(files); }
            }}
            placeholder={pendingImages.length ? "Que faire de ces images ?" : "Demandez un ajout, une analyse…"}
            disabled={busy}
            className="flex-1 min-w-0 px-3 py-2 rounded-lg text-sm bg-gray-900 border border-gray-800 text-white focus:border-violet-500 focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !!uploading || (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
            className="px-3 py-2 rounded-lg text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-50"
          >
            {busy ? "…" : "Envoyer"}
          </button>
        </div>
      </form>
    </aside>
  );
}
