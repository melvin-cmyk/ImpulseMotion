/**
 * Mo boards of the signed-in consultant (staff only).
 *   GET  → { boards: [{ id, title, updatedAt, cards }] } (most recent first)
 *   POST → 201 { board } : a new empty board
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { parseMoCards } from "@/lib/mo/thread";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rows = await prisma.moBoard.findMany({ where: { userId: guard.session.userId }, orderBy: { updatedAt: "desc" }, take: 30, select: { id: true, title: true, updatedAt: true, cardsJson: true } });
  return NextResponse.json({ boards: rows.map((r) => ({ id: r.id, title: r.title || "Session Mo", updatedAt: r.updatedAt.toISOString(), cards: parseMoCards(r.cardsJson).length })) }, NO_STORE);
}

export async function POST() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const row = await prisma.moBoard.create({ data: { userId: guard.session.userId } });
  return NextResponse.json({ board: { id: row.id, title: row.title, cards: [], messages: [], updatedAt: row.updatedAt.toISOString() } }, { status: 201, ...NO_STORE });
}
