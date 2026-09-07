/**
 * POST /api/ingest/orders — alimentation de l'entrepôt client_data par n8n.
 *
 * Pas de session : `Authorization: Bearer <token>`, sha256(token) doit
 * correspondre à ClientBot.ingestTokenHash (token généré par l'admin, jamais
 * stocké en clair). Body { rows: IngestRow[] } (max 2000 lignes plates, une
 * par article). Le client_key est celui du bot — jamais celui du body.
 *
 * CONTRAT : toutes les lignes d'une même commande voyagent dans le même appel
 * (l'upsert remplace les articles de la commande par ceux du lot reçu ; une
 * commande coupée entre deux lots perdrait les articles du premier).
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { upsertOrderRows, type IngestRow } from "@/lib/client-data";

export const maxDuration = 60;
export const runtime = "nodejs";

const MAX_ROWS = 2000;

export async function POST(req: NextRequest) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const hash = createHash("sha256").update(token).digest("hex");
  const bot = await prisma.clientBot.findFirst({
    where: { ingestTokenHash: hash },
    select: { id: true, clientKey: true },
  });
  if (!bot) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { rows?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 });
  }
  const rows = body?.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows[] requis" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: `max ${MAX_ROWS} lignes par appel` }, { status: 413 });
  }

  try {
    const result = await upsertOrderRows(bot.clientKey, rows as IngestRow[]);
    await prisma.clientBot.update({
      where: { id: bot.id },
      data: { lastIngestAt: new Date(), lastIngestRows: rows.length },
    });
    return NextResponse.json({ ok: true, orders: result.orders, rows: rows.length, items: result.items });
  } catch (err) {
    console.error("[ingest/orders]", err);
    return NextResponse.json({ error: "échec de l'ingestion" }, { status: 500 });
  }
}
