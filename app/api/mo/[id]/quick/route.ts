/**
 * POST /api/mo/[id]/quick { message, cardId?, retried? } → the quick path of Mo:
 * what the browser recognised (lib/mo/intents.ts) runs here at once, without
 * the model — the créas or the figures of a named client (parseQuickIntent),
 * and the follow-ups on the card at hand (parseFollowUpQuick): « deux autres
 * comme ça » (generation with the card's visuals as references), « compare
 * avec la semaine d'avant » (two KPI cards linked by `ref`), « montre les
 * pubs de La Fourche » / « les concurrents de X » (Ad Library). Mo's sentence
 * is templated. One read of the board, one write (lib/mo/thread.ts
 * storeMoQuickTurn); the answer carries the whole board so the browser shows
 * the cards without a second round trip.
 *   → 200 { say, cardIds, cards, messages, turnId }
 *   → 204                        not a quick ask after all (the browser then goes the normal way)
 *   → 409                        Mo is already answering on this board
 *   → 428 { needs, question, options? }  one thing missing (the client, the brands, a creatives card): the browser asks with chips
 * The sentence is re-parsed here against the caller's own client list: the
 * browser's reading is a hint, never an authority. Each turn is measured
 * (MoTurn, path quick).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { listClientRegistry, type ClientRef } from "@/lib/clients/registry";
import { runningJobOf } from "@/lib/ai-jobs";
import { parseFactoryIntent, parseFollowUpQuick, parseQuickIntent, withClientAliases, type FactoryIntent, type IntentClient, type QuickFollowUp, type QuickIntent } from "@/lib/mo/intents";
import { cardClientOf, cardPeriodOf, warehouseAdOf } from "@/lib/mo/act";
import { competitorsFromBrief, moreLikeThisPrompt } from "@/lib/mo/brief";
import { newCardId, type MoCard, type MoCardSpec } from "@/lib/mo/model";
import type { LayoutItem } from "@/lib/mo/frames";
import { loadBoard, parseMoCards, storeMoQuickTurn } from "@/lib/mo/thread";
import { recordMoTurn } from "@/lib/mo/turns";
import { MoToolError, runMoTool, periodRange, type MoToolContext } from "@/lib/mo/tools";
import { isHqContextFresh } from "@/lib/hq-client-context";

// A fabrique generation runs passes of ≤ 12 images (1-3 min).
export const maxDuration = 300;

const NO_STORE = { headers: { "Cache-Control": "no-store" } };
type ToolResult = Record<string, unknown>;
const specsOf = (r: ToolResult): MoCardSpec[] => (Array.isArray(r.card_specs) ? (r.card_specs as MoCardSpec[]) : []);
const freshest = <T extends MoCard>(list: T[]): T | null => [...list].sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))[0] ?? null;
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { message?: unknown; cardId?: unknown; retried?: unknown };
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 400) : "";
  if (!message) return NextResponse.json({ error: "message requis" }, { status: 400 });
  const hintCardId = typeof body.cardId === "string" && /^[a-z0-9]{3,24}$/i.test(body.cardId) ? body.cardId : null;
  const askedAt = new Date().toISOString();
  const t0 = Date.now();

  // Everything about the caller in parallel: the board, a running turn, the account, the scope (then the registry, cached 60 s).
  const [board, running, user, scope] = await Promise.all([
    loadBoard(id, guard.session.userId),
    runningJobOf(id, guard.session.userId),
    prisma.user.findUnique({ where: { id: guard.session.userId }, select: { role: true, email: true, name: true } }),
    getAccountScope(guard.session),
  ]);
  if (!board) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (running) return NextResponse.json({ error: "Mo répond déjà." }, { status: 409 });
  const registry = await listClientRegistry(scope);
  const clients = withClientAliases(registry.map((c) => ({ id: c.id, name: c.name, dashboardId: c.dashboardId, aliasIds: c.aliasIds })));

  const cards = parseMoCards(board.cardsJson);
  const hinted = hintCardId ? cards.find((c) => c.id === hintCardId) ?? null : null;
  // A fabrique step over its copies table (the browser hints the table; else the freshest one when nothing else matches).
  const fx = parseFactoryIntent(message);
  const copiesTables = cards.filter((c) => c.type === "table" && typeof c.runId === "string");
  const factoryCard = fx ? (hinted?.type === "table" && hinted.runId ? hinted : null) : null;
  const quick = factoryCard ? null : parseQuickIntent(message, clients);
  // An « ask » (one element missing) is settled in the browser with chips: here it is not a quick ask.
  if (quick?.kind === "ask") return new NextResponse(null, { status: 204 });
  const plan: QuickIntent | QuickFollowUp | FactoryIntent | null = factoryCard && fx ? fx : quick ?? parseFollowUpQuick(message, clients) ?? (fx && copiesTables.length ? fx : null);
  if (!plan) return new NextResponse(null, { status: 204 });
  const copiesCard = factoryCard ?? freshest(copiesTables);

  const ctx: MoToolContext = { userId: guard.session.userId, boardId: board.id, role: user?.role ?? guard.session.role ?? "", email: user?.email ?? null, name: user?.name ?? null, registry: { scope, clients: registry } };
  const refOf = (c: IntentClient) => registry.find((r) => r.id === c.id) ?? null;

  let say = plan.say;
  let detail = "";
  let specs: LayoutItem[] = [];
  let kind: string = plan.kind;
  // The fabrique tools rewrite the copies table on the board themselves: the board is read again before the turn is stored.
  let touched = false;
  try {
    switch (plan.kind) {
      case "factory_approve": case "factory_generate": case "factory_repropose": {
        const runId = copiesCard?.runId;
        if (!runId) return new NextResponse(null, { status: 204 });
        const clientName = copiesCard?.clientName ?? "le client";
        if (plan.kind === "factory_approve") {
          const r = await runMoTool(ctx, "factory_approve", { run: runId, ...(plan.numbers === "all" ? { all: true } : { numbers: plan.numbers }) }) as { approved?: number; total?: number; suggested_images?: number };
          touched = true;
          const n = r.suggested_images ?? 8;
          say = `${r.approved ?? 0} copy${(r.approved ?? 0) > 1 ? "s" : ""} validé${(r.approved ?? 0) > 1 ? "s" : ""} sur ${r.total ?? 0}. Je génère ${n} visuels, environ ${(n * 0.06).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} dollars ?`;
          specs = [{ type: "ask", title: "Combien de visuels ?", question: `Combien de visuels pour ${clientName} ?`, options: [`Génère ${n} visuels`, ...(n !== 4 ? ["Génère 4 visuels"] : []), ...(n < 16 ? ["Génère 16 visuels"] : []), "Repropose les copys"].slice(0, 4), runId, ...(copiesCard?.clientId ? { clientId: copiesCard.clientId, clientName } : {}) }];
        } else if (plan.kind === "factory_generate") {
          const r = await runMoTool(ctx, "factory_generate", { run: runId, ...(plan.n ? { n: plan.n } : {}), post: false }) as { generated?: number; failed?: number; remaining?: number; cost_usd?: number | null; warnings?: string[] };
          specs = specsOf(r);
          const cost = typeof r.cost_usd === "number" ? `, ${r.cost_usd.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} dollars` : "";
          say = r.generated ? `${r.generated} visuels prêts pour ${clientName}${cost}${r.failed ? `, ${r.failed} en échec` : ""}${r.remaining ? `. Il en reste ${r.remaining} : dis « génère » pour continuer` : ""}.` : `Aucun visuel n'a pu être généré${r.warnings?.[0] ? ` : ${r.warnings[0]}` : ""}.`;
          detail = (r.warnings ?? []).join(" · ");
        } else {
          const r = await runMoTool(ctx, "factory_propose", { run: runId }) as { proposed?: number; error?: string };
          touched = true;
          say = r.error ? `Je n'ai pas pu reproposer : ${r.error}` : `${r.proposed ?? 0} copys dans la table, les validés sont restés.`;
        }
        break;
      }

      case "creatives": case "metrics": {
        const r = await runMoTool(ctx, plan.kind, { ...plan.args, post: false });
        specs = specsOf(r);
        const res = r as { count?: number; note?: string; coverage?: string; totals?: Record<string, string> };
        if (plan.kind === "creatives") {
          if (!res.count) say = `Je ne trouve aucune créa de ${plan.client.name} ${plan.periodLabel}.`;
          else if (res.note) say = `Rien de lancé ${plan.periodLabel} chez ${plan.client.name} : voilà les ${res.count} créas qui ont diffusé.`;
          else say = say.replace("Voilà les créas", `Voilà les ${res.count} créas`).replace(`Voilà les ${res.count} créas de`, res.count === 1 ? "Voilà la créa de" : `Voilà les ${res.count} créas de`);
        } else if (res.totals) {
          const main = Object.entries(res.totals).slice(0, 3).map(([k, v]) => `${k} ${v.replace(/\s*\(.*\)$/, "")}`).join(", ");
          say = `${plan.client.name} ${plan.periodLabel} : ${main}.`;
          detail = Object.entries(res.totals).map(([k, v]) => `${k}: ${v}`).join(" · ");
        }
        if (res.coverage && /échec|erreur|partielle|jamais/.test(res.coverage)) say += ` Attention, ${res.coverage}.`;
        break;
      }

      case "compare": {
        // The KPI card at hand gives the client and the period compared from; the sentence names the other period.
        const kpiCards = cards.filter((c): c is Extract<MoCard, { type: "kpis" }> => c.type === "kpis");
        const base = hinted?.type === "kpis" ? hinted : plan.client ? freshest(kpiCards.filter((c) => cardClientOf(c, clients)?.id === plan.client!.id)) ?? freshest(kpiCards) : freshest(kpiCards);
        const client = plan.client ?? (base ? cardClientOf(base, clients) : null);
        if (!client) return NextResponse.json({ needs: "client", question: "Pour quel client ?", options: clients.map((c) => c.name).slice(0, 40) }, { status: 428, ...NO_STORE });
        const basePeriod = base && cardClientOf(base, clients)?.id === client.id ? cardPeriodOf(base) : null;
        const cur = basePeriod ?? periodRange({ period: "this_week" });
        const days = Math.round((Date.parse(cur.until) - Date.parse(cur.since)) / 86_400_000) + 1;
        const prev = plan.period === "previous" ? periodRange({ since: shift(cur.since, -days), until: shift(cur.since, -1) }) : periodRange({ period: plan.period });
        const [a, b] = await Promise.all([
          basePeriod && base ? Promise.resolve(null) : runMoTool(ctx, "metrics", { client: client.id, since: cur.since, until: cur.until, post: false }),
          runMoTool(ctx, "metrics", { client: client.id, since: prev.since, until: prev.until, compare: false, post: false, title: `${client.name} — ${plan.periodLabel}` }),
        ]);
        const curSpecs = a ? specsOf(a) : [];
        const curId = base && !a ? base.id : newCardId();
        const prevSpecs = specsOf(b).map((s, i) => (i === 0 ? { ...s, ref: curId } : s));
        specs = [...curSpecs.map((s, i): LayoutItem => (i === 0 ? { ...s, id: curId } : s)), ...prevSpecs];
        const tA = (a ?? {}) as { totals?: Record<string, string> }; const tB = b as { totals?: Record<string, string> };
        const spendA = tA.totals?.Dépense?.replace(/\s*\(.*\)$/, "") ?? (base?.type === "kpis" ? base.items.find((k) => k.label === "Dépense")?.value : undefined);
        const spendB = tB.totals?.Dépense?.replace(/\s*\(.*\)$/, "");
        const costA = (tA.totals?.CPA ?? tA.totals?.CPL)?.replace(/\s*\(.*\)$/, "") ?? (base?.type === "kpis" ? base.items.find((k) => k.label === "CPA" || k.label === "CPL")?.value : undefined);
        const costB = (tB.totals?.CPA ?? tB.totals?.CPL)?.replace(/\s*\(.*\)$/, "");
        say = `${client.name}, ${plan.periodLabel} à côté : dépense ${spendB ?? "—"} contre ${spendA ?? "—"}${costA && costB ? `, coût par résultat ${costB} contre ${costA}` : ""}.`;
        detail = `${cur.since} → ${cur.until} vs ${prev.since} → ${prev.until}`;
        break;
      }

      case "more_like_this": {
        const creatives = cards.filter((c): c is Extract<MoCard, { type: "creatives" }> => c.type === "creatives" && c.items.length > 0);
        const card = hinted?.type === "creatives" && hinted.items.length ? hinted : freshest(creatives);
        if (!card) return NextResponse.json({ needs: "card", question: "Montre-moi d'abord des créas : je m'en inspirerai." }, { status: 428, ...NO_STORE });
        const client = cardClientOf(card, clients);
        if (!client) return NextResponse.json({ needs: "client", question: "Pour quel client ?", options: clients.map((c) => c.name).slice(0, 40) }, { status: 428, ...NO_STORE });
        // References: the visuals kept first, else the first ones of the card (3 at most, assets or warehouse ads, else their https picture).
        const kept = card.items.filter((it) => it.verdict === "keep");
        const pool = (kept.length ? kept : card.items.filter((it) => it.verdict !== "cut")).slice(0, 3);
        const references = pool.map((it) => it.assetId ?? (warehouseAdOf(it) ? `${warehouseAdOf(it)!.platform}:${warehouseAdOf(it)!.adId}` : it.templateId ?? (it.image && /^https:\/\//.test(it.image) ? it.image : null))).filter((v): v is string => !!v);
        const names = pool.map((it) => it.name);
        const prompt = moreLikeThisPrompt({ clientName: client.name, names, notes: pool.map((it) => it.note ?? "").filter(Boolean), style: plan.style, n: plan.n });
        const r = await runMoTool(ctx, "generate_creatives", { client: client.id, prompt, n: plan.n, references, names: Array.from({ length: plan.n }, (_, k) => `${plan.style ? `${plan.style.charAt(0).toUpperCase()}${plan.style.slice(1)}` : "Variante"} ${k + 1}`), inspired_by: names, title: `${plan.n} ${plan.n > 1 ? "nouvelles créas" : "nouvelle créa"} ${client.name}${plan.style ? ` · ${plan.style}` : ""}`, post: false });
        specs = specsOf(r);
        const res = r as { generated?: number; engine?: string; brief_hq?: boolean; note?: string; drive_error?: string };
        say = `Voilà ${res.generated ?? plan.n} ${res.generated === 1 ? "visuel inspiré" : "visuels inspirés"} de ${names.slice(0, 2).map((n) => `« ${n} »`).join(" et ")} pour ${client.name}${res.brief_hq ? ", brief HQ respecté" : ""}.`;
        detail = [res.engine ? `moteur ${res.engine}` : "", res.note ?? "", res.drive_error ? `Drive : ${res.drive_error}` : ""].filter(Boolean).join(" · ");
        kind = "more_like_this";
        break;
      }

      case "competitor_ads": {
        let brands = plan.brands;
        const client = plan.client ? refOf(plan.client) : null;
        if (!brands.length && client) {
          brands = competitorsFromBrief(await cachedBrief(client));
          if (!brands.length) return NextResponse.json({ needs: "brands", question: `Quels concurrents de ${client.name} ? (la mémoire HQ n'en nomme aucun)` }, { status: 428, ...NO_STORE });
        }
        if (!brands.length) return NextResponse.json({ needs: "brands", question: "Quelle marque ?" }, { status: 428, ...NO_STORE });
        const results = await Promise.allSettled(brands.slice(0, 3).map((brand) => runMoTool(ctx, "competitor_ads", { query: brand, post: false })));
        const counts: string[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") { specs.push(...specsOf(r.value).map((s) => (client ? { ...s, clientId: client.id, clientName: client.name } : s))); const n = typeof r.value.count === "number" ? r.value.count : 0; counts.push(`${n} pub${n > 1 ? "s" : ""} de ${brands[i]}`); }
          else counts.push(`${brands[i]} : ${r.reason instanceof Error ? r.reason.message.slice(0, 80) : "échec"}`);
        });
        say = specs.length ? `Voilà ${counts.join(", ")} en ce moment dans la bibliothèque Meta.` : `Je ne trouve aucune pub active pour ${brands.join(" ni ")}.`;
        break;
      }
    }
  } catch (e) {
    const msg = e instanceof MoToolError ? e.message : "l'entrepôt n'a pas répondu";
    if (!(e instanceof MoToolError)) console.error(`[mo/quick] ${plan.kind} failed`, e);
    say = `Je n'ai pas pu : ${msg}`;
    specs = [];
  }

  // Stored like a model turn (the ```mo block keeps the thread readable for the model later), in one write.
  const stored = await storeMoQuickTurn(touched ? (await loadBoard(id, guard.session.userId)) ?? board : board, { userText: message, askedAt, text: "```mo\n" + JSON.stringify({ say, cards: [], quick: kind, ...(detail ? { detail } : {}) }) + "\n```", specs, at: new Date().toISOString() });
  const totalMs = Date.now() - t0;
  const turnId = await recordMoTurn({ userId: guard.session.userId, boardId: board.id, path: "quick", kind, totalMs, firstCardMs: stored.cardIds.length ? totalMs : null, retried: body.retried === true });
  console.log(`[mo/quick] ${kind} ${totalMs} ms`);
  return NextResponse.json({ say: stored.say, cardIds: stored.cardIds, cards: stored.cards, messages: stored.messages, turnId }, NO_STORE);
}

/** The HQ brief cached on one of the client's dashboards (7 days), or null — never a new HQ call here. */
async function cachedBrief(client: ClientRef): Promise<string | null> {
  const ids = [client.dashboardId, ...client.dashboardIds].filter((v): v is string => !!v);
  if (!ids.length) return null;
  const rows = await prisma.dashboard.findMany({ where: { id: { in: ids }, hqContextMd: { not: null } }, select: { hqContextMd: true, hqContextAt: true }, orderBy: { hqContextAt: "desc" }, take: 3 });
  return rows.find((d) => isHqContextFresh(d))?.hqContextMd ?? rows[0]?.hqContextMd ?? null;
}
