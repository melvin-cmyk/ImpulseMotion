/**
 * POST /api/mo/tts { text, speaker? } → audio/wav — Mo's voice (staff), made
 * locally on the relay (Piper fr_FR-siwis-medium, female, via sherpa-onnx). The browser
 * falls back to its own speechSynthesis when this fails.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; speaker?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 1200) : "";
  if (!text) return NextResponse.json({ error: "Texte vide." }, { status: 400 });
  const speaker = body.speaker === "jessica" || body.speaker === "pierre" ? body.speaker : "siwis";
  let last = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/voice/tts`, { method: "POST", headers: relayHeaders(), body: JSON.stringify({ text, speaker }), signal: AbortSignal.timeout(url.includes("localhost") && RELAY_URLS.length > 1 ? 3000 : 25_000) });
      if (!res.ok) { const j = (await res.json().catch(() => ({}))) as { error?: string }; last = j.error ?? `relay ${res.status}`; if (res.status < 500) break; continue; }
      const wav = await res.arrayBuffer();
      return new NextResponse(wav, { status: 200, headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Voice-Seconds": res.headers.get("X-Voice-Seconds") ?? "" } });
    } catch (e) { last = e instanceof Error ? e.message : String(e); }
  }
  return NextResponse.json({ error: `Voix indisponible (${last})` }, { status: 502 });
}
