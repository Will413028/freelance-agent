import type { NextConfig } from "next";

// No response is content-sniffed (plan step 11). Caching is not set here: Next overrides
// Cache-Control on pages, which are force-dynamic, and writes send no-store themselves (guard.ts).
const nextConfig: NextConfig = {
  // impit (tier-2 reading, plan step 8c) ships a native addon that cannot be bundled; it loads from
  // node_modules at run time (the image keeps the whole node_modules).
  serverExternalPackages: ["impit"],
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }];
  },
};

export default nextConfig;
