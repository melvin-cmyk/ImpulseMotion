import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/tiktokvWEKPzvuaeiKervgnnetgZzrGjHnHDad.txt/',
        destination: '/tiktokvWEKPzvuaeiKervgnnetgZzrGjHnHDad.txt',
      },
    ];
  },
};

export default nextConfig;
