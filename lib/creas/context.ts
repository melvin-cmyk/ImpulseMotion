/**
 * Fabrique de statics — the client's context document, server side
 * (assembly rules and rendering in ./context-doc.ts).
 *
 *   collectClientContext(client)  reads everything, in parallel and bounded: the HQ brief cached on the
 *                                 client's dashboards, four HQ files (personas, langage client, voix,
 *                                 concurrents), the client's ads of the last 90 days in the warehouse
 *                                 (winners + angles), comments under the best ads (META_COMMENTS=1 only),
 *                                 the consultants' feedback and verdict notes.
 *   getClientContext(client)      the stored document (FactoryContext, edited by a consultant) or a fresh one.
 *   saveClientContext(...)        stores the consultant's version and, when asked, mirrors it in HQ at
 *                                 projects/{slug}/brain/contenu/statics-context.md under the ETag lock
 *                                 (the UI says what will be written before the click).
 * A run freezes the document in FactoryRun.contextMd (lib/creas/factory.ts).
 */

import { prisma } from "@/lib/prisma";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { queryAds } from "@/lib/ads-warehouse/query";
import type { WarehousePlatform } from "@/lib/ads-warehouse/types";
import { parsePersonaFile, readHqFile, writeHqFile } from "@/lib/hq-persona";
import { readAdComments, metaCommentsOpen } from "@/lib/meta-comments";
import { clientBrandBrief, clientHqProject, type FactoryClient } from "@/lib/creas/factory";
import { parseSources, type ContextSource, type FactoryContextView } from "@/lib/creas/model";
import { HQ_CONTEXT_FILES, cleanEditedDoc, hqMirrorContent, renderClientContext, renderWarehouseSection, winningAngles, type HqFileInput, type WarehouseAdInput } from "@/lib/creas/context-doc";

export const STATICS_CONTEXT_FILE = "brain/contenu/statics-context.md";
const SOURCE_TIMEOUT_MS = 45_000;
const TZ = "Europe/Paris";

const isoParis = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const daysAgo = (n: number) => isoParis(new Date(Date.now() - n * 86_400_000));

/** A source that does not answer in time is dropped, never the whole document. */
function bounded<T>(p: Promise<T>, fallback: T, label: string, warnings: string[]): Promise<T> {
  return Promise.race([
    p.catch((e) => { warnings.push(`${label} : ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`); return fallback; }),
    new Promise<T>((resolve) => setTimeout(() => { warnings.push(`${label} : pas de réponse en ${SOURCE_TIMEOUT_MS / 1000} s`); resolve(fallback); }, SOURCE_TIMEOUT_MS)),
  ]);
}

/** The client's ad accounts as the warehouse names them (Meta without act_, Google without dashes). */
export async function clientWarehouseAccounts(clientId: string): Promise<Array<{ platform: WarehousePlatform; id: string }>> {
  const ac = await prisma.alertClient.findUnique({ where: { id: clientId }, select: { accountsJson: true } });
  return parseAlertAccounts(ac?.accountsJson).map((a) => ({ platform: a.platform as WarehousePlatform, id: a.accountId.replace(/^act_/, "").replace(/-/g, "") }));
}

/** The client's ads of the last 90 days (top 60 by spend), as the winners' analysis needs them. */
async function warehouseAds(clientId: string): Promise<{ ads: WarehouseAdInput[]; metaAdIds: string[]; ref: string; period: string } | null> {
  const all = await clientWarehouseAccounts(clientId);
  // Statics are pictures: the visual platforms speak for them (Google Search ads are text); all platforms only when there is no other.
  const visual = all.filter((a) => a.platform === "meta" || a.platform === "tiktok");
  const accounts = visual.length ? visual : all;
  if (!accounts.length) return null;
  const range = { since: daysAgo(90), until: daysAgo(1) };
  const res = await queryAds({ platforms: [...new Set(accounts.map((a) => a.platform))], accountIds: [...new Set(accounts.map((a) => a.id))], accounts, range, groupBy: "ad", sort: { key: "spend", dir: "desc" }, limit: 60 });
  const ads: WarehouseAdInput[] = res.rows.map((r) => ({
    name: r.sample?.name ?? r.label, title: r.sample?.title ?? null, body: r.sample?.body ?? null,
    spend: r.metrics.spend, conversions: r.metrics.conversions, cpa: r.metrics.cpa, ctr: r.metrics.ctr, roas: r.metrics.roasUnavailable ? null : r.metrics.roas, tags: r.sample?.tags ?? {},
  }));
  const metaAdIds = res.rows.filter((r) => r.sample?.platform === "meta").slice(0, 10).map((r) => r.sample!.adId);
  const platforms = [...new Set(accounts.map((a) => (a.platform === "meta" ? "Meta" : a.platform === "tiktok" ? "TikTok" : a.platform === "google" ? "Google" : a.platform)))].join(" + ");
  return { ads, metaAdIds, ref: `entrepôt ${platforms} ${range.since} → ${range.until}`, period: `${platforms}, 90 derniers jours` };
}

async function hqFiles(slug: string): Promise<HqFileInput[]> {
  const out = await Promise.all(HQ_CONTEXT_FILES.map(async (d) => {
    const path = `projects/${slug}/${d.file}`;
    const f = await readHqFile(path).catch(() => ({ found: false as const }));
    if (!f.found) return null;
    const parsed = parsePersonaFile(f.content);
    // A skeleton (statut manquant, almost no body) says nothing.
    if (parsed.hasFrontmatter && parsed.frontmatter.statut === "manquant" && parsed.body.length < 200) return null;
    const file: HqFileInput = { kind: d.kind, path, content: parsed.body, statut: parsed.hasFrontmatter ? parsed.frontmatter.statut : null };
    return file;
  }));
  return out.filter((x): x is HqFileInput => !!x);
}

/** The document, freshly assembled from every source (≈ 5-20 s: HQ is read through the relay). */
export async function collectClientContext(client: FactoryClient): Promise<{ md: string; sources: ContextSource[]; warnings: string[] }> {
  const warnings: string[] = [];
  const slug = await clientHqProject(client);
  const [brief, files, wh, feedback, verdicts] = await Promise.all([
    bounded(clientBrandBrief(client), "", "Brief HQ", warnings),
    slug ? bounded(hqFiles(slug), [], "Fichiers HQ", warnings) : Promise.resolve([] as HqFileInput[]),
    bounded(warehouseAds(client.id), null, "Entrepôt", warnings),
    prisma.creativeFeedback.findMany({ where: { alertClientId: client.id, level: { in: ["client", "run", "template"] } }, orderBy: { createdAt: "desc" }, take: 20, select: { level: true, text: true } }),
    prisma.creativeAsset.findMany({ where: { alertClientId: client.id, feedback: { in: ["keep", "cut"] }, feedbackNote: { not: null }, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 20, select: { feedback: true, feedbackNote: true } }),
  ]);
  if (!slug) warnings.push("Pas de dossier HQ rattaché à ce client : ni personas, ni langage client, ni miroir HQ.");
  let warehouse: { section: string; ref: string } | null = null;
  if (wh) {
    const w = winningAngles(wh.ads);
    const section = renderWarehouseSection(w, wh.period);
    if (section) warehouse = { section, ref: wh.ref };
    else warnings.push("Entrepôt : pas assez de dépense sur 90 jours pour désigner des gagnantes.");
  } else if (!warnings.some((x) => x.startsWith("Entrepôt"))) warnings.push("Aucun compte publicitaire rattaché à ce client : pas de gagnantes.");
  let comments: string[] = [];
  if (metaCommentsOpen() && wh?.metaAdIds.length) {
    const c = await bounded(readAdComments(wh.metaAdIds), { comments: [], errors: 0 }, "Commentaires Meta", warnings);
    comments = c.comments.slice(0, 40).map((x) => x.text);
    if (c.errors && !comments.length) warnings.push("Commentaires Meta illisibles (Page non assignée au système user ?).");
  }
  const doc = renderClientContext({
    clientName: client.name, brief, hqFiles: files, warehouse, comments,
    feedback: feedback.map((f) => ({ level: f.level, text: f.text })),
    verdictNotes: verdicts.map((v) => `${v.feedback === "keep" ? "gardée" : "coupée"} : ${v.feedbackNote}`),
  });
  return { ...doc, warnings };
}

function view(client: FactoryClient, row: { md: string; sourcesJson: string; updatedAt: Date; hqPath: string | null } | null, fresh: { md: string; sources: ContextSource[]; warnings: string[] } | null, slug: string | null): FactoryContextView {
  return {
    clientId: client.id, md: row?.md ?? fresh?.md ?? "", sources: row ? parseSources(row.sourcesJson) : fresh?.sources ?? [], stored: !!row,
    updatedAt: row?.updatedAt.toISOString() ?? null, hqPath: row?.hqPath ?? null, hqTarget: slug ? `projects/${slug}/${STATICS_CONTEXT_FILE}` : null, warnings: fresh?.warnings ?? [],
  };
}

/** The stored document when there is one (unless `fresh`), else a freshly assembled one (not stored). */
export async function getClientContext(client: FactoryClient, opts: { fresh?: boolean } = {}): Promise<FactoryContextView> {
  const [row, slug] = await Promise.all([prisma.factoryContext.findUnique({ where: { alertClientId: client.id } }), clientHqProject(client)]);
  if (row && !opts.fresh) return view(client, row, null, slug);
  return view(client, null, await collectClientContext(client), slug);
}

/** The document a new run uses: the stored one, else freshly collected (and not stored: storing is the consultant's act). */
export async function contextForRun(client: FactoryClient): Promise<{ md: string; sources: ContextSource[] }> {
  const row = await prisma.factoryContext.findUnique({ where: { alertClientId: client.id } });
  if (row?.md.trim()) return { md: row.md, sources: [{ kind: "client_doc", ref: "FactoryContext", chars: row.md.length }, ...parseSources(row.sourcesJson).filter((s) => s.kind !== "client_doc")] };
  const fresh = await collectClientContext(client);
  return { md: fresh.md, sources: fresh.sources };
}

export interface SaveContextResult { context: FactoryContextView; hq: { ok: boolean; written?: string; error?: string; conflict?: boolean } | null }

/**
 * Stores the consultant's version. With `mirror`, writes it in HQ too
 * (statics-context.md, frontmatter « brouillon », confirme_par = the author):
 * read just before to get the ETag, refused when HQ changed in between.
 */
export async function saveClientContext(client: FactoryClient, user: { id: string; name: string }, input: { md: string; sources?: ContextSource[]; mirror?: boolean }): Promise<SaveContextResult> {
  const md = cleanEditedDoc(input.md);
  if (md.length < 40) throw new Error("Le document de contexte est vide.");
  const prev = await prisma.factoryContext.findUnique({ where: { alertClientId: client.id } });
  const sources = input.sources ?? (prev ? parseSources(prev.sourcesJson) : []);
  let row = await prisma.factoryContext.upsert({
    where: { alertClientId: client.id },
    create: { alertClientId: client.id, md, sourcesJson: JSON.stringify(sources), updatedById: user.id },
    update: { md, sourcesJson: JSON.stringify(sources), updatedById: user.id },
  });
  let hq: SaveContextResult["hq"] = null;
  const slug = await clientHqProject(client);
  if (input.mirror) {
    if (!slug) hq = { ok: false, error: "Ce client n'a pas de dossier HQ rattaché : le document reste dans ImpulseMotion." };
    else {
      const path = `projects/${slug}/${STATICS_CONTEXT_FILE}`;
      try {
        const current = await readHqFile(path);
        const etag = current.found ? current.etag : null;
        const out = await writeHqFile(slug, STATICS_CONTEXT_FILE, hqMirrorContent(md, user.name), etag);
        if (out.ok) {
          row = await prisma.factoryContext.update({ where: { alertClientId: client.id }, data: { hqPath: path, hqEtag: out.etag } });
          hq = { ok: true, written: path };
        } else hq = { ok: false, error: out.error, ...(out.conflict ? { conflict: true } : {}) };
      } catch (e) { hq = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
  }
  return { context: view(client, row, null, slug), hq };
}
