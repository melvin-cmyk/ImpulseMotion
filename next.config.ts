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
};

export default nextConfig;
