/**
 * POST /api/ads/organic/competitor — last 25 posts of a public Instagram
 * business account (competitor, inspiration), read through the client's own
 * Instagram account (business_discovery). Same body and scope rules as
 * /api/ads/query, plus { username }. Staff only.
 */

import { NextRequest, NextResponse } from "next/server";
import { parseScopedQuery } from "@/lib/ads-warehouse/api";
import { requireStaff } from "@/lib/auth-helpers";
import { readCompetitorIg, readOrganic } from "@/lib/ads-warehouse/organic";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const b = (await req.clone().json().catch(() => ({}))) as { username?: string };
  const username = String(b.username ?? "").trim();
  if (!username) return NextResponse.json({ error: "Nom de compte attendu" }, { status: 400 });
  const parsed = await parseScopedQuery(req);
  if ("error" in parsed) return parsed.error;
  try {
    const { igId } = await readOrganic(parsed.q);
    if (!igId) return NextResponse.json({ error: "Ce client n'a pas de compte Instagram lisible : impossible de consulter un autre compte." }, { status: 400 });
    return NextResponse.json(await readCompetitorIg(username, igId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Lecture impossible";
    return NextResponse.json({ error: /\(#110\)|Invalid user id|cannot be found|does not exist/i.test(msg) ? "Compte introuvable : il doit exister et être un compte professionnel Instagram." : msg }, { status: 502 });
  }
}
