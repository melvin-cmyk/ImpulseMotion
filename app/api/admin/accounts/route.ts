/**
 * Admin : pool de comptes Claude Max du relay.
 *   GET    → liste (libellé, utilisation, état), sans jetons
 *   POST   { label, token } → ajoute un compte (jeton `claude setup-token`,
 *            vérifié par le relay auprès d'Anthropic avant enregistrement)
 *   DELETE { id } → retire un compte (jamais le compte serveur)
 * Les jetons ne transitent que du navigateur admin vers le relay, en HTTPS,
 * et sont stockés 0600 sur le serveur du relay.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

async function relay(method: "GET" | "POST" | "DELETE", body?: unknown) {
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/accounts`, {
        method,
        headers: relayHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { lastError = json.error ?? `relay ${res.status}`; if (res.status < 500) return NextResponse.json({ error: lastError }, { status: res.status }); continue; }
      return NextResponse.json(json, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return NextResponse.json({ error: lastError }, { status: 502 });
}

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  return relay("GET");
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!label || !token) return NextResponse.json({ error: "libellé et jeton requis" }, { status: 400 });
  return relay("POST", { label, token });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" && /^[a-z0-9][a-z0-9-]{1,30}$/.test(body.id) ? body.id : "";
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });
  return relay("DELETE", { id });
}
