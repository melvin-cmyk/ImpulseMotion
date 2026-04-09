/**
 * GET /api/deck/proxy-image?url=...
 * Fetches an external image server-side (avoids browser CORS/mixed-content) and streams it back.
 *
 * By default returns the raw image (for use in <img> tags).
 * Add &format=base64 to get JSON with a data URL (for PPTX export).
 */
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url param" }, { status: 400 });

  const format = req.nextUrl.searchParams.get("format"); // "base64" for JSON data URL

  try {
    const res = await fetch(url, { headers: { "User-Agent": "ImpulseAnalytics/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = await res.arrayBuffer();

    if (format === "base64") {
      // Return as JSON with base64 data URL (used by PPTX export)
      const base64 = Buffer.from(buffer).toString("base64");
      return NextResponse.json({ dataUrl: `data:${contentType};base64,${base64}` });
    }

    // Return raw image bytes (used by <img> tags)
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
