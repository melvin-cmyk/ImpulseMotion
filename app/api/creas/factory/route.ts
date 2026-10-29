/**
 * Fabrique de statics (staff).
 *   GET  ?client=<AlertClient id | dashboard id> → { runs } : the client's fabriques, newest first
 *   POST { clientId, templateIds: string[], kind?: offer|evergreen|iteration, perTemplate? (4), reviews?, instructions?, persona?, season? }
 *        → 201 { run (with its copies), templates, error? } : the run is created, its context frozen, the copies proposed by the AI (Sonnet low).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient, templateView } from "@/lib/creas/templates";
import { FACTORY_KINDS, type FactoryKind } from "@/lib/creas/model";
import { FactoryError, createRun, listRuns } from "@/lib/creas/factory";

export const maxDuration = 300;
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const client = await resolveAlertClient(req.nextUrl.searchParams.get("client"));
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  return NextResponse.json({ runs: await listRuns(client.id), client: { id: client.id, name: client.name } }, NO_STORE);
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Demande illisible." }, { status: 400 });
  const client = typeof body.clientId === "string" ? await resolveAlertClient(body.clientId) : null;
  if (!client) return NextResponse.json({ error: "Choisissez le client de cette fabrique." }, { status: 400 });
  const templateIds = Array.isArray(body.templateIds) ? body.templateIds.filter((x): x is string => typeof x === "string" && /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 12) : [];
  if (!templateIds.length) return NextResponse.json({ error: "Cochez au moins un template." }, { status: 400 });
  const kind: FactoryKind = (FACTORY_KINDS as readonly string[]).includes(String(body.kind)) && body.kind !== "variation" ? (body.kind as FactoryKind) : "offer";
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const author = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { name: true, email: true } });
  const user = { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.role ?? "", name: (author?.name ?? "").trim() || author?.email || "Consultant" };
  try {
    const out = await createRun(client, user, { kind, templateIds, perTemplate: typeof body.perTemplate === "number" ? body.perTemplate : undefined, reviews: str(body.reviews, 60_000), instructions: str(body.instructions, 1500), persona: str(body.persona, 200), season: str(body.season, 200) });
    return NextResponse.json({ run: out.run, templates: out.templates.map((t) => templateView(t, guard.session.userId)), ...(out.error ? { error: out.error } : {}) }, { status: 201, ...NO_STORE });
  } catch (e) {
    if (e instanceof FactoryError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
