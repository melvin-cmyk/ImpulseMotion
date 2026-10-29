/**
 * Fabrique de statics — publication of the kept visuals of a run as Meta
 * image ads, through the Pilotage: ONE action holding one « create_ad »
 * operation per visual (headline = its copy's title, description = its
 * subtitle; one primary text and one link for all), previewed (everything
 * checked on Meta, nothing sent), then sent on a single confirmation. Always
 * created PAUSED, journaled in HQ by the Pilotage like any change.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { queryAds } from "@/lib/ads-warehouse/query";
import { publicMediaUrl } from "@/lib/studio";
import { CALL_TO_ACTIONS } from "@/lib/meta-write";
import { adIdentities } from "@/lib/pilot/new-ad";
import { executeAction, pilotWritesOpen, prepareAction, type PilotActionView, type PilotSession } from "@/lib/pilot/service";
import { FactoryError, clientHqProject, type FactoryClient } from "@/lib/creas/factory";
import { parseSettings } from "@/lib/creas/model";
import type { FactoryRun } from "@prisma/client";

/** Ads one publication creates at most (each one is checked on Meta before the preview). */
export const MAX_PUBLISH = 12;
const TZ = "Europe/Paris";
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export interface PublishTargets {
  writesOpen: boolean;
  accounts: Array<{ id: string; name: string }>;
  adsets: Array<{ accountId: string; adsetId: string; adset: string; campaign: string; status: string | null; spend30: number }>;
  pages: Array<{ id: string; name: string }>;
  instagram: Array<{ id: string; name: string }>;
  defaults: { primaryText: string; linkUrl: string; from: string | null };
  hqProject: string | null;
  kept: Array<{ assetId: string; headline: string; subline: string; image: string | null; published: boolean }>;
}

async function metaAccountsOf(clientId: string): Promise<Array<{ id: string; name: string }>> {
  const ac = await prisma.alertClient.findUnique({ where: { id: clientId }, select: { accountsJson: true } });
  return parseAlertAccounts(ac?.accountsJson).filter((a) => a.platform === "meta").map((a) => ({ id: a.accountId.replace(/^act_/, ""), name: a.name }));
}

/** The kept visuals of a run with the copy each was made for. */
export async function keptOf(run: FactoryRun) {
  const assets = await prisma.creativeAsset.findMany({ where: { factoryRunId: run.id, feedback: "keep", deletedAt: null, status: "completed", kind: "image" }, orderBy: { createdAt: "asc" } });
  const copies = await prisma.factoryCopy.findMany({ where: { id: { in: assets.map((a) => a.copyId).filter((x): x is string => !!x) } } });
  const byId = new Map(copies.map((c) => [c.id, c]));
  return assets.map((a) => ({ asset: a, copy: a.copyId ? byId.get(a.copyId) ?? null : null }));
}

/** Where the kept visuals can go: the client's Meta accounts, their ad sets (warehouse, by spend 30 d), Pages, texts of the best ad. */
export async function publishTargets(run: FactoryRun, client: FactoryClient, accountId?: string | null): Promise<PublishTargets> {
  const accounts = await metaAccountsOf(client.id);
  const settings = parseSettings(run.settingsJson);
  const published = new Set((settings.published ?? []).flatMap((p) => p.assetIds));
  const kept = (await keptOf(run)).map(({ asset, copy }) => ({ assetId: asset.id, headline: copy?.headline ?? asset.prompt.split(" — ")[0], subline: copy?.subline ?? "", image: `/api/studio/assets/${asset.id}/file?inline=1`, published: published.has(asset.id) }));
  const base: PublishTargets = { writesOpen: pilotWritesOpen("meta"), accounts, adsets: [], pages: [], instagram: [], defaults: { primaryText: "", linkUrl: "", from: null }, hqProject: await clientHqProject(client), kept };
  if (!accounts.length) return base;
  const ids = accounts.map((a) => a.id);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.$queryRaw<Array<{ accountId: string; campaignName: string | null; adsetId: string | null; adsetName: string | null; status: string | null; spend30: number | null }>>(Prisma.sql`
    SELECT c."accountId", max(c."campaignName") AS "campaignName", c."adsetId", max(c."adsetName") AS "adsetName", max(c.status) AS status, sum(d.spend) AS "spend30"
    FROM "AdCatalog" c
    LEFT JOIN "AdDaily" d ON d.platform = c.platform AND d."adId" = c."adId" AND d.date >= ${since}
    WHERE c.platform = 'meta' AND c."accountId" IN (${Prisma.join(ids)}) AND c."adsetId" IS NOT NULL
    GROUP BY c."accountId", c."adsetId"
    ORDER BY "spend30" DESC NULLS LAST
    LIMIT 60`);
  base.adsets = rows.map((r) => ({ accountId: r.accountId, adsetId: r.adsetId!, adset: r.adsetName ?? r.adsetId!, campaign: r.campaignName ?? "", status: r.status, spend30: Math.round(r.spend30 ?? 0) }));
  const account = accounts.find((a) => a.id === (accountId ?? "").replace(/^act_/, "")) ?? accounts[0];
  const identities = await adIdentities(account.id).catch(() => null);
  base.pages = identities?.pages.map((p) => ({ id: p.id, name: p.name })) ?? [];
  base.instagram = identities?.instagram.map((p) => ({ id: p.id, name: p.name ?? p.id })) ?? [];
  // Texts of the client's most-spent ad over 30 days (said on screen as « repris de … »).
  const until = ymd(new Date(Date.now() - 86_400_000)); const from = ymd(new Date(Date.now() - 30 * 86_400_000));
  const res = await queryAds({ platforms: ["meta"], accountIds: ids, accounts: ids.map((id) => ({ platform: "meta" as const, id })), range: { since: from, until }, groupBy: "ad", sort: { key: "spend", dir: "desc" }, limit: 24 }).catch(() => null);
  const hit = res?.rows.find((r) => r.sample?.body && r.sample.landingUrl && /^https:\/\//.test(r.sample.landingUrl));
  if (hit?.sample) base.defaults = { primaryText: hit.sample.body!.slice(0, 2000), linkUrl: hit.sample.landingUrl!.slice(0, 2000), from: hit.sample.name.slice(0, 80) };
  return base;
}

export interface PublishInput { accountId: string; adsetId: string; pageId: string; instagramUserId?: string; primaryText: string; linkUrl: string; callToAction?: string; assetIds?: string[]; why?: string }

/** The preview: one Pilotage action, one operation per kept visual, nothing sent. */
export async function preparePublish(run: FactoryRun, client: FactoryClient, session: PilotSession, input: PublishInput): Promise<PilotActionView> {
  const accounts = await metaAccountsOf(client.id);
  const account = accounts.find((a) => a.id === input.accountId.replace(/^act_/, ""));
  if (!account) throw new FactoryError(400, "Choisissez un compte Meta du client.");
  if (!/^\d{5,25}$/.test(input.adsetId)) throw new FactoryError(400, "Choisissez l'ensemble de publicités.");
  if (!/^\d{5,25}$/.test(input.pageId)) throw new FactoryError(400, "Choisissez la Page Facebook.");
  const primaryText = input.primaryText.trim().slice(0, 2000);
  if (primaryText.length < 3) throw new FactoryError(400, "Écrivez le texte principal de la publicité.");
  if (!/^https:\/\/\S+$/.test(input.linkUrl.trim())) throw new FactoryError(400, "Le lien de destination doit commencer par https://.");
  const cta = (input.callToAction ?? "").toUpperCase();
  let kept = await keptOf(run);
  if (input.assetIds?.length) kept = kept.filter((k) => input.assetIds!.includes(k.asset.id));
  if (!kept.length) throw new FactoryError(400, "Aucun visuel gardé à publier : gardez-en d'abord dans la grille.");
  if (kept.length > MAX_PUBLISH) throw new FactoryError(400, `${MAX_PUBLISH} publicités au plus par envoi : décochez-en ${kept.length - MAX_PUBLISH}.`);
  const date = ymd(new Date());
  const requests = kept.map(({ asset, copy }, i) => {
    const imageUrl = asset.file ? publicMediaUrl(asset.file, 6 * 3600) : asset.url && /^https:\/\//.test(asset.url) ? asset.url : null;
    if (!imageUrl) throw new FactoryError(503, `Le visuel ${i + 1} n'a pas d'adresse que Meta puisse télécharger.`);
    const spec = {
      name: `Fabrique · ${(copy?.headline ?? asset.prompt).slice(0, 40)} · ${date}`.slice(0, 255), primaryText,
      headline: (copy?.headline ?? "").slice(0, 255) || undefined, description: (copy?.subline ?? "").slice(0, 255) || undefined,
      linkUrl: input.linkUrl.trim(), callToAction: (CALL_TO_ACTIONS as readonly string[]).includes(cta) ? cta : undefined, imageUrl, pageId: input.pageId,
      instagramUserId: input.instagramUserId && /^\d{5,25}$/.test(input.instagramUserId) ? input.instagramUserId : undefined, studioAssetId: asset.id,
    };
    return { kind: "create_ad", objectType: "adset", objectId: input.adsetId, value: JSON.stringify(spec) };
  });
  const why = (input.why ?? "").trim() || `Visuels gardés de la fabrique de statics du ${run.createdAt.toLocaleDateString("fr-FR")} (${run.kind})`;
  const prepared = await prepareAction(session, { alertClientId: client.id, accountId: account.id, platform: "meta", requests, why });
  if (!prepared.ok) throw new FactoryError(prepared.status, prepared.error + (prepared.errors?.length ? ` ${prepared.errors.join(" ")}` : ""));
  return prepared.action;
}

/** The send, after the consultant's single confirmation: every ad created PAUSED, the action journaled in HQ. */
export async function confirmPublish(run: FactoryRun, client: FactoryClient, session: PilotSession, actionId: string, why: string): Promise<PilotActionView> {
  if (!pilotWritesOpen("meta")) throw new FactoryError(403, "Les écritures Meta ne sont pas ouvertes sur cette application : rien n'a été envoyé.");
  const hqProject = await clientHqProject(client);
  const done = await executeAction(session, actionId, { why: why.trim() || `Visuels gardés de la fabrique du ${run.createdAt.toLocaleDateString("fr-FR")}`, ...(hqProject ? { hqProject } : {}) });
  if (!done.ok) throw new FactoryError(done.status, done.error);
  // The visual of each operation, wherever the ad spec keeps it (top level or media[]).
  const assetIds = [...new Set(done.action.operations.flatMap((op) => [...String(op.after ?? "").matchAll(/"studioAssetId":"([a-z0-9]{10,40})"/gi)].map((m) => m[1])))];
  const fresh = await prisma.factoryRun.findUnique({ where: { id: run.id }, select: { settingsJson: true } });
  const settings = parseSettings(fresh?.settingsJson);
  settings.published = [...(settings.published ?? []), { actionId, assetIds, at: new Date().toISOString() }].slice(-20);
  await prisma.factoryRun.update({ where: { id: run.id }, data: { settingsJson: JSON.stringify(settings) } });
  return done.action;
}
