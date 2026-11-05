/**
 * Speech to text on the relay (server/voice.mjs, Parakeet via sherpa-onnx,
 * French, local): nothing leaves the agency. Shared by Mo (/api/mo/stt, staff)
 * and the client bots (/api/bot/[botId]/stt).
 */

import { NextRequest, NextResponse } from "next/server";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export const STT_MAX_BYTES = 8 * 1024 * 1024;

/** Reads the browser's recording from the request and answers { text, seconds, ms } or an error. */
export async function transcribeRequest(req: NextRequest): Promise<NextResponse> {
  const audio = Buffer.from(await req.arrayBuffer());
  if (!audio.length) return NextResponse.json({ error: "Enregistrement vide." }, { status: 400 });
  if (audio.length > STT_MAX_BYTES) return NextResponse.json({ error: "Enregistrement trop long." }, { status: 413 });
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
  console.error("[stt]", last);
  return NextResponse.json({ error: "Transcription impossible pour le moment, réessayez." }, { status: 502 });
}
