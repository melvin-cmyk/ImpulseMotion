import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { getAccountScope, tiktokInScope } from "@/lib/scope";
import { listTikTokAdvertisers } from "@/lib/tiktok-data";

/**
 * TikTok ad accounts the agency's token reads (every Business Center), for the
 * account pickers. Same rule as the Meta and Google listings: a consultant sees
 * the advertisers assigned to them, not the whole agency.
 */
export async function GET(req: Request) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const scope = await getAccountScope(guard.session);
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  try {
    const list = await listTikTokAdvertisers({ fresh });
    const accounts = list
      .filter((a) => tiktokInScope(scope, a.id))
      .map((a) => ({ accountId: a.id, name: a.name, currency: "", businessCenters: a.businessCenters }));
    return NextResponse.json({ accounts });
  } catch (e) {
    console.error("[tiktok] liste des comptes:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "TikTok n'a pas pu être interrogé pour le moment." }, { status: 502 });
  }
}
