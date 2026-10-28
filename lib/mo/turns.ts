/**
 * The MoTurn table (spec §6): one row per turn of Mo — which path answered,
 * how long to the first card, understood or not. Writes are best effort: a
 * measure must never break a turn (the table may also lag a deploy). The
 * pure rules live in lib/mo/measure.ts.
 */

import { prisma } from "@/lib/prisma";
import { MO_TURN_PATHS, type MoTurnPath } from "@/lib/mo/measure";

export interface MoTurnInput { userId: string; boardId: string; path: MoTurnPath; kind?: string | null; jobId?: string | null; totalMs?: number; firstCardMs?: number | null; clarified?: boolean; retried?: boolean; misunderstood?: boolean }
export interface MoTurnPatch { firstCardMs?: number; totalMs?: number; clarified?: boolean; retried?: boolean; misunderstood?: boolean }

let warned = false;
const quiet = (where: string, e: unknown) => { if (!warned) { warned = true; console.warn(`[mo/turn] ${where} : ${e instanceof Error ? e.message.slice(0, 160) : e}`); } };

/** Writes a turn; returns its id, or null when the write failed (never throws). */
export async function recordMoTurn(input: MoTurnInput): Promise<string | null> {
  try {
    const row = await prisma.moTurn.create({ data: { userId: input.userId, boardId: input.boardId, path: input.path, kind: input.kind ?? null, jobId: input.jobId ?? null, totalMs: Math.max(0, Math.round(input.totalMs ?? 0)), firstCardMs: input.firstCardMs == null ? null : Math.max(0, Math.round(input.firstCardMs)), clarified: !!input.clarified, retried: !!input.retried, misunderstood: !!input.misunderstood }, select: { id: true } });
    return row.id;
  } catch (e) { quiet("create", e); return null; }
}

/** Completes a turn of the caller (the browser's first-card time, a 👎, a chip clicked). False when not found or on failure. */
export async function patchMoTurn(id: string, userId: string, patch: MoTurnPatch): Promise<boolean> {
  const data: MoTurnPatch = {};
  if (typeof patch.firstCardMs === "number") data.firstCardMs = Math.max(0, Math.round(patch.firstCardMs));
  if (typeof patch.totalMs === "number") data.totalMs = Math.max(0, Math.round(patch.totalMs));
  if (typeof patch.clarified === "boolean") data.clarified = patch.clarified;
  if (typeof patch.retried === "boolean") data.retried = patch.retried;
  if (typeof patch.misunderstood === "boolean") data.misunderstood = patch.misunderstood;
  if (!Object.keys(data).length) return false;
  try {
    const r = await prisma.moTurn.updateMany({ where: { id, userId }, data });
    return r.count > 0;
  } catch (e) { quiet("patch", e); return false; }
}

/** The end of a detached model turn: its total time, from the job (lib/ai-jobs.ts). */
export async function closeMoTurnByJob(jobId: string, totalMs: number): Promise<void> {
  try { await prisma.moTurn.updateMany({ where: { jobId }, data: { totalMs: Math.max(0, Math.round(totalMs)) } }); } catch (e) { quiet("close", e); }
}

const ID_RE = /^[a-z0-9]{10,40}$/i;
const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 3_600_000 ? Math.round(v) : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

/** PATCH body of /api/mo/turn/[id], read with care. */
export function parseTurnPatch(raw: unknown): MoTurnPatch | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Corps illisible." };
  const r = raw as Record<string, unknown>;
  const patch: MoTurnPatch = {};
  const first = ms(r.firstCardMs); if (first !== undefined) patch.firstCardMs = first;
  const total = ms(r.totalMs); if (total !== undefined) patch.totalMs = total;
  for (const k of ["clarified", "retried", "misunderstood"] as const) { const v = bool(r[k]); if (v !== undefined) patch[k] = v; }
  return Object.keys(patch).length ? patch : { error: "Rien à modifier." };
}

/** POST body of /api/mo/turn (a turn the browser resolved alone: a navigation, an ask). */
export function parseTurnCreate(raw: unknown): Omit<MoTurnInput, "userId"> | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Corps illisible." };
  const r = raw as Record<string, unknown>;
  const boardId = typeof r.boardId === "string" && ID_RE.test(r.boardId) ? r.boardId : "";
  if (!boardId) return { error: "boardId requis." };
  const path = typeof r.path === "string" && (MO_TURN_PATHS as readonly string[]).includes(r.path) ? (r.path as MoTurnPath) : null;
  if (!path || path === "model") return { error: "path nav | quick | act | ask requis." };
  const kind = typeof r.kind === "string" ? r.kind.slice(0, 40) : null;
  return { boardId, path, kind, totalMs: ms(r.totalMs) ?? 0, firstCardMs: ms(r.firstCardMs) ?? null, clarified: bool(r.clarified) ?? false, retried: bool(r.retried) ?? false, misunderstood: bool(r.misunderstood) ?? false };
}
