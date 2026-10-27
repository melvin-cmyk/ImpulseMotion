/** GET /api/studio/engines → the image generators the Studio can use (Agnes + the fal.ai models the relay offers). Staff only. */

import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { AGNES_ENGINE, relayFalModels, type ImageEngine } from "@/lib/studio";

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const engines: ImageEngine[] = [AGNES_ENGINE];
  let defaultEngine = AGNES_ENGINE.id;
  try {
    const fal = await relayFalModels();
    if (fal.configured) {
      for (const m of fal.models) engines.push({ id: m.id, label: m.label, provider: "fal", refs: m.refs, usd: m.usd });
      defaultEngine = fal.defaultModel;
    }
  } catch { /* relay down: Agnes only */ }
  return NextResponse.json({ engines, defaultEngine }, { headers: { "Cache-Control": "private, max-age=300" } });
}
