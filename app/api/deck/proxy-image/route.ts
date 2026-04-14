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

// Target size for the upscale pass — hero cards render at ~614px wide and
// top-creative cards at ~352px. Giving them a ~1200px source avoids visible
// bilinear pixelation in the PPTX renderer.
const UPSCALE_TARGET_PX = 1200;
const UPSCALE_TRIGGER_PX = 800;

async function fetchImage(url: string) {
  return fetch(url, {
    headers: { "User-Agent": "ImpulseAnalytics/1.0" },
    signal: AbortSignal.timeout(8000),
  });
}

async function upscaleIfSmall(
  buffer: ArrayBuffer,
  size: { width: number; height: number } | null,
): Promise<{ buffer: ArrayBuffer; size: { width: number; height: number } | null; contentType: string }> {
  if (!size || Math.min(size.width, size.height) >= UPSCALE_TRIGGER_PX) {
    return { buffer, size, contentType: "" };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = (await import("sharp")).default;
    const scale = UPSCALE_TARGET_PX / Math.min(size.width, size.height);
    const targetW = Math.round(size.width * scale);
    const targetH = Math.round(size.height * scale);
    const out = await sharp(Buffer.from(buffer))
      .resize(targetW, targetH, { kernel: "lanczos3", fit: "fill" })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    return {
      buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
      size: { width: targetW, height: targetH },
      contentType: "image/jpeg",
    };
  } catch (e) {
    console.warn("[proxy-image] sharp upscale failed (non-blocking):", e);
    return { buffer, size, contentType: "" };
  }
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

    const originalContentType = res.headers.get("content-type") ?? "image/jpeg";
    const originalBuffer = await res.arrayBuffer();
    const originalSize = sniffImageSize(new Uint8Array(originalBuffer));
    const smallestEdge = originalSize ? Math.min(originalSize.width, originalSize.height) : 0;
    const lowRes = originalSize ? smallestEdge < LOW_RES_THRESHOLD_PX : false;
    if (lowRes) {
      console.warn(`[proxy-image] low-res creative ${originalSize?.width}x${originalSize?.height} — ${url.slice(0, 120)}`);
    }

    // Upscale with sharp when the source is smaller than our render target.
    // Skips the transform when the image is already big enough.
    const upscaled = await upscaleIfSmall(originalBuffer, originalSize);
    const buffer = upscaled.buffer;
    const size = upscaled.size;
    const contentType = upscaled.contentType || originalContentType;

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
