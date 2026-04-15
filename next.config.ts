import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        // Apply CSP headers to all routes
        source: "/(.*)",
        headers: [
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
              // In dev, allow the local relay server (localhost:3457) and the public relay IP.
              // In prod, same-origin + trycloudflare tunnel is used.
              `connect-src 'self' https://graph.facebook.com https://api.tiktok.com https://*.trycloudflare.com${
                process.env.NODE_ENV !== "production"
                  ? " http://localhost:3457 http://127.0.0.1:3457 http://72.62.29.196:3457"
                  : ""
              }`,
              // Allow Facebook video embeds
              "frame-src 'self' https://www.facebook.com https://video.facebook.com https://web.facebook.com",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
