/**
 * GET /api/deck/proxy-image?url=...
 * Fetches an external image server-side (avoids browser CORS/mixed-content) and streams it back.
 *
 * Also sniffs the image dimensions and attaches them as response headers so
 * the client can warn when a creative is rendered from a low-resolution
 * source. When `?upgrade=1` is set, we first try the URL with Meta's CDN
 * size fragment rewritten to /p1200x1200/ — that rescues most Meta thumbnail
 * URLs without needing sharp.
 *
 * Add &format=base64 to get JSON with a data URL (for PPTX export).
 */
import { NextRequest, NextResponse } from "next/server";
import { upgradeImageUrl, sniffImageSize, LOW_RES_THRESHOLD_PX } from "@/lib/image-upgrade";

async function fetchImage(url: string) {
  return fetch(url, {
    headers: { "User-Agent": "ImpulseAnalytics/1.0" },
    signal: AbortSignal.timeout(8000),
  });
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url param" }, { status: 400 });

  const format = req.nextUrl.searchParams.get("format"); // "base64" for JSON data URL

  try {
    // Always try the upgraded URL first — it costs nothing if the pattern
    // doesn't match, and fixes the majority of Meta CDN thumbnails.
    const upgraded = upgradeImageUrl(url) ?? url;
    let res = upgraded !== url ? await fetchImage(upgraded) : await fetchImage(url);

    // Fall back to the original URL if the CDN rejects the upgraded variant.
    if (!res.ok && upgraded !== url) {
      res = await fetchImage(url);
    }
    if (!res.ok) return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const size = sniffImageSize(bytes);
    const smallestEdge = size ? Math.min(size.width, size.height) : 0;
    const lowRes = size ? smallestEdge < LOW_RES_THRESHOLD_PX : false;
    if (lowRes) {
      console.warn(`[proxy-image] low-res creative ${size?.width}x${size?.height} — ${url.slice(0, 120)}`);
    }

    if (format === "base64") {
      const base64 = Buffer.from(buffer).toString("base64");
      return NextResponse.json({
        dataUrl: `data:${contentType};base64,${base64}`,
        width: size?.width,
        height: size?.height,
        lowRes,
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    };
    if (size) {
      headers["X-Image-Width"] = String(size.width);
      headers["X-Image-Height"] = String(size.height);
    }
    if (lowRes) headers["X-Low-Res"] = "1";

    return new NextResponse(buffer, { headers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
