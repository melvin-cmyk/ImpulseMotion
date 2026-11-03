/**
 * Playbook of a client (Motion's Playbook). Staff only.
 *   GET  ?accountKey=client:…|meta:…  → { saved, review }  (?count=1 → { review: n } only, for the sidebar badge)
 *   POST { accountKey, title, userNote?, aiNote?, source?, ref? } → entry saved at once (a consultant's own finding)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { cleanRef, listPlaybook, reviewCount, toEntry, PLAYBOOK_KEY_RE, PLAYBOOK_MIN_CHARS, PLAYBOOK_SOURCES, type PlaybookSource } from "@/lib/ads-warehouse/playbook";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const accountKey = req.nextUrl.searchParams.get("accountKey") ?? "";
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  if (req.nextUrl.searchParams.get("count")) return NextResponse.json({ review: await reviewCount(accountKey) }, { headers: NO_STORE });
  return NextResponse.json(await listPlaybook(accountKey), { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.json().catch(() => ({}))) as { accountKey?: string; title?: string; userNote?: string; aiNote?: string; source?: string; ref?: unknown };
  const accountKey = String(b.accountKey ?? "");
  if (!PLAYBOOK_KEY_RE.test(accountKey)) return NextResponse.json({ error: "accountKey attendu" }, { status: 400 });
  const title = String(b.title ?? "").trim().slice(0, 140);
  const userNote = String(b.userNote ?? "").trim().slice(0, 4000);
  const aiNote = String(b.aiNote ?? "").trim().slice(0, 8000);
  if (!title) return NextResponse.json({ error: "Titre requis." }, { status: 400 });
  if ((title + userNote + aiNote).length < PLAYBOOK_MIN_CHARS) return NextResponse.json({ error: `L'apprentissage doit faire au moins ${PLAYBOOK_MIN_CHARS} caractères.` }, { status: 400 });
  const source: PlaybookSource = PLAYBOOK_SOURCES.includes(b.source as PlaybookSource) && b.source !== "ai" ? (b.source as PlaybookSource) : "manual";
  const name = guard.session.user?.name ?? guard.session.user?.email ?? "";
  const row = await prisma.adPlaybookEntry.create({ data: { accountKey, status: "saved", source, title, userNote, aiNote, refJson: JSON.stringify(cleanRef(b.ref)), createdById: guard.session.userId, createdByName: name, statusById: guard.session.userId, statusByName: name } });
  return NextResponse.json({ entry: toEntry(row) });
}
