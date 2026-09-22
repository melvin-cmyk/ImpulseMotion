/**
 * POST /api/alerts/compose { text, accountId? } → { proposal }
 * The AI reads the consultant's sentence and proposes a rule (or an "ai"
 * rule when the grammar cannot express it). Nothing is saved here: the form
 * shows the proposal, the consultant edits and creates.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { composeAlertProposal } from "@/lib/alert-ai";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 8) return NextResponse.json({ error: "décrivez l'alerte en une phrase" }, { status: 400 });
  try {
    const platform = body.platform === "google" ? "google" : "meta";
    const proposal = await composeAlertProposal(text, { id: guard.session.userId, email: guard.session.user?.email, role: guard.session.role }, platform);
    return NextResponse.json({ proposal });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: /illisible|inconnue|manquant|formulé/.test(message) ? 400 : 502 });
  }
}
