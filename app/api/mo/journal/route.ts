/**
 * GET /api/mo/journal?day=YYYY-MM-DD&tz=<minutes> → { day, entries } : what Mo
 * did that day across every page of the caller (lib/mo/journal.ts): the
 * « action » lines (verdicts, publications, files…) and the turns that put
 * cards on a board, newest first, each with its time, client and label.
 * `tz` = the browser's `getTimezoneOffset()` (minutes), so the day is the
 * person's; default today in Europe/Paris.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry } from "@/lib/clients/registry";
import { parseMoCards, parseMoEntries } from "@/lib/mo/thread";
import { pageKindOf } from "@/lib/mo/pages";
import { dayRange, journalForDay, type JournalBoard } from "@/lib/mo/journal";

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
const MAX_ENTRIES = 200;

function parisOffsetMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return Math.round((d.getTime() - local) / 60_000);
}

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = req.nextUrl.searchParams;
  const now = new Date();
  const tzRaw = Number(q.get("tz"));
  const tz = Number.isFinite(tzRaw) && q.get("tz") !== null ? tzRaw : parisOffsetMinutes(now);
  const today = new Date(now.getTime() - tz * 60_000).toISOString().slice(0, 10);
  const day = q.get("day") || today;
  const range = dayRange(day, tz);
  if (!range) return NextResponse.json({ error: "day attendu au format YYYY-MM-DD" }, { status: 400, ...NO_STORE });
  const [rows, clients] = await Promise.all([
    prisma.moBoard.findMany({ where: { userId: guard.session.userId }, select: { id: true, title: true, kind: true, clientId: true, cardsJson: true, messagesJson: true }, take: 200 }),
    listClientRegistry(await getAccountScope(guard.session)).catch(() => []),
  ]);
  const boards: JournalBoard[] = rows.map((r) => ({ id: r.id, title: r.title, kind: pageKindOf(r.kind), clientId: r.clientId, cards: parseMoCards(r.cardsJson), messages: parseMoEntries(r.messagesJson) }));
  const entries = journalForDay(boards, range, new Map(clients.map((c) => [c.id, c.name]))).slice(0, MAX_ENTRIES);
  return NextResponse.json({ day, entries }, NO_STORE);
}
