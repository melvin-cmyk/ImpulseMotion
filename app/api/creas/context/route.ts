/**
 * The client's statics context document (staff) — what the copywriter-AI of
 * the fabrique reads (lib/creas/context.ts).
 *   GET ?client=<AlertClient | dashboard id>[&fresh=1] → { context } : the stored version, or a fresh assembly
 *        (HQ brief + files, warehouse winners and untried angles, comments when open, past feedback), with its sources.
 *   PUT { clientId, md, sources?, mirror? } → { context, hq } : the consultant's version stored; with mirror=true also
 *        written in HQ (projects/{slug}/brain/contenu/statics-context.md, ETag lock) — the UI says so before the click.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { getClientContext, saveClientContext } from "@/lib/creas/context";
import { parseSources } from "@/lib/creas/model";

export const maxDuration = 120;
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const client = await resolveAlertClient(req.nextUrl.searchParams.get("client"));
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const context = await getClientContext(client, { fresh: req.nextUrl.searchParams.get("fresh") === "1" });
  return NextResponse.json({ context }, NO_STORE);
}

export async function PUT(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.md !== "string") return NextResponse.json({ error: "Document manquant." }, { status: 400 });
  const client = typeof body.clientId === "string" ? await resolveAlertClient(body.clientId) : null;
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const out = await saveClientContext(client, user, { md: body.md, ...(Array.isArray(body.sources) ? { sources: parseSources(JSON.stringify(body.sources)) } : {}), mirror: body.mirror === true });
    return NextResponse.json(out, NO_STORE);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
