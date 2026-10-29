/**
 * Mo's hands for the fabrique de statics (lib/creas/*), called through
 * lib/mo/tools.ts runMoTool, as the consultant who speaks:
 *
 *   brand_playbook     study a brand's ads in the Meta Ad Library → its recurring formats; posts the ads read
 *                      (numbered, format under each) and a note with the playbook; « garde la 2 » on the card
 *                      keeps one as a template (analysis reused).
 *   factory_propose    a new fabrique for a client on N templates (given, or the client's latest ones): context
 *                      assembled, copies proposed by the AI → a « Copys à valider » table (runId on the card),
 *                      a « Contexte » note (sources read) and an ask card with chips. With `run`: propose again.
 *   factory_approve    « valide tout », « valide 1 à 5 », « valide 1, 4 et 7 »: those copies approved, the
 *                      others rejected; the table is rewritten in place (✓ column).
 *   factory_generate   the visuals of the approved copies (fal, passes of ≤ 12, quotas), until done or 200 s;
 *                      a creatives card of the visuals (keep / cut / publish work on it as on any card).
 */

import { prisma } from "@/lib/prisma";
import { postMoCards, rewriteMoCard, parseMoCards } from "@/lib/mo/thread";
import type { MoCard, MoCardSpec } from "@/lib/mo/model";
import { CONTEXT_SOURCE_LABEL, FACTORY_KINDS, FACTORY_KIND_LABEL, MAX_RUN_IMAGES, type FactoryKind } from "@/lib/creas/model";
import { FactoryError, createRun, generatePass, loadRun, loadRunTemplates, proposeCopies, runCopies, updateCopies, type FactoryClient, type FactoryUser } from "@/lib/creas/factory";
import { parseIdList } from "@/lib/creas/model";
import { PlaybookError, studyBrand } from "@/lib/creas/playbook";
import { pickByNumbers } from "@/lib/creas/playbook-doc";
import type { FactoryCopy, FactoryRun } from "@prisma/client";

type Args = Record<string, unknown>;
type ToolResult = Record<string, unknown>;

export interface FactoryToolDeps {
  ctx: { userId: string; boardId: string; role: string; email: string | null; name: string | null };
  /** The client named, resolved under the consultant's ACL (lib/mo/tools.ts resolveClient). */
  resolve: (raw: unknown) => Promise<{ id: string; clientId: string; name: string; hqSlug: string | null }>;
  error: (message: string, status?: number) => Error;
}

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const assetImage = (id: string) => `/api/studio/assets/${id}/file?inline=1`;
const GENERATE_BUDGET_MS = 200_000;
const MO_DEFAULT_IMAGES = 8;

async function userOf(d: FactoryToolDeps): Promise<FactoryUser> {
  const u = await prisma.user.findUnique({ where: { id: d.ctx.userId }, select: { name: true, email: true } });
  return { id: d.ctx.userId, email: d.ctx.email ?? u?.email ?? null, role: d.ctx.role, name: (u?.name ?? d.ctx.name ?? "").trim() || u?.email || "Consultant" };
}

// ── Copies table ───────────────────────────────────────────────────────────

/** The « Copys à valider » table of a run: one numbered row per copy, ✓ for the approved ones. */
export function copiesCard(run: Pick<FactoryRun, "id" | "alertClientId" | "clientName" | "kind">, copies: FactoryCopy[], templateNames: Map<string, string>, clientRef: { id: string; name: string }): MoCardSpec {
  const approved = copies.filter((c) => c.status === "approved").length;
  return {
    type: "table", runId: run.id, clientId: clientRef.id, clientName: clientRef.name,
    title: `Copys à valider — ${run.clientName}`,
    subtitle: `Fabrique ${FACTORY_KIND_LABEL[(FACTORY_KINDS as readonly string[]).includes(run.kind) ? (run.kind as FactoryKind) : "offer"]} · ${copies.length} propositions${approved ? ` · ${approved} validée${approved > 1 ? "s" : ""}` : ""} · « valide 1 à 5 » ou « valide tout »`,
    columns: ["N°", "✓", "Titre", "Sous-titre", "Bouton", "Angle", "Template", "Source"],
    rows: copies.slice(0, 60).map((c, i) => [String(i + 1), c.status === "approved" ? "✓" : c.status === "rejected" ? "✗" : "", c.headline, c.subline, c.cta, c.angle, templateNames.get(c.templateId ?? "") ?? "", c.voiceSource]),
  };
}

async function templateNames(run: FactoryRun): Promise<Map<string, string>> {
  const ts = await loadRunTemplates(parseIdList(run.templateIdsJson));
  return new Map(ts.map((t, i) => [t.id, `T${i + 1} ${t.name}`.slice(0, 40)]));
}

/** The run a sentence is about: the one given, else the one of the freshest card carrying a runId on this board, else the consultant's latest. */
async function runOf(d: FactoryToolDeps, raw: unknown): Promise<{ run: FactoryRun; cardId: string | null }> {
  const given = str(raw, 40);
  const board = await prisma.moBoard.findUnique({ where: { id: d.ctx.boardId }, select: { cardsJson: true } });
  const cards = parseMoCards(board?.cardsJson).filter((c): c is MoCard & { runId: string } => typeof c.runId === "string");
  const tableOf = (runId: string) => [...cards].filter((c) => c.runId === runId && c.type === "table").sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.id ?? null;
  if (given) {
    const run = await loadRun(given);
    if (!run) throw d.error(`Fabrique ${given} introuvable.`, 404);
    return { run, cardId: tableOf(run.id) };
  }
  const fresh = [...cards].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (fresh) { const run = await loadRun(fresh.runId); if (run) return { run, cardId: tableOf(run.id) }; }
  const last = await prisma.factoryRun.findFirst({ where: { createdById: d.ctx.userId }, orderBy: { createdAt: "desc" } });
  if (!last) throw d.error("Aucune fabrique en cours : dis-moi pour quel client et sur quels templates (factory_propose).", 404);
  return { run: last, cardId: null };
}

// ── Tools ──────────────────────────────────────────────────────────────────

export async function brandPlaybook(d: FactoryToolDeps, a: Args): Promise<ToolResult> {
  const brand = str(a.brand ?? a.query, 100);
  if (brand.length < 2) throw d.error("Dis-moi la marque à étudier (brand).");
  const client = a.client ? await d.resolve(a.client) : null;
  const user = await userOf(d);
  let p;
  try { p = await studyBrand({ brand, country: str(a.country, 2) || undefined, limit: num(a.limit) ?? undefined, fresh: a.fresh === true, user }); }
  catch (e) { if (e instanceof PlaybookError) throw d.error(e.message, e.status); throw e; }
  const cands = p.candidates.slice(0, 24);
  const poly = new Set(p.formats.filter((f) => f.verdict === "polyvalent").map((f) => f.label));
  const ads: MoCardSpec = {
    type: "creatives", title: `Playbook ${p.brand} — ${p.formats.length} format${p.formats.length > 1 ? "s" : ""}`, subtitle: `Bibliothèque Meta · ${p.country} · ${p.analysed} pubs lues sur ${p.total} · « garde la 2 » = template${client ? ` de ${client.name}` : ""}`,
    ...(client ? { clientId: client.id, clientName: client.name } : {}),
    items: cands.map((c, i) => ({ name: `${i + 1}. ${c.format}`, ...(c.image ? { image: c.image } : {}), adId: `adlib:${c.libraryId}`, metrics: { Format: c.format, ...(poly.has(c.format) ? { Usage: "polyvalent" } : {}), ...(c.video ? { Type: "vidéo" } : {}) }, ...(c.analysis.hook ? { note: c.analysis.hook.slice(0, 160) } : {}), link: c.snapshotUrl ?? `https://www.facebook.com/ads/library/?id=${c.libraryId}` })),
  };
  const note: MoCardSpec = { type: "note", title: `Formats de ${p.brand}`, subtitle: `Étude du ${new Date(p.at).toLocaleDateString("fr-FR")} (cache 7 jours)`, ...(client ? { clientId: client.id, clientName: client.name } : {}), markdown: p.md.replace(/^# .*\n/, "").slice(0, 5800) };
  const posted = a.post === false ? [] : await postMoCards(d.ctx.boardId, [ads, note]);
  return {
    brand: p.brand, country: p.country, total: p.total, analysed: p.analysed,
    formats: p.formats.map((f) => ({ label: f.label, count: f.count, share: `${f.share} %`, verdict: f.verdict, numbers: cands.map((c, i) => (c.format === f.label ? i + 1 : 0)).filter(Boolean) })),
    ...(posted.length ? { posted_cards: posted, posted: "Les cartes sont DÉJÀ sur le tableau : dis en une phrase les 2-3 formats qui reviennent le plus et lesquels sont polyvalents ; propose de garder les meilleurs (« garde la 2 »)." } : { card_specs: [ads, note] }),
    ads: cands.map((c, i) => ({ n: i + 1, libraryId: c.libraryId, format: c.format, hook: c.analysis.hook, image: c.image })),
    next: "Pour garder des pubs comme templates : keep_template avec imageUrl (et le client), ou la personne dit « garde la 2 » sur la carte. Ensuite factory_propose avec les templateId.",
  };
}

export async function factoryPropose(d: FactoryToolDeps, a: Args): Promise<ToolResult> {
  const user = await userOf(d);
  // Again on an existing run (« repropose »): the approved copies stay.
  if (a.run || a.again === true) {
    const { run, cardId } = await runOf(d, a.run);
    if (run.status !== "copy_review") throw d.error("Les copys ne se reproposent plus une fois la génération lancée.", 409);
    const out = await proposeCopies(run, await loadRunTemplates(parseIdList(run.templateIdsJson)), user);
    const ref = { id: run.alertClientId, name: run.clientName };
    const spec = copiesCard(run, out.copies, await templateNames(run), cardId ? await clientRefOfCard(d, cardId, ref) : ref);
    const posted = cardId ? (await rewriteMoCard(d.ctx.boardId, cardId, (c) => ({ ...c, ...spec } as MoCard)) ? [cardId] : []) : await postMoCards(d.ctx.boardId, [spec]);
    return { runId: run.id, proposed: out.copies.length, ...(out.error ? { error: out.error } : {}), posted_cards: posted, posted: "La table est à jour sur le tableau : dis combien de nouvelles propositions." };
  }
  const client = await d.resolve(a.client);
  const factoryClient: FactoryClient = { id: client.clientId, name: client.name, hqSlug: client.hqSlug };
  let templateIds = (Array.isArray(a.templateIds) ? a.templateIds : []).map((x) => str(x, 40)).filter((x) => /^[a-z0-9]{10,40}$/i.test(x)).slice(0, 12);
  if (!templateIds.length) {
    const tag = str(a.tag, 60);
    const rows = await prisma.creativeTemplate.findMany({ where: { alertClientId: client.clientId, deletedAt: null, retiredAt: null, file: { not: null }, ...(tag ? { tags: { contains: tag } } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(12, Math.max(1, Math.round(num(a.templates) ?? 4))), select: { id: true } });
    templateIds = rows.map((r) => r.id);
  }
  if (!templateIds.length) throw d.error(`${client.name} n'a aucun template avec image : garde d'abord des pubs (competitor_ads puis keep_template, ou brand_playbook).`, 404);
  const kind: FactoryKind = (["offer", "evergreen", "iteration"] as string[]).includes(str(a.kind)) ? (str(a.kind) as FactoryKind) : "evergreen";
  let out;
  try {
    out = await createRun(factoryClient, user, { kind, templateIds, perTemplate: num(a.per_template) ?? 3, instructions: str(a.instructions, 1500), persona: str(a.persona, 200), season: str(a.season, 200), reviews: str(a.reviews, 20_000) });
  } catch (e) { if (e instanceof FactoryError) throw d.error(e.message, e.status); throw e; }
  const run = (await loadRun(out.run.id))!;
  const copies = await runCopies(run.id);
  const ref = { id: client.id, name: client.name };
  const table = copiesCard(run, copies, new Map(out.templates.map((t, i) => [t.id, `T${i + 1} ${t.name}`.slice(0, 40)])), ref);
  const sources = out.run.sources.filter((s) => s.kind !== "instructions").map((s) => `- ${s.kind === "templates" ? `${s.ref.split(",").length} templates` : CONTEXT_SOURCE_LABEL[s.kind] ?? s.kind}${s.note ? ` (${s.note})` : ""} — ${s.chars.toLocaleString("fr-FR")} car.${s.ref && s.kind !== "templates" && s.ref.length < 90 ? ` · ${s.ref}` : ""}`);
  const context: MoCardSpec = { type: "note", title: `Contexte lu — ${client.name}`, subtitle: "Ce que l'IA a lu avant d'écrire les copys", clientId: client.id, clientName: client.name, runId: run.id, markdown: [sources.join("\n") || "- (aucune source : brief HQ absent, pas d'entrepôt)", "", `Ouvrir la fabrique : /creas?client=${client.clientId}&tab=fabrique&run=${run.id}`].join("\n") };
  const n = copies.length;
  const ask: MoCardSpec = { type: "ask", title: "Quels copys je garde ?", clientId: client.id, clientName: client.name, runId: run.id, question: `${n} copys proposés : lesquels je valide ?`, options: [n ? "Valide tout" : "Repropose les copys", ...(n > 3 ? [`Valide 1 à ${Math.min(n, Math.ceil(n / 2))}`] : []), "Repropose les copys"].filter((v, i, all) => all.indexOf(v) === i).slice(0, 4) };
  const posted = n && a.post !== false ? await postMoCards(d.ctx.boardId, [table, context, ask]) : [];
  return {
    runId: run.id, client: { id: client.id, name: client.name }, kind, templates: out.templates.map((t, i) => ({ n: i + 1, id: t.id, name: t.name })),
    copies: copies.map((c, i) => ({ n: i + 1, headline: c.headline, subline: c.subline, cta: c.cta, angle: c.angle, source: c.voiceSource })),
    ...(out.error ? { error: out.error } : {}),
    ...(posted.length ? { posted_cards: posted, posted: "La table des copys, la note de contexte et les puces sont DÉJÀ sur le tableau : dis en une phrase combien de copys, sur combien de templates, et demande lesquels valider." } : {}),
    next: "La personne valide (« valide 1 à 5 ») → factory_approve ; puis factory_generate.",
  };
}

async function clientRefOfCard(d: FactoryToolDeps, cardId: string, fallback: { id: string; name: string }): Promise<{ id: string; name: string }> {
  const board = await prisma.moBoard.findUnique({ where: { id: d.ctx.boardId }, select: { cardsJson: true } });
  const c = parseMoCards(board?.cardsJson).find((x) => x.id === cardId);
  return c?.clientId && c.clientName ? { id: c.clientId, name: c.clientName } : fallback;
}

/** Numbers said (1-based) → copies; `all` → every copy. */
export async function factoryApprove(d: FactoryToolDeps, a: Args): Promise<ToolResult> {
  const { run, cardId } = await runOf(d, a.run);
  if (run.status !== "copy_review" && run.status !== "approved") throw d.error(`Cette fabrique est déjà « ${run.status} » : les copys ne changent plus.`, 409);
  const copies = await runCopies(run.id);
  if (!copies.length) throw d.error("Aucun copy à valider sur cette fabrique : repropose d'abord.", 400);
  const numbers = (Array.isArray(a.numbers) ? a.numbers : []).map((x) => num(x)).filter((x): x is number => x !== null);
  const all = a.all === true || (!numbers.length && a.all !== false);
  const chosen = new Set((all ? copies : pickByNumbers(copies, numbers)).map((c) => c.id));
  if (!chosen.size) throw d.error(`Numéros hors de la liste (1 à ${copies.length}).`, 400);
  const rejectOthers = a.reject_others !== false;
  const updated = await updateCopies(run, copies.map((c) => ({ id: c.id, ...(chosen.has(c.id) ? { status: "approved" as const } : rejectOthers ? { status: "rejected" as const } : {}) })));
  const approved = updated.filter((c) => c.status === "approved").length;
  if (approved) await prisma.factoryRun.update({ where: { id: run.id }, data: { status: "approved" } });
  const fresh = (await loadRun(run.id))!;
  const ref = cardId ? await clientRefOfCard(d, cardId, { id: run.alertClientId, name: run.clientName }) : { id: run.alertClientId, name: run.clientName };
  const spec = copiesCard(fresh, updated, await templateNames(fresh), ref);
  let posted: string[] = [];
  if (cardId) { const c = await rewriteMoCard(d.ctx.boardId, cardId, (card) => ({ ...card, ...spec } as MoCard)); if (c) posted = [cardId]; }
  else if (a.post !== false) posted = await postMoCards(d.ctx.boardId, [spec]);
  const n = Math.min(MAX_RUN_IMAGES, Math.max(approved, MO_DEFAULT_IMAGES));
  return {
    runId: run.id, approved, rejected: updated.filter((c) => c.status === "rejected").length, total: updated.length, posted_cards: posted,
    suggested_images: n, next: `Propose de lancer la génération : factory_generate (défaut ${n} visuels, ~0,06 $ l'image ; dis le prix).`,
  };
}

export async function factoryGenerate(d: FactoryToolDeps, a: Args): Promise<ToolResult> {
  const { run: initial } = await runOf(d, a.run);
  const user = await userOf(d);
  const client: FactoryClient = { id: initial.alertClientId, name: initial.clientName, hqSlug: (await prisma.alertClient.findUnique({ where: { id: initial.alertClientId }, select: { hqSlug: true } }))?.hqSlug ?? null };
  const approved = (await runCopies(initial.id)).filter((c) => c.status === "approved").length;
  if (!approved) throw d.error("Aucun copy validé : dis d'abord lesquels (« valide 1 à 5 »).", 400);
  const n = Math.min(MAX_RUN_IMAGES, Math.max(1, Math.round(num(a.n) ?? Math.max(approved, MO_DEFAULT_IMAGES))));
  const t0 = Date.now();
  let run = initial;
  let first = true;
  const assets: Array<{ id: string; name: string; templateId: string | null }> = [];
  const warns: string[] = [];
  let remaining = 1;
  let failed = 0;
  let view;
  try {
    while (remaining > 0 && Date.now() - t0 < GENERATE_BUDGET_MS) {
      const pass = await generatePass(run, client, user, first ? { n, engine: str(a.engine, 80) || undefined, ratio: str(a.ratio, 8) || undefined, textless: a.textless === true } : {});
      first = false;
      remaining = pass.remaining; failed += pass.failed; view = pass.run;
      if (pass.warn) warns.push(pass.warn);
      for (const x of pass.assets) assets.push({ id: x.id, name: x.prompt.slice(0, 60), templateId: x.templateId ?? null });
      run = (await loadRun(run.id))!;
    }
  } catch (e) {
    if (e instanceof FactoryError) { if (!assets.length) throw d.error(e.message, e.status); warns.push(e.message); }
    else throw e;
  }
  const board = await prisma.moBoard.findUnique({ where: { id: d.ctx.boardId }, select: { cardsJson: true } });
  const table = parseMoCards(board?.cardsJson).find((c) => c.runId === run.id && c.clientId);
  const ref = table?.clientId && table.clientName ? { id: table.clientId, name: table.clientName } : { id: client.id, name: client.name };
  const open = `/creas?client=${client.id}&tab=fabrique&run=${run.id}`;
  const card: MoCardSpec = {
    type: "creatives", runId: run.id, clientId: ref.id, clientName: ref.name, title: `Fabrique ${client.name} — ${assets.length} visuel${assets.length > 1 ? "s" : ""}`,
    subtitle: `fal · ${view ? `${view.costUsd.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $` : ""}${remaining ? ` · ${remaining} restant${remaining > 1 ? "s" : ""}` : ""} · « garde la 2 », « coupe les deux dernières »`,
    ...(view?.driveLink && /^https:\/\//.test(view.driveLink) ? { link: view.driveLink, linkLabel: "Drive" } : {}),
    items: assets.slice(0, 24).map((x) => ({ name: x.name, image: assetImage(x.id), assetId: x.id, metrics: {}, ...(x.templateId ? { templateId: x.templateId } : {}) })),
  };
  const posted = assets.length && a.post !== false ? await postMoCards(d.ctx.boardId, [card]) : [];
  return {
    runId: run.id, generated: assets.length, failed, remaining, cost_usd: view?.costUsd ?? null, drive: view?.driveLink ?? null, open,
    ...(warns.length ? { warnings: warns.slice(0, 3) } : {}),
    ...(posted.length ? { posted_cards: posted, posted: "La grille est DÉJÀ sur le tableau : dis combien de visuels, le coût, et qu'on peut garder / couper / publier." } : { card_specs: assets.length ? [card] : [] }),
    ...(remaining ? { next: `Il reste ${remaining} visuels : rappelle factory_generate (même run) pour continuer.` } : {}),
  };
}
