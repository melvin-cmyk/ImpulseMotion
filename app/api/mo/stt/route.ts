/**
 * POST /api/mo/stt → { text, seconds, ms } — speech to text for Mo (staff).
 * Body: the browser's recording as sent by MediaRecorder (audio/webm, audio/mp4,
 * audio/ogg, audio/wav…), 8 MB max. The relay converts and transcribes locally
 * (server/voice.mjs, Parakeet via sherpa-onnx): nothing leaves the agency.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export const maxDuration = 60;
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const audio = Buffer.from(await req.arrayBuffer());
  if (!audio.length) return NextResponse.json({ error: "Enregistrement vide." }, { status: 400 });
  if (audio.length > MAX_BYTES) return NextResponse.json({ error: "Enregistrement trop long." }, { status: 413 });
  const type = req.headers.get("content-type") || "application/octet-stream";
  let last = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/voice/stt`, { method: "POST", headers: relayHeaders({ "Content-Type": type }), body: audio, signal: AbortSignal.timeout(url.includes("localhost") && RELAY_URLS.length > 1 ? 3000 : 45_000) });
      const json = (await res.json().catch(() => ({}))) as { text?: string; seconds?: number; ms?: number; error?: string };
      if (!res.ok) { last = json.error ?? `relay ${res.status}`; if (res.status < 500) break; continue; }
      return NextResponse.json({ text: json.text ?? "", seconds: json.seconds ?? 0, ms: json.ms ?? 0 }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) { last = e instanceof Error ? e.message : String(e); }
  }
  return NextResponse.json({ error: `Transcription impossible (${last})` }, { status: 502 });
}
