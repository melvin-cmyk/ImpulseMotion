/**
 * GET /api/creas/ad-library?q=<brand>[&country=FR][&all=1] → { ads, configured, error? }
 * Competitors' ads from the Meta Ad Library (staff). Without the token the
 * answer explains the one-time setup (lib/creas/ad-library.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { adLibraryConfigured, searchAdLibrary } from "@/lib/creas/ad-library";

/** A cold search (the relay starts its Chromium) takes up to ~80 s on a busy server. */
export const maxDuration = 150;

export async function GET(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const q = req.nextUrl.searchParams;
  const country = (q.get("country") ?? "FR").toUpperCase().slice(0, 2);
  const result = await searchAdLibrary({ q: q.get("q") ?? "", country: /^[A-Z]{2}$/.test(country) ? country : "FR", active: q.get("all") !== "1" });
  return NextResponse.json({ configured: adLibraryConfigured(), ...result }, { headers: { "Cache-Control": "no-store" } });
}
