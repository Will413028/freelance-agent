import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

// No response is content-sniffed (plan step 11). Caching is not set here: Next overrides
// Cache-Control on pages, which are force-dynamic, and writes send no-store themselves (guard.ts).
const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] }];
  },
};

export default withWorkflow(nextConfig);
