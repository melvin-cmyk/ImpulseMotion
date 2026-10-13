/**
 * Versions d'un dashboard du staff : avant chaque modification (copilote,
 * éditeur, restauration), l'état précédent est gardé pour pouvoir revenir en
 * arrière, comme sur un artefact Claude. Les KEEP dernières versions restent.
 */

import { prisma } from "@/lib/prisma";

export const VERSIONS_KEEP = 40;
export const VERSION_ORIGINS = new Set(["copilot", "manual", "restore"]);

export interface DashboardSnapshot { title: string; description: string | null; datasetsJson: string; paramsJson: string; html: string }

/** Enregistre `state` (l'état AVANT la modification) comme version, puis élague. */
export async function snapshotVersion(dashboardId: string, state: DashboardSnapshot, meta: { userId?: string | null; origin: string; label?: string | null }): Promise<string> {
  const v = await prisma.staffDashboardVersion.create({
    data: {
      dashboardId,
      userId: meta.userId ?? null,
      origin: VERSION_ORIGINS.has(meta.origin) ? meta.origin : "manual",
      label: meta.label ? meta.label.slice(0, 160) : null,
      title: state.title,
      description: state.description,
      datasetsJson: state.datasetsJson,
      paramsJson: state.paramsJson,
      html: state.html,
    },
    select: { id: true },
  });
  const old = await prisma.staffDashboardVersion.findMany({
    where: { dashboardId },
    orderBy: { createdAt: "desc" },
    skip: VERSIONS_KEEP,
    select: { id: true },
  });
  if (old.length) await prisma.staffDashboardVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  return v.id;
}

/** Ce qu'une version change par rapport à un état (pour l'étiquette et la liste). */
export function describeChange(before: DashboardSnapshot, after: Partial<DashboardSnapshot>): string {
  const parts: string[] = [];
  if (after.title !== undefined && after.title !== before.title) parts.push("titre");
  if (after.description !== undefined && (after.description ?? null) !== before.description) parts.push("description");
  if (after.datasetsJson !== undefined && after.datasetsJson !== before.datasetsJson) parts.push("jeux de données");
  if (after.paramsJson !== undefined && after.paramsJson !== before.paramsJson) parts.push("paramètres");
  if (after.html !== undefined && after.html !== before.html) parts.push("page");
  return parts.join(", ");
}
