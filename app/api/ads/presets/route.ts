/**
 * Analyse Ads column presets (Motion's saved column presets), shared by the
 * staff. GET — all presets; POST { name, metrics, columns, isDefault? }.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { METRIC_BY_KEY } from "@/lib/ads-warehouse/metrics-ui";

const clean = (v: unknown, max: number) => (Array.isArray(v) ? v.map(String).filter((k) => !!METRIC_BY_KEY[k]).slice(0, max) : []);

function presetDto(p: { id: string; name: string; metricsJson: string; columnsJson: string; isDefault: boolean; createdByName: string }) {
  let metrics: string[] = []; let columns: string[] = [];
  try { metrics = JSON.parse(p.metricsJson); columns = JSON.parse(p.columnsJson); } catch { /* keep empty */ }
  return { id: p.id, name: p.name, metrics, columns, isDefault: p.isDefault, createdByName: p.createdByName };
}

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const rows = await prisma.adMetricPreset.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }], take: 100 });
  return NextResponse.json({ presets: rows.map(presetDto) }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.json().catch(() => ({}))) as { name?: string; metrics?: unknown; columns?: unknown; isDefault?: boolean };
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ error: "nom requis" }, { status: 400 });
  const columns = clean(b.columns, 40);
  if (!columns.length) return NextResponse.json({ error: "colonnes requises" }, { status: 400 });
  if (b.isDefault) await prisma.adMetricPreset.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  const p = await prisma.adMetricPreset.create({ data: { name, metricsJson: JSON.stringify(clean(b.metrics, 6)), columnsJson: JSON.stringify(columns), isDefault: !!b.isDefault, createdById: guard.session.userId, createdByName: guard.session.user?.name ?? guard.session.user?.email ?? "" } });
  return NextResponse.json({ preset: presetDto(p) });
}
