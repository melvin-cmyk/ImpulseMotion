/**
 * The pages of the signed-in consultant's Mo workspace (staff only).
 *   GET          → { home, pages: { client: [...], free: [...] }, boards: [...] }
 *                  (summaries; archived pages left out; `boards` = the flat list of before, for compatibility)
 *   GET ?dock=1  → { board } : the home page « Aujourd'hui » (the orb posts there), created on first use
 *   POST { kind: "free", title? } → 201 { board } : a new free page
 *   POST { kind: "client", clientId } → 200 | 201 { board } : the client's page (created when missing)
 *   POST { kind: "home" } → 200 { board }
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { findClient, listClientRegistry } from "@/lib/clients/registry";
import { getOrCreateClientBoard, getOrCreateHomeBoard, parseMoCards, toBoardData } from "@/lib/mo/thread";
import { groupPages, pageKindOf, parseCreatePage, type MoPageSummary } from "@/lib/mo/pages";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const userId = guard.session.userId;
  const home = await getOrCreateHomeBoard(userId);
  if (req.nextUrl.searchParams.get("dock") === "1") return NextResponse.json({ board: toBoardData(home) }, NO_STORE);
  const [rows, clients] = await Promise.all([
    prisma.moBoard.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, take: 200, select: { id: true, title: true, kind: true, clientId: true, archivedAt: true, position: true, updatedAt: true, cardsJson: true } }),
    listClientRegistry(await getAccountScope(guard.session)).catch(() => []),
  ]);
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const summaries: MoPageSummary[] = rows.map((r) => ({ id: r.id, title: r.title, kind: r.id === home.id ? "home" : pageKindOf(r.kind) === "home" ? "free" : pageKindOf(r.kind), clientId: r.clientId, ...(r.clientId && names.get(r.clientId) ? { clientName: names.get(r.clientId) } : {}), updatedAt: r.updatedAt.toISOString(), cards: parseMoCards(r.cardsJson).filter((c) => c.type !== "frame").length, archived: !!r.archivedAt, position: r.position }));
  const grouped = groupPages(summaries);
  if (!grouped) return NextResponse.json({ error: "page d'accueil introuvable" }, { status: 500, ...NO_STORE });
  const boards = [...grouped.client, ...grouped.free].map((p) => ({ id: p.id, title: p.title || "Session Mo", updatedAt: p.updatedAt, cards: p.cards }));
  return NextResponse.json({ home: grouped.home, pages: { client: grouped.client, free: grouped.free }, boards }, NO_STORE);
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const userId = guard.session.userId;
  const body = parseCreatePage(await req.json().catch(() => ({})));
  if ("error" in body) return NextResponse.json({ error: body.error }, { status: 400, ...NO_STORE });
  if (body.kind === "home") return NextResponse.json({ board: toBoardData(await getOrCreateHomeBoard(userId)) }, NO_STORE);
  if (body.kind === "client") {
    const client = await findClient(await getAccountScope(guard.session), body.clientId);
    if (!client) return NextResponse.json({ error: "Client introuvable." }, { status: 404, ...NO_STORE });
    const { board, created } = await getOrCreateClientBoard(userId, { id: client.id, name: client.name });
    return NextResponse.json({ board: toBoardData(board), created }, { status: created ? 201 : 200, ...NO_STORE });
  }
  const row = await prisma.moBoard.create({ data: { userId, kind: "free", ...(body.title ? { title: body.title } : {}) } });
  return NextResponse.json({ board: toBoardData(row), created: true }, { status: 201, ...NO_STORE });
}
