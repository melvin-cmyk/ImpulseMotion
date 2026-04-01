/**
 * /api/deck/history
 *
 * POST — save a generated deck
 *   Body: { clientId, clientName, platform, period, startDate, endDate, slides, metrics }
 *   Returns: { id, createdAt }
 *
 * GET  — retrieve history for a client
 *   Query: ?clientId=xxx[&limit=12]
 *   Returns: { entries: DeckHistoryEntry[] }
 *
 * GET  — retrieve a single deck by id
 *   Query: ?id=xxx
 *   Returns: { entry: DeckHistoryEntry | null }
 */

import { NextRequest, NextResponse } from "next/server";
import { saveDeckHistory, getDeckHistory, getDeckHistoryById } from "@/lib/deck-history-storage";
import type { DeckHistoryEntry } from "@/lib/deck-history-storage";

function cuid(): string {
  // Simple cuid-like unique id that doesn't require a package
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `c${timestamp}${random}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { clientId, clientName, platform, period, startDate, endDate, slides, metrics } = body;

    if (!clientId || !slides) {
      return NextResponse.json({ error: "Missing required fields: clientId, slides" }, { status: 400 });
    }

    const entry: DeckHistoryEntry = {
      id: cuid(),
      clientId: String(clientId),
      clientName: String(clientName ?? clientId),
      platform: String(platform ?? "both"),
      period: String(period ?? ""),
      startDate: String(startDate ?? new Date().toISOString()),
      endDate: String(endDate ?? new Date().toISOString()),
      slides: Array.isArray(slides) ? slides : [],
      metrics: typeof metrics === "object" && metrics !== null ? metrics : {},
      createdAt: new Date().toISOString(),
    };

    await saveDeckHistory(entry);

    return NextResponse.json({ id: entry.id, createdAt: entry.createdAt });
  } catch (err) {
    console.error("[deck/history] POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    // Single deck lookup by id
    if (id) {
      const entry = await getDeckHistoryById(id);
      return NextResponse.json({ entry });
    }

    // History list by clientId
    const clientId = searchParams.get("clientId");
    if (!clientId) {
      return NextResponse.json({ error: "Missing required query param: clientId or id" }, { status: 400 });
    }

    const limit = Math.min(parseInt(searchParams.get("limit") ?? "12", 10), 50);
    const entries = await getDeckHistory(clientId, limit);

    return NextResponse.json({ entries });
  } catch (err) {
    console.error("[deck/history] GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
