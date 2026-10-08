/**
 * Rattachement des clients de l'agence à leur dossier HQ (admin).
 *
 * GET  → { projects, rows, counts } : dossiers HQ (registre + comptes de
 *        client.yaml) et, par client, le rattachement actuel et la suggestion.
 *        `?refresh=1` relit HQ au lieu du cache (10 min).
 * POST → { assignments: [{ clientId, slug | null }] } : écrit AlertClient.hqSlug
 *        et le hqSlug des dashboards sur les mêmes comptes. Rien n'est écrit
 *        dans HQ : on ne fait que pointer vers un dossier existant.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { HQ_PROJECT_RE } from "@/lib/hq-journal";
import { assignHqSlug, buildMatchRows, loadHqProjects } from "@/lib/hq-matching";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  let projects;
  try {
    projects = await loadHqProjects({ force: req.nextUrl.searchParams.get("refresh") === "1" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
  const rows = await buildMatchRows(projects);
  const counts = {
    clients: rows.length,
    linked: rows.filter((r) => r.hqSlug).length,
    suggested: rows.filter((r) => !r.hqSlug && r.suggestion).length,
    ambiguous: rows.filter((r) => !r.hqSlug && r.ambiguous).length,
    none: rows.filter((r) => !r.hqSlug && !r.suggestion && !r.ambiguous).length,
    projects: projects.length,
    projectsLinked: new Set(rows.map((r) => r.hqSlug).filter(Boolean)).size,
  };
  return NextResponse.json({ projects, rows, counts });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const list = Array.isArray(body.assignments) ? body.assignments : [];
  if (!list.length || list.length > 200) return NextResponse.json({ error: "assignments attendu (1 à 200)" }, { status: 400 });
  const projects = await loadHqProjects().catch(() => null);
  const known = projects ? new Set(projects.map((p) => p.slug)) : null;
  const done: Array<{ clientId: string; slug: string | null; dashboards: number }> = [];
  const errors: string[] = [];
  for (const a of list) {
    const clientId = typeof a?.clientId === "string" ? a.clientId : "";
    const slug = a?.slug === null || a?.slug === "" ? null : typeof a?.slug === "string" ? a.slug.trim().toLowerCase() : undefined;
    if (!clientId || slug === undefined) { errors.push("entrée invalide"); continue; }
    if (slug && !HQ_PROJECT_RE.test(slug)) { errors.push(`${clientId} : slug invalide`); continue; }
    if (slug && known && !known.has(slug)) { errors.push(`${clientId} : dossier HQ « ${slug} » inconnu`); continue; }
    try {
      const r = await assignHqSlug(clientId, slug);
      done.push({ clientId, slug, dashboards: r.dashboards });
    } catch (e) {
      errors.push(`${clientId} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return NextResponse.json({ done, errors });
}
