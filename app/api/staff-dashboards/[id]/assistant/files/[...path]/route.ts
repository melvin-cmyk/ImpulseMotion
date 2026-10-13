/**
 * Fichiers du bac à sable du copilote d'un dashboard du staff : graphiques et
 * exports produits par l'IA dans le workspace de la conversation, servis par
 * le relay et relayés ici avec la même garde que le copilote.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { contentTypeFor, workspaceIdFor, WORKSPACE_PATH_RE } from "@/lib/relay-workspace";
import { staffCopilotSessionKey } from "@/lib/staff-dashboards/copilot";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, path } = await params;
  const row = await prisma.staffDashboard.findUnique({ where: { id }, select: { ownerId: true } });
  if (!row) return NextResponse.json({ error: "introuvable" }, { status: 404 });
  if (row.ownerId !== guard.session.userId && guard.session.role !== "admin") return NextResponse.json({ error: "réservé au propriétaire" }, { status: 403 });

  const rel = (path ?? []).join("/");
  if (!WORKSPACE_PATH_RE.test(rel)) return NextResponse.json({ error: "chemin invalide" }, { status: 400 });
  const ws = workspaceIdFor(staffCopilotSessionKey(id, guard.session.userId));
  const name = rel.split("/").pop() ?? "fichier";
  const download = !contentTypeFor(name).startsWith("image/");

  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}/${encodeURIComponent(rel).replace(/%2F/g, "/")}`, { headers: relayHeaders(), signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return NextResponse.json({ error: "fichier introuvable (expiré ?)" }, { status: 404 });
      if (!res.ok || !res.body) continue;
      return new Response(res.body, {
        status: 200,
        headers: {
          "Content-Type": contentTypeFor(name),
          "Cache-Control": "private, max-age=300",
          ...(download ? { "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"` } : {}),
          ...(res.headers.get("content-length") ? { "Content-Length": res.headers.get("content-length")! } : {}),
        },
      });
    } catch { /* url suivante */ }
  }
  return NextResponse.json({ error: "relay indisponible" }, { status: 502 });
}
