/**
 * GET    /api/reports/[id]  → staff: full report (content, data snapshot, next steps, chat)
 * PATCH  /api/reports/[id]  → staff: { title?, nextSteps?, appendMd?, chat? }
 * DELETE /api/reports/[id]  → staff
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import type { ReportNextStep } from "@/lib/report-data";
import { REPORT_FULL_INCLUDE, serializeReport } from "@/lib/reports-api";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const report = await prisma.clientReport.findUnique({ where: { id }, include: REPORT_FULL_INCLUDE });
  if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ report: serializeReport(report) });
}

const MAX_CHAT_MESSAGES = 60;
const MAX_CHAT_CHARS = 20000;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const existing = await prisma.clientReport.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};

  if (typeof body.title === "string" && body.title.trim()) data.title = body.title.trim().slice(0, 200);

  if (Array.isArray(body.nextSteps)) {
    const steps: ReportNextStep[] = body.nextSteps
      .filter((s: unknown) => !!s && typeof s === "object" && typeof (s as ReportNextStep).title === "string")
      .slice(0, 30)
      .map((s: ReportNextStep, i: number) => ({
        id: typeof s.id === "string" ? s.id.slice(0, 40) : `ns-${i + 1}`,
        title: s.title.trim().slice(0, 200),
        detail: typeof s.detail === "string" ? s.detail.trim().slice(0, 1000) : "",
        priority: ["high", "medium", "low"].includes(String(s.priority)) ? s.priority : "medium",
        platform: ["meta", "google", "global"].includes(String(s.platform)) ? s.platform : "global",
        done: !!s.done,
      }));
    data.nextStepsJson = JSON.stringify(steps);
  }

  if (typeof body.appendMd === "string" && body.appendMd.trim()) {
    const chunk = body.appendMd.trim().slice(0, 8000);
    const hasSection = /## Compléments/.test(existing.contentMd);
    data.contentMd = hasSection
      ? `${existing.contentMd.trimEnd()}\n\n${chunk}\n`
      : `${existing.contentMd.trimEnd()}\n\n## Compléments\n\n${chunk}\n`;
  }

  if (typeof body.contentMd === "string" && body.contentMd.trim().length > 50) {
    data.contentMd = body.contentMd.slice(0, 60000);
  }

  if (Array.isArray(body.chat)) {
    const chat = body.chat
      .slice(-MAX_CHAT_MESSAGES)
      .filter((m: unknown) => !!m && typeof m === "object" && ["user", "assistant"].includes(String((m as { role?: string }).role)) && typeof (m as { content?: unknown }).content === "string")
      .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content.slice(0, MAX_CHAT_CHARS) }));
    data.chatJson = JSON.stringify(chat);
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const updated = await prisma.clientReport.update({ where: { id }, data, include: REPORT_FULL_INCLUDE });
  return NextResponse.json({ report: serializeReport(updated) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  await prisma.clientReport.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
