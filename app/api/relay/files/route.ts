/**
 * POST /api/relay/files — dépôt d'un fichier du consultant (staff only) dans
 * le workspace du bac à sable de sa conversation console
 * (`console:<userId>:<conversationId>`) : { conversationId, name, data(base64) }.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { workspaceIdFor } from "@/lib/relay-workspace";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9._ \-()]{1,120}$/;
const EXT_RE = /\.(xlsx?|xlsm|csv|tsv|txt|md|json|pdf|docx?|pptx?)$/i;
const MAX_B64_CHARS = 4_200_000; // ≈3 MB decoded, under Vercel's 4.5 MB body cap

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const conversationId = typeof body.conversationId === "string" && UUID_RE.test(body.conversationId) ? body.conversationId : null;
  if (!conversationId) return NextResponse.json({ error: "conversationId requis" }, { status: 400 });
  const name = typeof body.name === "string" ? body.name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ \-()]/g, "_").slice(0, 120) : "";
  const data = typeof body.data === "string" ? body.data : "";
  if (!NAME_RE.test(name) || !EXT_RE.test(name) || name.startsWith(".")) {
    return NextResponse.json({ error: "Nom de fichier ou format non accepté" }, { status: 400 });
  }
  if (!data || data.length > MAX_B64_CHARS) return NextResponse.json({ error: "Fichier vide ou trop lourd (3 Mo max)" }, { status: 413 });

  const ws = workspaceIdFor(`console:${guard.session.userId}:${conversationId}`);
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ name, data }),
        signal: AbortSignal.timeout(30000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      return NextResponse.json({ path: json.path, bytes: json.bytes, name });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: `Dépôt impossible (${lastError})` }, { status: 502 });
}
