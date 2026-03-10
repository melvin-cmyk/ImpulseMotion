import { auth } from "@/auth";
import { getAdvertisers } from "@/lib/tiktok-api";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();

  if (!session || !session.tiktokAccessToken) {
    return NextResponse.json({ error: "Not authenticated with TikTok" }, { status: 401 });
  }

  try {
    const advertisers = await getAdvertisers(session.tiktokAccessToken as string);
    return NextResponse.json(advertisers);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
