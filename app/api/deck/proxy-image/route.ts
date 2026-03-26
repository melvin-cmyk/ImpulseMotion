/**
 * GET /api/deck/proxy-image?url=...
 * Fetches an external image server-side (avoids browser CORS) and returns it as base64.
 */
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url param" }, { status: 400 });

  try {
    const res = await fetch(url, { headers: { "User-Agent": "ImpulseAnalytics/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return NextResponse.json({ dataUrl: `data:${contentType};base64,${base64}` });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
