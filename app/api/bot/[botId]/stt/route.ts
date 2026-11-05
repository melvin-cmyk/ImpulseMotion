/**
 * POST /api/bot/[botId]/stt → { text } — dictation in a client bot's chat.
 * Only for who may use this bot (loadBotFor: client granted on it, staff in
 * scope). Same transcription as Mo, on the relay (lib/voice-stt.ts): the
 * client's voice never goes to a third party. 8 MB max per recording.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { transcribeRequest } from "@/lib/voice-stt";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error ?? NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { botId } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) return NextResponse.json({ error: loaded.status === 404 ? "assistant introuvable" : "accès refusé" }, { status: loaded.status });
  return transcribeRequest(req);
}
