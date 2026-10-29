/**
 * Competitors of a client (staff) — lib/competitors.ts.
 *   GET    ?client=<AlertClient id | dashboard id>[&suggest=1|force]
 *          → { client, competitors: [{ name, origin: saved|hq|suggested }], needsSuggestions, suggestedAt, hqBrief, warning? }
 *          suggest=1: the AI proposes names when saved + HQ give fewer than 3 (cached 30 days, ~10 s the first time);
 *          force: proposes again.
 *   POST   { client, name }        → the consultant adds a competitor (same answer as GET)
 *   DELETE ?client=&name=          → the consultant removes one (hidden even when HQ or the AI names it)
 * The ads of one competitor come from /api/creas/ad-library?q=<name>.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { resolveAlertClient } from "@/lib/creas/templates";
import { addClientCompetitor, getClientCompetitors, removeClientCompetitor } from "@/lib/competitors";
import { cleanBrand } from "@/lib/competitors-core";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
export const maxDuration = 90;

type Guard = Exclude<Awaited<ReturnType<typeof requireStaff>>, { error: unknown }>;
const userOf = (g: Guard) => ({ id: g.session.userId, email: g.session.user?.email ?? null, role: g.session.role ?? "" });

async function answer(g: Guard, clientParam: string | null, suggest: boolean | "force" = false) {
  const client = await resolveAlertClient(clientParam);
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404, ...NO_STORE });
  const list = await getClientCompetitors({ id: client.id, name: client.name }, { suggest, user: userOf(g) });
  return NextResponse.json({ client: { id: client.id, name: client.name }, ...list }, NO_STORE);
}

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = req.nextUrl.searchParams;
  const s = q.get("suggest");
  return answer(guard, q.get("client"), s === "force" ? "force" : s === "1");
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { client?: unknown; name?: unknown };
  const name = cleanBrand(body.name);
  if (!name) return NextResponse.json({ error: "Nom de marque invalide (2 à 60 caractères)." }, { status: 400 });
  const client = await resolveAlertClient(typeof body.client === "string" ? body.client : null);
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  await addClientCompetitor(client.id, name, guard.session.userId);
  return answer(guard, client.id);
}

export async function DELETE(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = req.nextUrl.searchParams;
  const name = cleanBrand(q.get("name"));
  if (!name) return NextResponse.json({ error: "Nom de marque invalide." }, { status: 400 });
  const client = await resolveAlertClient(q.get("client"));
  if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404 });
  await removeClientCompetitor(client.id, name, guard.session.userId);
  return answer(guard, client.id);
}
