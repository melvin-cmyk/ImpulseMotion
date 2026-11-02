/** PATCH /api/ads/presets/:id { name?, metrics?, columns?, isDefault? } · DELETE — staff only. */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { METRIC_BY_KEY } from "@/lib/ads-warehouse/metrics-ui";

const clean = (v: unknown, max: number) => (Array.isArray(v) ? v.map(String).filter((k) => !!METRIC_BY_KEY[k]).slice(0, max) : []);

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  const b = (await req.json().catch(() => ({}))) as { name?: string; metrics?: unknown; columns?: unknown; isDefault?: boolean };
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 80); if (!n) return NextResponse.json({ error: "nom requis" }, { status: 400 }); data.name = n; }
  if (b.metrics !== undefined) data.metricsJson = JSON.stringify(clean(b.metrics, 6));
  if (b.columns !== undefined) data.columnsJson = JSON.stringify(clean(b.columns, 40));
  if (b.isDefault !== undefined) {
    if (b.isDefault) await prisma.adMetricPreset.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    data.isDefault = !!b.isDefault;
  }
  try {
    const p = await prisma.adMetricPreset.update({ where: { id }, data });
    return NextResponse.json({ id: p.id });
  } catch { return NextResponse.json({ error: "préréglage inconnu" }, { status: 404 }); }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await ctx.params;
  await prisma.adMetricPreset.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
