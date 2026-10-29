/**
 * Fabrique de statics — a generation that runs without the browser: passes
 * of ≤ 12 images chained on Vercel. Each hop is a call to
 * POST /api/creas/factory/[id]/continue (bearer = RELAY_SHARED_SECRET) that
 * answers 202 at once and runs its pass after the answer (next/server
 * `after`, ≤ 300 s), then calls the next hop while something remains. Used
 * above BACKGROUND_FROM visuals in Créas and by Mo for long generations; the
 * Mo board it came from gets the grid when it ends.
 */

import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { parseSettings } from "@/lib/creas/model";

/** Hops at most (each ≤ 12 images): 100 images = 9 hops; the rest is a safety net. */
export const MAX_HOPS = 15;

export function relayBearerOk(header: string | null): boolean {
  const secret = process.env.RELAY_SHARED_SECRET || "";
  const m = (header || "").match(/^Bearer\s+(.+)$/i);
  if (secret.length < 16 || !m) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HopBody { userId: string; hop: number; origin: string; first?: { n: number; engine?: string; ratio?: string; textless?: boolean } }

/** Calls the next hop; true when it was accepted (202). */
export async function callHop(runId: string, body: HopBody): Promise<boolean> {
  if (!/^https?:\/\//.test(body.origin)) return false;
  try {
    const res = await fetch(`${body.origin}/api/creas/factory/${runId}/continue`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RELAY_SHARED_SECRET ?? ""}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    return res.status === 202;
  } catch (e) {
    console.error("[fabrique] relance de la passe impossible", runId, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Marks the run as running in the background (and the Mo board to post on), then starts hop 0. */
export async function startBackground(runId: string, opts: { userId: string; origin: string; boardId?: string | null; first: NonNullable<HopBody["first"]> }): Promise<boolean> {
  const run = await prisma.factoryRun.findUnique({ where: { id: runId }, select: { settingsJson: true } });
  if (!run) return false;
  const settings = parseSettings(run.settingsJson);
  await prisma.factoryRun.update({ where: { id: runId }, data: { settingsJson: JSON.stringify({ ...settings, background: true, ...(opts.boardId ? { boardId: opts.boardId } : {}) }) } });
  return callHop(runId, { userId: opts.userId, hop: 0, origin: opts.origin, first: opts.first });
}

/** A stop worth showing on the run (quota, error): the browser and Mo read it in settings.error. */
export async function recordBackgroundStop(runId: string, message: string): Promise<void> {
  const run = await prisma.factoryRun.findUnique({ where: { id: runId }, select: { settingsJson: true } });
  if (!run) return;
  const settings = parseSettings(run.settingsJson);
  await prisma.factoryRun.update({ where: { id: runId }, data: { settingsJson: JSON.stringify({ ...settings, background: false, error: message.slice(0, 500) }) } });
}
