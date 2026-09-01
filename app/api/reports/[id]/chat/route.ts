/**
 * POST /api/reports/[id]/chat → staff: SSE stream of the AI answer.
 *   body { messages: [{role, content}] }  (the thread; persisted separately via PATCH /api/reports/[id] { chat })
 *
 * The assistant reads the report's frozen data snapshot + the report text.
 * MCP tools are scoped to the client's accounts so it can dig deeper on
 * demand, but the prompt tells it to answer from the snapshot first.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { relayStream, type RelayMessage } from "@/lib/relay-chat";
import { renderDataForPrompt } from "@/lib/report-generate";
import type { ReportData } from "@/lib/report-data";

export const maxDuration = 120;

const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 12000;

function sanitizeMessages(raw: unknown): RelayMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: RelayMessage[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    out.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return out;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const report = await prisma.clientReport.findUnique({
    where: { id },
    select: { id: true, title: true, status: true, dataJson: true, contentMd: true, nextStepsJson: true, dashboard: true },
  });
  if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (report.status !== "ready") return NextResponse.json({ error: "le rapport n'est pas encore généré" }, { status: 409 });

  const messages = sanitizeMessages((await req.json().catch(() => ({}))).messages);
  if (!messages) return NextResponse.json({ error: "messages invalid" }, { status: 400 });

  let data: ReportData | null = null;
  try { data = JSON.parse(report.dataJson) as ReportData; } catch { /* keep null */ }

  const systemPrompt = [
    "Tu es le consultant média senior d'Impulse Analytics qui a rédigé le rapport ci-dessous. Tu réponds aux questions d'un collègue consultant sur ce rapport et ce client.",
    "RÈGLES : réponds d'abord à partir du SNAPSHOT et du RAPPORT ci-dessous (ce sont les chiffres de référence, figés). N'invente jamais un chiffre. Si la question demande une donnée absente du snapshot (autre période, niveau adset, détail d'une créa), tu peux utiliser les outils Meta/Google Ads disponibles — dis-le explicitement quand tu le fais et reste dans le périmètre du client.",
    "Français, concis, concret, pas d'emoji. Utilise des puces ou un petit tableau Markdown quand c'est plus lisible. Quand on te demande une action, formule-la à l'impératif avec la justification chiffrée.",
    "",
    `TITRE : ${report.title}`,
    "",
    "=== SNAPSHOT DE DONNÉES ===",
    data ? renderDataForPrompt(data) : "(snapshot indisponible)",
    "",
    "=== RAPPORT ===",
    report.contentMd.slice(0, 30000),
    "",
    "=== NEXT STEPS ===",
    report.nextStepsJson.slice(0, 6000),
  ].join("\n");

  return relayStream({
    messages,
    systemPrompt,
    allowedServers: ["meta-ads-impulse", "mcp-google-ads"],
    accountScope: {
      meta: report.dashboard.metaAccountId ? [report.dashboard.metaAccountId] : [],
      google: report.dashboard.googleCustomerId ? [report.dashboard.googleCustomerId] : [],
    },
  });
}
