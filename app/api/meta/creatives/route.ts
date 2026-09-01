/**
 * GET /api/meta/creatives?accountId=&since=&until=&campaignId=&refresh=1
 *
 * Real Meta ad-level data for the Analyse Ads pages → `{ creatives, meta }`.
 * The loader (field provenance, caching) lives in lib/creatives-server.ts and
 * is shared with /api/creatives/analyze and /api/meta/wow.
 *
 * Range: `since`/`until` (YYYY-MM-DD, max 400 days) or `preset`; default =
 * the last 30 full days ending yesterday in the account timezone.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";
import { loadCreatives } from "@/lib/creatives-server";
import { rangeFromParams } from "@/lib/date-ranges";
import { getAccountProfileSettings } from "@/lib/account-settings";
import { MetaApiError } from "@/lib/meta-errors";

// Large accounts (3 500+ ads over 30 days) need ~100 s cold: 5 paged lists +
// video source resolution. Vercel Pro allows up to 300 s; 120 s is the budget.
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const { searchParams } = new URL(request.url);
  const accountId = searchParams.get("accountId");
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });

  if (guard.session.role !== "admin") {
    const allowed = await assertAccountAllowed(guard.session.userId, "meta", accountId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // The default window is computed in the account timezone ("yesterday" in
  // Johannesburg is not "yesterday" in UTC).
  const settings = await getAccountProfileSettings("meta", accountId);
  const validated = rangeFromParams(searchParams, "last_30", { tz: settings.timezone });
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const campaignId = searchParams.get("campaignId");
  const refresh = searchParams.get("refresh") === "1";

  try {
    const payload = await loadCreatives(accountId, validated.range, refresh);
    const creatives = campaignId ? payload.creatives.filter((c) => c.campaignId === campaignId) : payload.creatives;
    return NextResponse.json({ creatives, meta: payload.meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[creatives route] error:", err);
    const status = err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500 ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
