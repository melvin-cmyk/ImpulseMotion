import type { NextConfig } from "next";

// The FigCraft editor (design files, lib/design) is served by the relay's
// host and shown in an iframe: its origin must be allowed in frame-src.
function figcraftFrameOrigin(): string {
  try {
    const u = process.env.NEXT_PUBLIC_FIGCRAFT_URL ? new URL(process.env.NEXT_PUBLIC_FIGCRAFT_URL) : null;
    return u && u.protocol === "https:" ? ` ${u.origin}` : "";
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  // Build id baked into the client bundle, compared with /api/version by
  // open tabs (components/ai/stale-build.tsx).
  env: { NEXT_PUBLIC_APP_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
  // trailingSlash: true,
  images: {
    // Allow Meta CDN hostnames so next/image can optimise (or pass through) ad creative thumbnails.
    // Meta serves creative assets from several scontent-*.fbcdn.net shards plus lookaside.fbsbx.com.
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.fbcdn.net",
      },
      {
        protocol: "https",
        hostname: "**.fbsbx.com",
      },
      {
        protocol: "https",
        hostname: "**.facebook.com",
      },
      {
        protocol: "https",
        hostname: "p16-sign-sg.tiktokcdn.com",
      },
      {
        protocol: "https",
        hostname: "**.tiktokcdn.com",
      },
      {
        protocol: "https",
        hostname: "**.tiktok.com",
      },
    ],
  },
  async headers() {
    return [
      {
        // Security headers on every route.
        source: "/(.*)",
        headers: [
          // Browsers that have seen the site once only reach it over HTTPS (two years).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // The app is never embedded by another site (clickjacking on the admin and pilot pages).
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          {
            key: "Content-Security-Policy",
            // Allow Facebook iframes for Meta video embedding (facebook.com/video/embed)
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: https: blob:",
              "media-src 'self' https: blob:",
              // The browser only ever talks to this origin: the relay is reached
              // server-side (lib/relay-server.ts), never from a page.
              "connect-src 'self' https://graph.facebook.com",
              // Allow Facebook video embeds + the official ad previews of Analyse Ads
              // (business.facebook.com/ads/api/preview_iframe.php)
              // + the FigCraft editor of the design pages (NEXT_PUBLIC_FIGCRAFT_URL)
              `frame-src 'self' https://www.facebook.com https://video.facebook.com https://web.facebook.com https://business.facebook.com${figcraftFrameOrigin()}`,
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
