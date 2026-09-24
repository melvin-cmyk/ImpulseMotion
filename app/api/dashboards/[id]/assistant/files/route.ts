/**
 * Dépôt d'un fichier du consultant dans le workspace du bac à sable de sa
 * conversation copilote (staff only) : { name, data(base64) } → le relay
 * l'écrit dans uploads/ et l'IA le lit avec run_python.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { denyIfDashboardOutOfScope } from "@/lib/dashboard-auth";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { workspaceIdFor } from "@/lib/relay-workspace";

const NAME_RE = /^[A-Za-z0-9._ \-()]{1,120}$/;
const EXT_RE = /\.(xlsx?|xlsm|csv|tsv|txt|md|json|pdf|docx?|pptx?)$/i;
const MAX_B64_CHARS = 4_200_000; // ≈3 MB decoded, under Vercel's 4.5 MB body cap

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const denied = await denyIfDashboardOutOfScope(guard.session, id);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const rawName = typeof body.name === "string" ? body.name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ \-()]/g, "_").slice(0, 120) : "";
  const data = typeof body.data === "string" ? body.data : "";
  if (!NAME_RE.test(rawName) || !EXT_RE.test(rawName) || rawName.startsWith(".")) {
    return NextResponse.json({ error: "Nom de fichier ou format non accepté" }, { status: 400 });
  }
  if (!data || data.length > MAX_B64_CHARS) return NextResponse.json({ error: "Fichier vide ou trop lourd (3 Mo max)" }, { status: 413 });

  const ws = workspaceIdFor(`copilot:${id}:${guard.session.userId}`);
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ name: rawName, data }),
        signal: AbortSignal.timeout(30000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      return NextResponse.json({ path: json.path, bytes: json.bytes, name: rawName });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: `Dépôt impossible (${lastError})` }, { status: 502 });
}
