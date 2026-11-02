/**
 * Analyse Ads snapshots (Motion's « Share report → Snapshot »): a public,
 * read-only copy of a report, numbers frozen when it was shared, readable
 * without an account at /s/{id}. The visuals go through /api/s/{id}/image,
 * which only serves ads that belong to the snapshot (fresh Meta URL on demand).
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { queryAds, type AdSample, type AdsGroupRow, type AdsQuery, type MetricKey, type Metrics } from "./query";
import { fbcdnUsable } from "./cdn";

export interface SnapshotPayload {
  range: { since: string; until: string };
  compare: { since: string; until: string } | null;
  groupBy: string;
  metrics: MetricKey[];
  columns: MetricKey[];
  rows: AdsGroupRow[];
  /** Rows shown as cards (the ticked rows of the report). */
  cardKeys: string[];
  benchmark: Metrics;
  benchmarkPrevious: Metrics | null;
  currency: string | null;
  total: number;
  ratio: "9:16" | "4:5" | "1:1";
}

export interface SnapshotMeta { title: string; emoji: string; description: string; clientName: string; accountKey: string | null; createdById: string | null; createdByName: string }

const MAX_ROWS = 60;

/** Visuals of a public snapshot: stable URLs kept, the rest through the snapshot's image route; no video file (auth route). */
function publicSample(id: string, a: AdSample): AdSample {
  const stable = (u: string | null) => !!u && fbcdnUsable(u, 30 * 86_400_000);
  const imageUrl = a.platform === "meta"
    ? (stable(a.imageUrl) ? a.imageUrl : `/api/s/${id}/image?adId=${encodeURIComponent(a.adId)}`)
    : a.imageUrl ?? a.thumbnailUrl;
  return { ...a, imageUrl, thumbnailUrl: null, videoId: a.platform === "google" ? a.videoId : null };
}

export async function createSnapshot(q: AdsQuery, meta: SnapshotMeta, view: { metrics: MetricKey[]; columns: MetricKey[]; cardKeys: string[]; ratio: SnapshotPayload["ratio"] }): Promise<string> {
  const id = randomBytes(15).toString("base64url");
  const res = await queryAds({ ...q, limit: MAX_ROWS, offset: 0 });
  const rows = res.rows.map((r) => ({ ...r, sample: r.sample ? publicSample(id, r.sample) : null, ads: r.ads.slice(0, 4).map((a) => publicSample(id, a)) }));
  const keys = new Set(rows.map((r) => r.key));
  const payload: SnapshotPayload = {
    range: q.range, compare: q.compare ?? null, groupBy: q.groupBy, metrics: view.metrics.slice(0, 6), columns: view.columns,
    rows, cardKeys: view.cardKeys.filter((k) => keys.has(k)).slice(0, 24), benchmark: res.benchmark, benchmarkPrevious: res.benchmarkPrevious,
    currency: res.currency, total: res.total, ratio: view.ratio,
  };
  if (!payload.cardKeys.length) payload.cardKeys = rows.slice(0, 8).map((r) => r.key);
  await prisma.adSnapshot.create({
    data: { id, accountKey: meta.accountKey, clientName: meta.clientName.slice(0, 200), title: meta.title.slice(0, 200), emoji: meta.emoji.slice(0, 8), description: meta.description.slice(0, 1000), payloadJson: JSON.stringify(payload), createdById: meta.createdById, createdByName: meta.createdByName },
  });
  return id;
}

export async function getSnapshot(id: string, countView = false) {
  if (!/^[\w-]{10,40}$/.test(id)) return null;
  const s = await prisma.adSnapshot.findUnique({ where: { id } });
  if (!s || s.revokedAt) return null;
  if (countView) await prisma.adSnapshot.update({ where: { id }, data: { views: { increment: 1 } } }).catch(() => {});
  return { ...s, payload: JSON.parse(s.payloadJson) as SnapshotPayload };
}

/** Is this Meta ad part of the snapshot? (the public image route serves only those) */
export async function snapshotHasAd(id: string, adId: string): Promise<boolean> {
  const s = await getSnapshot(id);
  if (!s) return false;
  return s.payload.rows.some((r) => r.sample?.adId === adId || r.ads.some((a) => a.adId === adId));
}

export async function listSnapshots(accountKey: string) {
  return prisma.adSnapshot.findMany({ where: { accountKey, revokedAt: null }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, title: true, emoji: true, createdAt: true, createdByName: true, views: true } });
}

export async function revokeSnapshot(id: string) {
  return prisma.adSnapshot.update({ where: { id }, data: { revokedAt: new Date() }, select: { id: true, accountKey: true } });
}
