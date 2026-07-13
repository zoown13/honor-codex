import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  trailingSlash: true,
  transpilePackages: ["@honor/core"],
  images: { unoptimized: true }
};

export default nextConfig;
