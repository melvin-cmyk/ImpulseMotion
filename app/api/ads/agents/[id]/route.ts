/**
 * One Agents IA run. Staff only; accountKey must match the run.
 *   PATCH  { accountKey, score: { section, value: 1 | -1 | 0 } }  → score of a section (0 = cleared)
 *   POST   { accountKey, prompt }                                → follow-up question
 *   DELETE ?accountKey=…
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { PLAYBOOK_KEY_RE } from "@/lib/ads-warehouse/playbook";
import { followUp, toRun } from "@/lib/ads-warehouse/agents";

export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { accountKey?: string; score?: { section?: number; value?: number } };
  const accountKey = String(b.accountKey ?? "");
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const run = await prisma.adAgentRun.findFirst({ where: { id, accountKey } });
  if (!run) return NextResponse.json({ error: "Introuvable" }, { status: 404 });
  const section = Number(b.score?.section); const value = Number(b.score?.value);
  if (!Number.isInteger(section) || section < 0 || section > 5 || ![1, -1, 0].includes(value)) return NextResponse.json({ error: "Note invalide" }, { status: 400 });
  const scores = (() => { try { return JSON.parse(run.scoresJson) as Record<string, number>; } catch { return {}; } })();
  if (value) scores[String(section)] = value; else delete scores[String(section)];
  return NextResponse.json({ run: toRun(await prisma.adAgentRun.update({ where: { id }, data: { scoresJson: JSON.stringify(scores) } })) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { accountKey?: string; prompt?: string };
  const accountKey = String(b.accountKey ?? "");
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const prompt = String(b.prompt ?? "").trim().slice(0, 1000);
  if (prompt.length < 3) return NextResponse.json({ error: "Question vide" }, { status: 400 });
  try {
    return NextResponse.json({ run: await followUp(id, accountKey, prompt, { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: guard.session.user?.name ?? "" }) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Question impossible" }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const accountKey = req.nextUrl.searchParams.get("accountKey") ?? "";
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const { count } = await prisma.adAgentRun.deleteMany({ where: { id, accountKey } });
  return count ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Introuvable" }, { status: 404 });
}
