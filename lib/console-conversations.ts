/**
 * Conversations of the AI console (/ai), stored server-side and private to
 * their owner. Pure helpers: what the browser sends is reduced to the fields
 * the console renders, bounded in size, and never carries image pixels.
 */

export const CONSOLE_MAX_CONVERSATIONS = 50;
export const CONSOLE_MAX_MESSAGES = 200;
const MAX_CONTENT_CHARS = 60_000;
const MAX_JSON_CHARS = 1_500_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILES_NOTE_RE = /\n\n\[Fichiers déposés dans [^\]]*\]$/;

export interface StoredConsoleMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: Array<{ mediaType: string; data: ""; name?: string }>;
  files?: Array<{ name: string; path: string; bytes: number }>;
  toolCalls?: Array<{ name: string; id: string }>;
  toolResults?: Array<{ id: string; content: ""; is_error: boolean }>;
  usage?: { cost: number; turns: number; duration: number };
}

export function isConversationId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown, max: number): Array<Record<string, unknown>> =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").slice(0, max) : [];

/** Browser payload → what is stored. Null when it is not a message list. */
export function sanitizeConsoleMessages(raw: unknown): StoredConsoleMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StoredConsoleMessage[] = [];
  for (const m of list(raw, 10_000).slice(-CONSOLE_MAX_MESSAGES)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = str(m.content, MAX_CONTENT_CHARS);
    const images = list(m.images, 8).map((im) => ({ mediaType: str(im.mediaType, 40), data: "" as const, ...(im.name ? { name: str(im.name, 120) } : {}) }));
    const files = list(m.files, 20).map((f) => ({ name: str(f.name, 200), path: str(f.path, 400), bytes: num(f.bytes) })).filter((f) => f.name && f.path);
    if (!content && !images.length && !files.length) continue;
    const toolCalls = list(m.toolCalls, 200).map((t) => ({ name: str(t.name, 120), id: str(t.id, 80) }));
    const toolResults = list(m.toolResults, 200).map((t) => ({ id: str(t.id, 80), content: "" as const, is_error: t.is_error === true }));
    const u = m.usage && typeof m.usage === "object" ? (m.usage as Record<string, unknown>) : null;
    out.push({
      id: str(m.id, 80) || `m${out.length}`,
      role: m.role,
      content,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
      ...(toolCalls.length ? { toolCalls, toolResults } : {}),
      ...(u ? { usage: { cost: num(u.cost), turns: num(u.turns), duration: num(u.duration) } } : {}),
    });
  }
  // Oldest messages go first when the thread outgrows the row.
  while (out.length > 1 && JSON.stringify(out).length > MAX_JSON_CHARS) out.shift();
  return out;
}

export function conversationTitle(messages: StoredConsoleMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.replace(FILES_NOTE_RE, "").trim() ?? "";
  return (first || "Nouvelle conversation").slice(0, 60);
}

export function parseStoredMessages(json: string): StoredConsoleMessage[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StoredConsoleMessage[]) : [];
  } catch { return []; }
}
