/**
 * POST /api/creas/open → open a template or a generated visual in an editor (staff).
 *   { editor: "figcraft" | "photocraft", templateId? | assetId?, clientId? (registry or dashboard id), name? }
 *   → 201 { designId, ask }
 * Creates the design for the client (FigCraft: a 1080 × 1350 frame;
 * PhotoCraft: a workspace), drops the picture in its uploads/, and hands
 * back the first message for the design copilot — the design page sends it
 * on arrival (/design/<id>?ask=…). Logic in lib/creas/open-editor.ts (shared with Mo).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { openInEditor } from "@/lib/creas/open-editor";

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { editor?: unknown; clientId?: unknown; name?: unknown; templateId?: unknown; assetId?: unknown };
  const r = await openInEditor(guard.session, body);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ design: r.design, designId: r.designId, ask: r.ask, dropped: r.dropped }, { status: 201 });
}
