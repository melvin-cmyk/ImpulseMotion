import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/tiktokvWEKPzvuaeiKervgnnetgZzrGjHnHDad.txt/',
          destination: '/api/tiktok-verify',
        },
        {
          source: '/tiktokvWEKPzvuaeiKervgnnetgZzrGjHnHDad.txt',
          destination: '/api/tiktok-verify',
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
