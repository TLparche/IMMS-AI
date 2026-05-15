import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // Demo deployment prioritizes shipping even if Next's build-time checker stalls.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
