/**
 * Feedback of the consultants on the creatives, at three levels (staff).
 *   POST { level: asset|template|run|client, clientId?, assetId?, templateId?, runId?, text } → 201 { feedback, hq: { ok, error? } }
 *        Stored (CreativeFeedback) and appended to the client's HQ journal (one entry per fabrique: fabrique-<runId>).
 *   GET  ?templateId= | ?runId= | ?assetId= | ?client= → { feedback }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { FEEDBACK_LEVELS, type FeedbackLevel } from "@/lib/creas/model";
import { FactoryError, RUN_ID_RE, addFeedback, listFeedback } from "@/lib/creas/factory";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const idOf = (v: string | null) => (v && RUN_ID_RE.test(v) ? v : undefined);

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = req.nextUrl.searchParams;
  const client = q.get("client") ? await resolveAlertClient(q.get("client")) : null;
  const where = { templateId: idOf(q.get("templateId")), runId: idOf(q.get("runId")), assetId: idOf(q.get("assetId")), clientId: client?.id };
  if (!where.templateId && !where.runId && !where.assetId && !where.clientId) return NextResponse.json({ error: "Précisez templateId, runId, assetId ou client." }, { status: 400 });
  return NextResponse.json({ feedback: await listFeedback(where) }, NO_STORE);
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const level = (FEEDBACK_LEVELS as readonly string[]).includes(String(body.level)) ? (body.level as FeedbackLevel) : null;
  if (!level) return NextResponse.json({ error: "Niveau de retour inconnu." }, { status: 400 });
  // The client: given, else the one of the run / template / visual.
  let clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (!clientId && typeof body.runId === "string" && RUN_ID_RE.test(body.runId)) clientId = (await prisma.factoryRun.findUnique({ where: { id: body.runId }, select: { alertClientId: true } }))?.alertClientId ?? "";
  if (!clientId && typeof body.assetId === "string" && RUN_ID_RE.test(body.assetId)) clientId = (await prisma.creativeAsset.findUnique({ where: { id: body.assetId }, select: { alertClientId: true } }))?.alertClientId ?? "";
  if (!clientId && typeof body.templateId === "string" && RUN_ID_RE.test(body.templateId)) clientId = (await prisma.creativeTemplate.findUnique({ where: { id: body.templateId }, select: { alertClientId: true } }))?.alertClientId ?? "";
  const client = await resolveAlertClient(clientId);
  if (!client) return NextResponse.json({ error: "Client introuvable pour ce retour." }, { status: 404 });
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const out = await addFeedback(client, user, { level, text: typeof body.text === "string" ? body.text : "", assetId: typeof body.assetId === "string" ? body.assetId : null, templateId: typeof body.templateId === "string" ? body.templateId : null, runId: typeof body.runId === "string" ? body.runId : null });
    return NextResponse.json(out, { status: 201, ...NO_STORE });
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
