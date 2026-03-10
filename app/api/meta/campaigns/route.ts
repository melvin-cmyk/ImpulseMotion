import { auth } from "@/auth";
import { getCampaigns } from "@/lib/meta-api";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth();

  if (!session || !session.metaAccessToken) {
    return NextResponse.json({ error: "Not authenticated with Meta" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const adAccountId = searchParams.get("accountId");

  if (!adAccountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const statusFilter = searchParams.get("status");

  try {
    const campaigns = await getCampaigns(session.metaAccessToken as string, adAccountId);
    const filtered = statusFilter
      ? campaigns.filter((c) => c.status === statusFilter)
      : campaigns;
    return NextResponse.json(filtered);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
