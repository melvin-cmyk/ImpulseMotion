/**
 * GET /api/relay/files/<conversationId>/<out|uploads>/<name> — fichiers du
 * bac à sable d'une conversation console (staff only). Le workspace est
 * dérivé de l'utilisateur connecté + l'id de conversation : un consultant ne
 * peut lire que ses propres conversations.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { contentTypeFor, workspaceIdFor, WORKSPACE_PATH_RE } from "@/lib/relay-workspace";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ cid: string; path: string[] }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { cid, path } = await params;
  if (!UUID_RE.test(cid)) return NextResponse.json({ error: "conversation invalide" }, { status: 400 });
  const rel = (path ?? []).join("/");
  if (!WORKSPACE_PATH_RE.test(rel)) return NextResponse.json({ error: "chemin invalide" }, { status: 400 });

  const ws = workspaceIdFor(`console:${guard.session.userId}:${cid}`);
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
