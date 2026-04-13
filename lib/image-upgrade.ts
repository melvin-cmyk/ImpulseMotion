/**
 * Utilities for turning small Meta / Google CDN thumbnails into the highest
 * resolution variant the CDN will serve us, and for sniffing image bytes to
 * detect low-resolution sources (for the "pixelated creative" warning).
 */

// Meta's scontent CDN exposes resized variants via path fragments like
// `/s64x64/`, `/p128x128/`, or `/c12.0.256.256/`. Rewriting these to
// `/p1200x1200/` makes the CDN serve a much larger version of the same asset.
// The helper also strips any explicit width/height query params Facebook sets.
export function upgradeImageUrl(url: string | undefined | null): string | undefined {
  if (!url) return url ?? undefined;
  try {
    let upgraded = url
      .replace(/\/(s|p)\d+x\d+\//g, "/p1200x1200/")
      .replace(/\/c\d+\.\d+\.\d+\.\d+\//g, "/p1200x1200/")
      .replace(/\/c\d+\.\d+x\d+\//g, "/p1200x1200/");

    // scontent sometimes encodes the size in a query param (e.g. &sx=64).
    // Drop those so the CDN falls back to the native asset size.
    try {
      const u = new URL(upgraded);
      ["sx", "sy", "width", "height", "size"].forEach((k) => u.searchParams.delete(k));
      upgraded = u.toString();
    } catch {
      /* not a parseable URL — leave as-is */
    }

    return upgraded;
  } catch {
    return url;
  }
}

/**
 * Sniff width/height from an image buffer without pulling sharp.
 * Supports JPEG, PNG, GIF and WebP — enough for the formats Meta / Google
 * return. Returns null if the format isn't recognised.
 */
export function sniffImageSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 12) return null;

  // PNG — 8-byte signature then IHDR at offset 16 (4+4+4+4).
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
    const h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
    return { width: w, height: h };
  }

  // GIF — logical screen descriptor at offset 6.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const w = buf[6] | (buf[7] << 8);
    const h = buf[8] | (buf[9] << 8);
    return { width: w, height: h };
  }

  // WebP — RIFF....WEBP then VP8/VP8L/VP8X chunk.
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    // VP8X extended — dimensions at offset 24 (24-bit little-endian + 1).
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
    // VP8 lossy — dimensions at offset 26.
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
      const w = ((buf[27] << 8) | buf[26]) & 0x3fff;
      const h = ((buf[29] << 8) | buf[28]) & 0x3fff;
      return { width: w, height: h };
    }
  }

  // JPEG — scan for SOF0..SOF15 markers, skipping unrelated segments.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0–SOF15 (excluding DHT=0xc4, JPG=0xc8, DAC=0xcc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (buf[i + 5] << 8) | buf[i + 6];
        const w = (buf[i + 7] << 8) | buf[i + 8];
        return { width: w, height: h };
      }
      // Segment length follows the marker at i+2 (big-endian 16-bit).
      const segLen = (buf[i + 2] << 8) | buf[i + 3];
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
  }

  return null;
}

/** Threshold under which a creative is flagged as too pixelated to present. */
export const LOW_RES_THRESHOLD_PX = 240;
