/**
 * Glossaire — Motion's Glossary: the AI tag categories of a client's
 * creatives, their values (creatives, spend over the report's period), and
 * the team's corrections:
 *   - rename a value (renaming to an existing value = merging the two),
 *   - remove a value (not for « Type d'asset »: an ad without it is tagged
 *     again by the AI),
 *   - set a category of one creative (all the ads of the creative).
 * Everything lives in AdCatalog.tagsJson under the ai:* keys, which the
 * platform sync keeps (sync.ts upsertCatalog), so a correction is never
 * overwritten.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AdsQuery } from "./query";
import { GLOSSARY_KEYS, type GlossaryKey } from "./glossary-labels";

export interface GlossaryValue { value: string; creatives: number; ads: number; spend: number }
export interface GlossaryCategory { key: GlossaryKey; values: GlossaryValue[]; tagged: number }

export const isGlossaryKey = (k: unknown): k is GlossaryKey => typeof k === "string" && (GLOSSARY_KEYS as readonly string[]).includes(k);
/** A value: one line, no « | » (it separates multiple values), 1–60 chars. */
export function cleanValue(v: unknown): string | null {
  const s = String(v ?? "").replace(/[\s|]+/g, " ").trim().slice(0, 60);
  return s ? s : null;
}

const accountsCond = (q: Pick<AdsQuery, "platforms" | "accountIds">) => Prisma.sql`c.platform IN (${Prisma.join(q.platforms)}) AND c."accountId" IN (${Prisma.join(q.accountIds)})`;

/** Values of every category on the client's accounts; spend over q.range. Multi-values (« a | b ») are counted per value. */
export async function listGlossary(q: AdsQuery): Promise<GlossaryCategory[]> {
  if (!q.accountIds.length) return GLOSSARY_KEYS.map((key) => ({ key, values: [], tagged: 0 }));
  const rows = await prisma.$queryRaw<Array<{ key: string; value: string; creatives: number; ads: number; spend: number }>>(Prisma.sql`
    WITH tagged AS (
      SELECT c.id, COALESCE(c."creativeKey", c.id) AS ck, t.key, trim(v.value) AS value
      FROM "AdCatalog" c
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(NULLIF(c."tagsJson", ''), '{}')::jsonb) AS t(key, value)
      CROSS JOIN LATERAL regexp_split_to_table(t.value, '\\s*\\|\\s*') AS v(value)
      WHERE ${accountsCond(q)} AND t.key IN (${Prisma.join(GLOSSARY_KEYS as unknown as string[])}) AND trim(v.value) <> ''
    ), spend AS (
      SELECT d.platform || ':' || d."adId" AS id, SUM(d.spend)::float8 AS spend
      FROM "AdDaily" d
      WHERE d.platform IN (${Prisma.join(q.platforms)}) AND d."accountId" IN (${Prisma.join(q.accountIds)}) AND d.date BETWEEN ${q.range.since}::date AND ${q.range.until}::date
      GROUP BY 1
    )
    SELECT t.key, t.value, COUNT(DISTINCT t.ck)::int AS creatives, COUNT(DISTINCT t.id)::int AS ads, COALESCE(SUM(s.spend), 0)::float8 AS spend
    FROM tagged t LEFT JOIN spend s ON s.id = t.id
    GROUP BY 1, 2`);
  return GLOSSARY_KEYS.map((key) => {
    const values = rows.filter((r) => r.key === key).map((r) => ({ value: r.value, creatives: Number(r.creatives), ads: Number(r.ads), spend: Number(r.spend) }))
      .sort((a, b) => b.spend - a.spend || b.creatives - a.creatives);
    return { key, values, tagged: values.reduce((s, v) => s + v.creatives, 0) };
  });
}

/** Several values « a | b » (one creative's category), each cleaned, deduplicated, max 5. */
export function cleanMulti(v: unknown): string | null {
  const parts: string[] = [];
  for (const p of String(v ?? "").split("|")) { const c = cleanValue(p); if (c && !parts.some((x) => x.toLowerCase() === c.toLowerCase())) parts.push(c); }
  return parts.length ? parts.slice(0, 5).join(" | ") : null;
}

/** Rewrites one value of a key in a tag string (« a | b »), deduplicated; null = removed. */
export function replaceInTag(tag: string, from: string, to: string | null): string | null {
  const parts = tag.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  const next: string[] = [];
  for (const p of parts) {
    const v = p.toLowerCase() === from.toLowerCase() ? to : p;
    if (v && !next.some((n) => n.toLowerCase() === v.toLowerCase())) next.push(v);
  }
  return next.length ? next.join(" | ") : null;
}

/** Renames (or removes, to = null) a value of a key on the client's accounts. Returns the ads changed. */
export async function renameValue(q: AdsQuery, key: GlossaryKey, from: string, to: string | null): Promise<number> {
  if (!q.accountIds.length) return 0;
  const rows = await prisma.$queryRaw<Array<{ id: string; tagsJson: string }>>(Prisma.sql`
    SELECT c.id, c."tagsJson" FROM "AdCatalog" c
    WHERE ${accountsCond(q)} AND c."tagsJson"::jsonb ? ${key}
      AND EXISTS (SELECT 1 FROM regexp_split_to_table(c."tagsJson"::jsonb ->> ${key}, '\\s*\\|\\s*') AS v(value) WHERE lower(trim(v.value)) = lower(${from}))`);
  let changed = 0;
  for (const r of rows) {
    let tags: Record<string, string>;
    try { tags = JSON.parse(r.tagsJson || "{}"); } catch { continue; }
    const next = replaceInTag(String(tags[key] ?? ""), from, to);
    if (next) tags[key] = next; else delete tags[key];
    await prisma.adCatalog.update({ where: { id: r.id }, data: { tagsJson: JSON.stringify(tags) } });
    changed++;
  }
  return changed;
}

/** Sets (value = null: clears) one category on the given ads, restricted to the client's accounts. */
export async function setCreativeTag(q: AdsQuery, adIds: string[], key: GlossaryKey, value: string | null): Promise<number> {
  const ids = Array.from(new Set(adIds.filter((id) => /^[a-z]+:[\w-]{1,60}$/.test(id)))).slice(0, 200);
  if (!ids.length || !q.accountIds.length) return 0;
  const rows = await prisma.$queryRaw<Array<{ id: string; tagsJson: string }>>(Prisma.sql`
    SELECT c.id, c."tagsJson" FROM "AdCatalog" c WHERE ${accountsCond(q)} AND c.id IN (${Prisma.join(ids)})`);
  for (const r of rows) {
    let tags: Record<string, string>;
    try { tags = JSON.parse(r.tagsJson || "{}"); } catch { tags = {}; }
    if (value) tags[key] = value; else delete tags[key];
    await prisma.adCatalog.update({ where: { id: r.id }, data: { tagsJson: JSON.stringify(tags) } });
  }
  return rows.length;
}
