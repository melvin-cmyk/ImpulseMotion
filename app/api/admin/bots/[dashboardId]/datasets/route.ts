import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRealAdmin } from "@/lib/auth-helpers";
import { hasClientDataDb } from "@/lib/client-data";
import { deleteDataset, listDatasets, updateDatasetDescription } from "@/lib/client-datasets";

type Ctx = { params: Promise<{ dashboardId: string }> };

/**
 * Jeux de données (fichiers du dossier Drive) d'un bot client, pour la fiche admin.
 *   GET    → { datasets: DatasetSummary[] }
 *   PATCH  { datasetKey, description } → description lue par le bot
 *   DELETE { datasetKey } → supprime le jeu et ses lignes (le fichier Drive reste)
 */
async function botFor(dashboardId: string) {
  return prisma.clientBot.findUnique({ where: { dashboardId }, select: { clientKey: true } });
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export async function GET(_req: Request, { params }: Ctx) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;
  const { dashboardId } = await params;
  const bot = await botFor(dashboardId);
  if (!bot) return NextResponse.json({ datasets: [] });
  if (!hasClientDataDb()) return NextResponse.json({ datasets: [], warning: "entrepôt non configuré" });
  try {
    return NextResponse.json({ datasets: await listDatasets(bot.clientKey) });
  } catch (err) {
    console.error("[admin/bots/datasets]", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "entrepôt injoignable" }, { status: 503 });
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;
  const { dashboardId } = await params;
  const bot = await botFor(dashboardId);
  if (!bot) return NextResponse.json({ error: "bot non configuré" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const key = typeof body.datasetKey === "string" ? body.datasetKey : "";
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "datasetKey invalide" }, { status: 400 });
  const description = typeof body.description === "string" ? body.description : null;
  const ok = await updateDatasetDescription(bot.clientKey, key, description);
  if (!ok) return NextResponse.json({ error: "jeu introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const guard = await requireRealAdmin();
  if ("error" in guard) return guard.error;
  const { dashboardId } = await params;
  const bot = await botFor(dashboardId);
  if (!bot) return NextResponse.json({ error: "bot non configuré" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const key = typeof body.datasetKey === "string" ? body.datasetKey : "";
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "datasetKey invalide" }, { status: 400 });
  const ok = await deleteDataset(bot.clientKey, key);
  if (!ok) return NextResponse.json({ error: "jeu introuvable" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
