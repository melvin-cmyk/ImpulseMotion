/**
 * POST /api/mo/[id]/quick { message } → the quick path of Mo: the asks the
 * browser recognised (lib/mo/intents.ts parseQuickIntent — créas or figures of
 * a named client over a period) run here at once, without the model: the tool
 * posts its card, Mo's sentence is templated. 3 seconds instead of 20.
 *   → 200 { say, cardIds }      the turn is stored on the board like any other
 *   → 204                       not a quick ask after all (the browser then goes the normal way)
 *   → 409                       Mo is already answering on this board
 * The sentence is re-parsed here against the caller's own client list: the
 * browser's reading is a hint, never an authority.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry } from "@/lib/clients/registry";
import { runningJobOf } from "@/lib/ai-jobs";
import { parseQuickIntent } from "@/lib/mo/intents";
import { appendMoAnswer, appendMoUserMessage, loadBoard } from "@/lib/mo/thread";
import { MoToolError, runMoTool } from "@/lib/mo/tools";

export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const board = await loadBoard(id, guard.session.userId);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { message?: unknown };
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 400) : "";
  if (!message) return NextResponse.json({ error: "message requis" }, { status: 400 });
  if (await runningJobOf(board.id, guard.session.userId)) return NextResponse.json({ error: "Mo répond déjà." }, { status: 409 });

  const scope = await getAccountScope(guard.session);
  const clients = await listClientRegistry(scope);
  const quick = parseQuickIntent(message, clients.map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId })));
  if (!quick) return new NextResponse(null, { status: 204 });

  const t0 = Date.now();
  const at = new Date().toISOString();
  await appendMoUserMessage(board.id, message, at);
  const user = await prisma.user.findUnique({ where: { id: guard.session.userId }, select: { role: true, email: true, name: true } });
  let say = quick.say;
  let detail = "";
  try {
    const result = await runMoTool({ userId: guard.session.userId, boardId: board.id, role: user?.role ?? guard.session.role ?? "", email: user?.email ?? null, name: user?.name ?? null }, quick.kind, quick.args);
    const r = result as { count?: number; note?: string; coverage?: string; totals?: Record<string, string>; posted_card?: string; posted_cards?: string[] };
    if (quick.kind === "creatives") {
      if (!r.count) say = `Je ne trouve aucune créa de ${quick.client.name} ${quick.periodLabel}.`;
      else if (r.note) say = `Rien de lancé ${quick.periodLabel} chez ${quick.client.name} : voilà les ${r.count} créas qui ont diffusé.`;
      else say = say.replace("Voilà les créas", `Voilà les ${r.count} créas`).replace(`Voilà les ${r.count} créas de`, r.count === 1 ? "Voilà la créa de" : `Voilà les ${r.count} créas de`);
    } else if (r.totals) {
      const main = Object.entries(r.totals).slice(0, 3).map(([k, v]) => `${k} ${v.replace(/\s*\(.*\)$/, "")}`).join(", ");
      say = `${quick.client.name} ${quick.periodLabel} : ${main}.`;
      detail = Object.entries(r.totals).map(([k, v]) => `${k}: ${v}`).join(" · ");
    }
    if (r.coverage && /échec|erreur|partielle|jamais/.test(r.coverage)) say += ` Attention, ${r.coverage}.`;
  } catch (e) {
    const msg = e instanceof MoToolError ? e.message : "l'entrepôt n'a pas répondu";
    say = `Je n'ai pas pu : ${msg}`;
  }
  // Stored like a model turn (the ```mo block keeps the thread readable for the model later).
  const stored = await appendMoAnswer(board.id, "```mo\n" + JSON.stringify({ say, cards: [], quick: quick.kind, ...(detail ? { detail } : {}) }) + "\n```", new Date().toISOString());
  console.log(`[mo/quick] ${quick.kind} ${Date.now() - t0} ms`);
  return NextResponse.json({ say: stored?.say ?? say, cardIds: stored?.cardIds ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
