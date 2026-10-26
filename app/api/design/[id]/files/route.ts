/**
 * /api/design/[id]/files — the design's workspace on the relay (shared by the staff).
 *   GET  → { files: [{ path, name, bytes }] } (uploads/ and out/)
 *   POST { name, data (base64) } → { path, bytes, name }: an image, SVG, FigCraft
 *        or PDF the AI may place in the design (uploads/<name>).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { workspaceIdFor } from "@/lib/relay-workspace";
import { loadDesign } from "@/lib/design/access";
import { DESIGN_FILES_UPLOAD_RE, designSessionKey } from "@/lib/design/model";

const NAME_RE = /^[A-Za-z0-9._ \-()]{1,120}$/;
const MAX_B64_CHARS = 4_200_000; // ≈3 MB decoded, under Vercel's 4.5 MB body cap

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const design = await loadDesign(id);
  if (!design) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ws = workspaceIdFor(designSessionKey(design.id));
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, { headers: relayHeaders(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const json = (await res.json()) as { files?: Array<{ path: string; bytes: number }> };
      const files = (json.files ?? []).map((f) => ({ path: f.path, name: f.path.split("/").pop() ?? f.path, bytes: f.bytes }));
      return NextResponse.json({ files }, { headers: { "Cache-Control": "no-store" } });
    } catch { /* next url */ }
  }
  return NextResponse.json({ files: [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const { id } = await params;
  const design = await loadDesign(id);
  if (!design) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { name?: unknown; data?: unknown };
  const name = typeof body.name === "string" ? body.name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ \-()]/g, "_").slice(0, 120) : "";
  const data = typeof body.data === "string" ? body.data : "";
  if (!NAME_RE.test(name) || !DESIGN_FILES_UPLOAD_RE.test(name) || name.startsWith(".")) {
    return NextResponse.json({ error: "Formats acceptés : images (PNG, JPG, WebP, GIF), SVG, .figcraft, .fig, JSON, PDF." }, { status: 400 });
  }
  if (!data || data.length > MAX_B64_CHARS) return NextResponse.json({ error: "Fichier vide ou trop lourd (3 Mo max)" }, { status: 413 });

  const ws = workspaceIdFor(designSessionKey(design.id));
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, { method: "POST", headers: relayHeaders(), body: JSON.stringify({ name, data }), signal: AbortSignal.timeout(30000) });
      const json = (await res.json().catch(() => ({}))) as { path?: string; bytes?: number; error?: string };
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; continue; }
      return NextResponse.json({ path: json.path, bytes: json.bytes, name });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: `Dépôt impossible (${lastError})` }, { status: 502 });
}
