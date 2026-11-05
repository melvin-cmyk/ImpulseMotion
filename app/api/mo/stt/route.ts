/**
 * POST /api/mo/stt → { text, seconds, ms } — speech to text for Mo (staff).
 * Body: the browser's recording as sent by MediaRecorder (audio/webm, audio/mp4,
 * audio/ogg, audio/wav…), 8 MB max. The relay converts and transcribes locally
 * (lib/voice-stt.ts): nothing leaves the agency.
 */

import { NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { transcribeRequest } from "@/lib/voice-stt";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  return transcribeRequest(req);
}
