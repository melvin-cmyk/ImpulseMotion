/**
 * Routines — what the consultant chose in the form that creates the routine,
 * beside the accounts: the Facebook Page that publishes the ads.
 *
 * Kept in Routine.chatJson, under `context`, next to the conversation it is
 * meant for ({ messages, proposals, context }): no column was added. It is a
 * help for the AI that writes the routine, which no longer has to ask for the
 * Page. It decides nothing: the Page of a definition is the `pageId` of its
 * meta.create_ads step, checked by the server when the definition is applied.
 *
 * Pure and client-safe.
 */

export interface RoutinePage { id: string; name: string }
export interface RoutineContext { page?: RoutinePage }

const PAGE_ID_RE = /^\d{5,25}$/;
const MAX_NAME_CHARS = 120;

/** A Page as it is stored: its id in digits, its name on one line. Null when it is not one. */
export function cleanRoutinePage(raw: unknown): RoutinePage | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || !PAGE_ID_RE.test(id)) return null;
  const label = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) : "";
  return { id, name: label || id };
}

function parse(chatJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(chatJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readRoutineContext(chatJson: string | null | undefined): RoutineContext {
  const context = parse(chatJson).context;
  if (!context || typeof context !== "object") return {};
  const page = cleanRoutinePage((context as { page?: unknown }).page);
  return page ? { page } : {};
}

/** chatJson of a routine that starts: no conversation yet, what the form chose. */
export function initialChatJson(context: RoutineContext): string {
  const page = cleanRoutinePage(context.page);
  return JSON.stringify(page ? { context: { page } } : {});
}

/** The conversation as it is saved, with the context the routine was created with left in place. */
export function chatJsonWith(previous: string | null | undefined, chat: { messages: unknown; proposals: unknown }): string {
  const context = readRoutineContext(previous);
  return JSON.stringify({ messages: chat.messages, proposals: chat.proposals, ...(context.page ? { context } : {}) });
}
