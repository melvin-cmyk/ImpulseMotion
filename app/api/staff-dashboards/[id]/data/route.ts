/**
 * Données d'un dashboard du staff : lit ses jeux de données via le relay.
 *   POST { ids?: string[], params?: Record<string, value>, refresh?: boolean }
 *      → { results: { [id]: { status: "ok", answer, args, at, cached? } | { status: "error"|"declined", message, at } }, params }
 * Périmètre : les comptes nommés par chaque appel doivent être attribués à la
 * personne ; un jeu hors périmètre revient « declined », les autres passent.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope } from "@/lib/scope";
import { runDatasets } from "@/lib/staff-dashboards/data";
import { parseDatasets, parseParams } from "@/lib/staff-dashboards/model";

export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const row = await prisma.staffDashboard.findUnique({ where: { id }, select: { ownerId: true, shared: true, datasetsJson: true, paramsJson: true } });
  const mine = row?.ownerId === guard.session.userId;
  if (!row || (!mine && !row.shared && guard.session.role !== "admin")) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; params?: unknown; refresh?: unknown };
  const { datasets } = parseDatasets(row.datasetsJson);
  const all = Object.keys(datasets);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && all.includes(x)) : all;
  const stored = parseParams(row.paramsJson);
  const given = body.params !== undefined ? parseParams(body.params) : {};
  const effective = { ...stored, ...given };

  const scope = await getAccountScope(guard.session);
  const results = await runDatasets(id, datasets, ids, effective, scope, { refresh: body.refresh === true });
  return NextResponse.json({ results, params: effective }, { headers: { "Cache-Control": "no-store" } });
}
