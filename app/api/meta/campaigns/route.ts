import { NextRequest, NextResponse } from "next/server";
import { getCampaigns, getMetaSystemToken } from "@/lib/meta-api";
import { requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed } from "@/lib/acl";

export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const { searchParams } = new URL(request.url);
  const adAccountId = searchParams.get("accountId");
  if (!adAccountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  if (guard.session.role !== "admin") {
    const allowed = await assertAccountAllowed(guard.session.userId, "meta", adAccountId);
    if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const statusFilter = searchParams.get("status");

  try {
    const token = getMetaSystemToken();
    const campaigns = await getCampaigns(token, adAccountId);
    const filtered = statusFilter ? campaigns.filter((c) => c.status === statusFilter) : campaigns;
    return NextResponse.json(filtered);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
