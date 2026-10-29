/**
 * Playbook d'une marque — server side (grouping and rendering in ./playbook-doc.ts).
 *   studyBrand   the brand's ads in the Meta Ad Library (public page read by the relay: active ones, then past ones),
 *                the picture ads first, each read by the AI (analyseTemplate, Sonnet low, 3 at a time: the
 *                relay's VPS has little memory) → formats + Markdown. Cached 7 days per brand × country
 *                (AppSetting), an ad already kept as a template is not read again.
 *   keepFromPlaybook  the candidates ticked become templates of the client (source competitor, tags
 *                « playbook:<marque> » and the format), picture copied on the relay, analysis reused.
 */

import { prisma } from "@/lib/prisma";
import { searchAdLibrary } from "@/lib/creas/ad-library";
import { analyseTemplate } from "@/lib/creas/analysis";
import { dataUriToRelayImage, fetchImageBytes, toDataUri } from "@/lib/creas/media";
import { relayUpload } from "@/lib/studio";
import { parseAnalysis } from "@/lib/creas/model";
import { groupFormats, playbookKey, renderPlaybook, type Playbook, type PlaybookCandidate } from "@/lib/creas/playbook-doc";

export const PLAYBOOK_TTL_MS = 7 * 24 * 3600 * 1000;
export const PLAYBOOK_DEFAULT_ADS = 18;
export const PLAYBOOK_MAX_ADS = 30;
const PARALLEL = 3;

export class PlaybookError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function cachedPlaybook(brand: string, country: string): Promise<Playbook | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: playbookKey(brand, country) } });
  if (!row) return null;
  try {
    const p = JSON.parse(row.valueJson) as Playbook;
    return Array.isArray(p.candidates) && Date.now() - Date.parse(p.at) < PLAYBOOK_TTL_MS ? p : null;
  } catch { return null; }
}

export async function studyBrand(opts: { brand: string; country?: string; limit?: number; fresh?: boolean; user: { id: string; email: string | null; role: string } }): Promise<Playbook> {
  const brand = opts.brand.trim().slice(0, 100);
  if (brand.length < 2) throw new PlaybookError(400, "Indiquez la marque à étudier.");
  const country = /^[A-Za-z]{2}$/.test(opts.country ?? "") ? opts.country!.toUpperCase() : "FR";
  const limit = Math.min(PLAYBOOK_MAX_ADS, Math.max(4, Math.round(opts.limit ?? PLAYBOOK_DEFAULT_ADS)));
  if (!opts.fresh) { const hit = await cachedPlaybook(brand, country); if (hit && hit.analysed >= Math.min(limit, hit.total)) return hit; }

  // The brand's live ads first (a keyword search over « all » drowns the brand among the ads that cite it), then the past ones as a complement.
  const res = await searchAdLibrary({ q: brand, country, limit: 60, active: true });
  if (res.ads.filter((a) => a.imageUrl).length < limit) {
    const past = await searchAdLibrary({ q: brand, country, limit: 60, active: false }).catch(() => null);
    const seen = new Set(res.ads.map((a) => a.id));
    for (const a of past?.ads ?? []) if (!seen.has(a.id)) { res.ads.push(a); seen.add(a.id); }
  }
  if (res.error && !res.ads.length) throw new PlaybookError(502, res.error);
  // Statics first (the fabrique makes images), then video posters; ads without a picture are not templates.
  const withPicture = res.ads.filter((a) => a.imageUrl);
  const ordered = [...withPicture.filter((a) => !a.videoUrl), ...withPicture.filter((a) => a.videoUrl)].slice(0, limit);
  if (!ordered.length) throw new PlaybookError(404, `Aucune pub avec image pour « ${brand} » dans la bibliothèque Meta (${country}).`);

  const known = await prisma.creativeTemplate.findMany({ where: { sourceRef: { in: ordered.map((a) => `adlib:${a.id}`) }, deletedAt: null }, select: { sourceRef: true, analysisJson: true } });
  const knownBy = new Map(known.map((k) => [k.sourceRef!, parseAnalysis(k.analysisJson)]));
  const candidates: PlaybookCandidate[] = [];
  const queue = [...ordered];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let ad = queue.shift(); ad; ad = queue.shift()) {
      let analysis = knownBy.get(`adlib:${ad.id}`) ?? null;
      if (!analysis || !analysis.hook) {
        const got = await fetchImageBytes(ad.imageUrl!).catch(() => null);
        const image = got ? dataUriToRelayImage(toDataUri(got.buf, got.mediaType), "pub") : null;
        analysis = await analyseTemplate({ image, body: ad.bodies[0] ?? null, brand: ad.pageName || brand, user: opts.user });
      }
      candidates.push({ libraryId: ad.id, pageName: ad.pageName || brand, image: ad.imageUrl ?? null, text: (ad.bodies[0] ?? "").slice(0, 600), startedAt: ad.startedAt, video: !!ad.videoUrl, snapshotUrl: ad.snapshotUrl, analysis, format: "" });
    }
  }));
  // Back to the library's order (most recent first), then formats.
  const order = new Map(ordered.map((a, i) => [a.id, i]));
  candidates.sort((a, b) => (order.get(a.libraryId) ?? 0) - (order.get(b.libraryId) ?? 0));
  const formats = groupFormats(candidates, brand);
  const base = { brand, country, at: new Date().toISOString(), total: res.ads.length, analysed: candidates.filter((c) => c.analysis.hook || c.analysis.structure).length, formats, candidates };
  const playbook: Playbook = { ...base, md: renderPlaybook(base) };
  const key = playbookKey(brand, country);
  await prisma.appSetting.upsert({ where: { key }, create: { key, valueJson: JSON.stringify(playbook), updatedBy: opts.user.id }, update: { valueJson: JSON.stringify(playbook), updatedBy: opts.user.id } });
  return playbook;
}

export interface KeptTemplate { id: string; name: string; libraryId: string; format: string; existed: boolean }

/** Ticked candidates → templates of the client (or of the agency when no client). Already kept → returned as is. */
export async function keepFromPlaybook(opts: { brand: string; country?: string; libraryIds: string[]; client: { id: string; name: string } | null; user: { id: string; name: string } }): Promise<{ kept: KeptTemplate[]; failed: Array<{ libraryId: string; error: string }> }> {
  const country = /^[A-Za-z]{2}$/.test(opts.country ?? "") ? opts.country!.toUpperCase() : "FR";
  const playbook = await cachedPlaybook(opts.brand, country);
  if (!playbook) throw new PlaybookError(404, "Étude introuvable ou expirée : relancez l'étude de la marque.");
  const wanted = playbook.candidates.filter((c) => opts.libraryIds.includes(c.libraryId)).slice(0, 12);
  if (!wanted.length) throw new PlaybookError(400, "Cochez au moins une pub de l'étude.");
  const kept: KeptTemplate[] = [];
  const failed: Array<{ libraryId: string; error: string }> = [];
  const tagBrand = `playbook:${playbook.brand.toLowerCase().replace(/[,\s]+/g, "-").slice(0, 40)}`;
  for (const c of wanted) {
    const existing = await prisma.creativeTemplate.findFirst({ where: { sourceRef: `adlib:${c.libraryId}`, alertClientId: opts.client?.id ?? null, deletedAt: null }, select: { id: true, name: true } });
    if (existing) { kept.push({ id: existing.id, name: existing.name, libraryId: c.libraryId, format: c.format, existed: true }); continue; }
    try {
      let file: string | null = null;
      if (c.image) {
        const got = await fetchImageBytes(c.image);
        if (got) file = (await relayUpload(toDataUri(got.buf, got.mediaType))).file;
      }
      if (!file) throw new Error("image illisible (lien de la bibliothèque expiré ? relancez l'étude)");
      const row = await prisma.creativeTemplate.create({ data: {
        alertClientId: opts.client?.id ?? null, clientName: opts.client?.name ?? "", name: (c.analysis.hook || `${c.format} ${c.pageName}`).slice(0, 120), source: "competitor", brand: c.pageName,
        sourceRef: `adlib:${c.libraryId}`, sourceUrl: c.snapshotUrl ?? `https://www.facebook.com/ads/library/?id=${c.libraryId}`, imageUrl: c.image, file, body: c.text || null,
        analysisJson: JSON.stringify(c.analysis), tags: [tagBrand, c.format.toLowerCase()].join(", ").slice(0, 300), createdById: opts.user.id, createdByName: opts.user.name,
      } });
      kept.push({ id: row.id, name: row.name, libraryId: c.libraryId, format: c.format, existed: false });
    } catch (e) { failed.push({ libraryId: c.libraryId, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { kept, failed };
}
