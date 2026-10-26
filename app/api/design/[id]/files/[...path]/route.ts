/**
 * GET /api/design/[id]/files/out/<name> | uploads/<name> → the file from the
 * design's workspace on the relay (exports the AI made, files deposited).
 * Images are shown inline (the thread's ![…](sandbox:out/…) links); the rest downloads.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { contentTypeFor, workspaceIdFor, WORKSPACE_PATH_RE } from "@/lib/relay-workspace";
import { loadDesign } from "@/lib/design/access";
import { designSessionKey } from "@/lib/design/model";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id, path } = await params;
  const design = await loadDesign(id);
  if (!design) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rel = (path ?? []).join("/");
  if (!WORKSPACE_PATH_RE.test(rel)) return NextResponse.json({ error: "chemin invalide" }, { status: 400 });

  const ws = workspaceIdFor(designSessionKey(design.id));
  const name = rel.split("/").pop() ?? "fichier";
  const type = contentTypeFor(name);
  const inline = type.startsWith("image/") && !type.includes("svg");
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}/${encodeURIComponent(rel).replace(/%2F/g, "/")}`, { headers: relayHeaders(), signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return NextResponse.json({ error: "fichier introuvable (expiré ?)" }, { status: 404 });
      if (!res.ok || !res.body) continue;
      return new Response(res.body, {
        status: 200,
        headers: {
          "Content-Type": type,
          "Cache-Control": "private, max-age=300",
          ...(inline ? {} : { "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"` }),
          ...(res.headers.get("content-length") ? { "Content-Length": res.headers.get("content-length")! } : {}),
        },
      });
    } catch { /* next url */ }
  }
  return NextResponse.json({ error: "relay indisponible" }, { status: 502 });
}
