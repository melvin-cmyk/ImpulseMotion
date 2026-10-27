/**
 * Consultant annotations of an ad (AdAnnotation): note + custom tags.
 *   GET ?platform=meta&adId=…        → { note, tags, updatedByName, updatedAt } (empty when none)
 *   PUT { platform, adId, note?, tags? } → upsert
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, platformAccountInScope } from "@/lib/scope";

async function resolve(platform: string, adId: string, session: never) {
  if (!/^\d{5,30}$/.test(adId) || !/^(meta|google|tiktok|linkedin)$/.test(platform)) return { error: NextResponse.json({ error: "paramètres invalides" }, { status: 400 }) };
  const ad = await prisma.adCatalog.findUnique({ where: { id: `${platform}:${adId}` }, select: { accountId: true } });
  if (!ad) return { error: NextResponse.json({ error: "annonce inconnue" }, { status: 404 }) };
  const scope = await getAccountScope(session);
  if (!platformAccountInScope(scope, platform, ad.accountId)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { accountId: ad.accountId };
}

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const platform = req.nextUrl.searchParams.get("platform") ?? "meta";
  const adId = req.nextUrl.searchParams.get("adId") ?? "";
  const r = await resolve(platform, adId, guard.session as never);
  if ("error" in r) return r.error;
  const row = await prisma.adAnnotation.findUnique({ where: { id: `${platform}:${adId}` } });
  return NextResponse.json(row ? { note: row.note, tags: JSON.parse(row.tagsJson), updatedByName: row.updatedByName, updatedAt: row.updatedAt.toISOString() } : { note: "", tags: [], updatedByName: "", updatedAt: null }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => ({}))) as { platform?: string; adId?: string; note?: string; tags?: string[] };
  const platform = body.platform ?? "meta";
  const adId = body.adId ?? "";
  const r = await resolve(platform, adId, guard.session as never);
  if ("error" in r) return r.error;
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : undefined;
  const note = typeof body.note === "string" ? body.note.slice(0, 5000) : undefined;
  const who = { updatedById: guard.session.userId, updatedByName: guard.session.user?.name ?? guard.session.user?.email ?? "" };
  await prisma.adAnnotation.upsert({
    where: { id: `${platform}:${adId}` },
    create: { id: `${platform}:${adId}`, platform, accountId: r.accountId, adId, note: note ?? "", tagsJson: JSON.stringify(tags ?? []), ...who },
    update: { note, tagsJson: tags ? JSON.stringify(tags) : undefined, ...who },
  });
  return NextResponse.json({ ok: true });
}
