import { NextResponse } from "next/server";
import { getAdvertisers, getTikTokSystemToken } from "@/lib/tiktok-api";
import { requireSession } from "@/lib/auth-helpers";
import { getAllowedAccountIds } from "@/lib/acl";

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  try {
    const token = getTikTokSystemToken();
    const advertisers = await getAdvertisers(token);

    if (guard.session.role === "admin") {
      return NextResponse.json(advertisers);
    }
    const allowed = new Set(await getAllowedAccountIds(guard.session.userId, "tiktok"));
    const filtered = advertisers.filter((a) => allowed.has(a.advertiser_id));
    return NextResponse.json(filtered);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
