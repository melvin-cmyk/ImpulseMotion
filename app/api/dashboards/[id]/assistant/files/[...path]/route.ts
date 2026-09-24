/**
 * Fichiers du bac à sable du copilote (staff only) : graphiques et exports
 * produits par l'IA dans le workspace de la conversation, servis par le relay
 * et relayés ici avec la même garde que le copilote (rôle staff + périmètre
 * du dashboard). Le workspace est celui de la conversation du consultant
 * connecté : `copilot:<dashboardId>:<userId>`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { contentTypeFor, workspaceIdFor, WORKSPACE_PATH_RE } from "@/lib/relay-workspace";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, path } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const rel = (path ?? []).join("/");
  if (!WORKSPACE_PATH_RE.test(rel)) return NextResponse.json({ error: "chemin invalide" }, { status: 400 });
  const ws = workspaceIdFor(`copilot:${id}:${guard.session.userId}`);
  const name = rel.split("/").pop() ?? "fichier";
  const download = !contentTypeFor(name).startsWith("image/");

  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}/${encodeURIComponent(rel).replace(/%2F/g, "/")}`, {
        headers: relayHeaders(),
        signal: AbortSignal.timeout(20000),
      });
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
    } catch { /* next url */ }
  }
  return NextResponse.json({ error: "relay indisponible" }, { status: 502 });
}
