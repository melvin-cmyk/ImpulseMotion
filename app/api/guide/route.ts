/**
 * POST /api/guide → staff: one answer of the in-app guide (lib/app-guide.ts).
 *   body { messages: [{ role: "user" | "assistant", content }], path? }
 *
 * Sonnet, low effort, one turn, no tool and no client data: the cheapest
 * call of the application. Goes through the relay like every AI feature.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { relayComplete } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { GUIDE_HISTORY, GUIDE_MAX_QUESTION, buildGuidePrompt, guideQuestion, safeGuideLinks } from "@/lib/app-guide";

export const maxDuration = 60;

const PATH_RE = /^\/[A-Za-z0-9/_\-[\]]{0,120}$/;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const raw: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .map((m) => {
      const o = (m && typeof m === "object" ? m : {}) as { role?: unknown; content?: unknown };
      const content = typeof o.content === "string" ? o.content.trim().slice(0, GUIDE_MAX_QUESTION) : "";
      return { role: o.role === "assistant" ? ("assistant" as const) : ("user" as const), content };
    })
    .filter((m) => m.content)
    .slice(-GUIDE_HISTORY);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "question requise" }, { status: 400 });
  }
  const path = typeof body.path === "string" && PATH_RE.test(body.path) ? body.path : null;
  const last = messages[messages.length - 1];
  messages[messages.length - 1] = { role: "user", content: guideQuestion(last.content, path) };

  try {
    const text = await relayComplete(
      {
        messages,
        systemPrompt: buildGuidePrompt(),
        allowedServers: [],
        accountScope: {},
        model: "sonnet",
        effort: "low",
        maxTurns: 1,
      },
      {
        maxMs: 45_000,
        onUsage: (u) => void recordAiUsage(u, {
          feature: "guide",
          clientName: "—",
          user: { id: guard.session.userId, email: guard.session.user?.email ?? null, role: guard.session.baseRole },
        }),
      },
    );
    const reply = safeGuideLinks(text.trim()).slice(0, 1500);
    if (!reply) return NextResponse.json({ error: "Le guide n'a pas répondu, réessayez." }, { status: 502 });
    return NextResponse.json({ reply });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Guide indisponible" }, { status: 502 });
  }
}
