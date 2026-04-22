/**
 * /api/deck/draft
 *
 * Live deck state persisted per (user, client, period). Replaces the
 * localStorage-only store so a user's in-progress deck follows them across
 * devices.
 *
 * GET  ?clientId=...&periodKey=...  → { draft | null }
 * PUT  body: { clientId, periodKey, ...fields }  → { ok: true }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

const JSON_FIELDS = [
  "droppedBlocks",
  "slideOverrides",
  "customSlides",
  "slideNotes",
  "blockStyles",
  "slideElements",
  "textStyles",
  "aiDynamicSlides",
  "masterElements",
] as const;

type JsonField = (typeof JSON_FIELDS)[number];

function parseDraft(row: {
  droppedBlocks: string; slideOverrides: string; customSlides: string;
  slideNotes: string; blockStyles: string; slideElements: string;
  textStyles: string; aiDynamicSlides: string;
  masterElements: string | null;
  updatedAt: Date;
  themeId: string | null;
}) {
  const out: Record<JsonField, unknown> & { updatedAt: string; themeId: string | null } = {
    droppedBlocks: [],
    slideOverrides: [],
    customSlides: [],
    slideNotes: {},
    blockStyles: {},
    slideElements: {},
    textStyles: {},
    aiDynamicSlides: [],
    masterElements: [],
    updatedAt: row.updatedAt.toISOString(),
    themeId: row.themeId,
  };
  for (const f of JSON_FIELDS) {
    const raw = row[f];
    if (typeof raw !== "string") continue;
    try { out[f] = JSON.parse(raw); }
    catch { /* leave default */ }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const userId = guard.session.userId;
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get("clientId");
  const periodKey = searchParams.get("periodKey");
  if (!clientId || !periodKey) {
    return NextResponse.json({ error: "Missing clientId or periodKey" }, { status: 400 });
  }

  const row = await prisma.deckDraft.findUnique({
    where: { userId_clientId_periodKey: { userId, clientId, periodKey } },
  });
  return NextResponse.json({ draft: row ? parseDraft(row) : null });
}

export async function PUT(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const userId = guard.session.userId;
  const body = await req.json();
  const clientId = typeof body.clientId === "string" ? body.clientId : null;
  const periodKey = typeof body.periodKey === "string" ? body.periodKey : null;
  if (!clientId || !periodKey) {
    return NextResponse.json({ error: "Missing clientId or periodKey" }, { status: 400 });
  }

  const jsonPayload: Record<JsonField, string> = {
    droppedBlocks: JSON.stringify(body.droppedBlocks ?? []),
    slideOverrides: JSON.stringify(body.slideOverrides ?? []),
    customSlides: JSON.stringify(body.customSlides ?? []),
    slideNotes: JSON.stringify(body.slideNotes ?? {}),
    blockStyles: JSON.stringify(body.blockStyles ?? {}),
    slideElements: JSON.stringify(body.slideElements ?? {}),
    textStyles: JSON.stringify(body.textStyles ?? {}),
    aiDynamicSlides: JSON.stringify(body.aiDynamicSlides ?? []),
    masterElements: JSON.stringify(body.masterElements ?? []),
  };
  const themeId = typeof body.themeId === "string" ? body.themeId : null;
  const payload = { ...jsonPayload, themeId };

  await prisma.deckDraft.upsert({
    where: { userId_clientId_periodKey: { userId: userId, clientId, periodKey } },
    create: { userId: userId, clientId, periodKey, ...payload },
    update: payload,
  });
  return NextResponse.json({ ok: true });
}
