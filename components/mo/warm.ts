/**
 * Warms Mo's process on the relay before the first message (POST
 * /api/mo/[id]/warm): fire and forget, at most once per board every 8 minutes
 * in this tab (the stamp lives in sessionStorage, so a reload does not call
 * again), errors ignored. Called when a board is opened, when a dictation
 * starts and when the composer takes the focus — the first answer then skips
 * the cold start.
 */

const WARM_EVERY_MS = 8 * 60_000;
const key = (boardId: string) => `mo:warm:${boardId}`;
const stamps = new Map<string, number>();

function lastWarm(boardId: string): number {
  const mem = stamps.get(boardId) ?? 0;
  try { return Math.max(mem, Number(sessionStorage.getItem(key(boardId))) || 0); } catch { return mem; }
}
function stamp(boardId: string, at: number | null): void {
  if (at === null) stamps.delete(boardId); else stamps.set(boardId, at);
  try { if (at === null) sessionStorage.removeItem(key(boardId)); else sessionStorage.setItem(key(boardId), String(at)); } catch { /* memory only */ }
}

export function warmMoBoard(boardId: string | null | undefined): void {
  if (!boardId || typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastWarm(boardId) < WARM_EVERY_MS) return;
  stamp(boardId, now);
  try {
    void fetch(`/api/mo/${boardId}/warm`, { method: "POST", keepalive: true }).then((r) => { if (!r.ok) stamp(boardId, null); }).catch(() => stamp(boardId, null));
  } catch { /* never blocks the UI */ }
}
