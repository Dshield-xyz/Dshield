import type { NextConfig } from "next";
import withBundleAnalyzerFactory from "@next/bundle-analyzer";

const withBundleAnalyzer = withBundleAnalyzerFactory({
  // Set ANALYZE=true to emit the HTML bundle-analysis reports.
  // e.g.  ANALYZE=true pnpm build
  enabled: process.env.ANALYZE === "true",
  openAnalyzer: false,
});

const nextConfig: NextConfig = {
  env: {
    // Expose only a boolean so production clients can warn about a blocked
    // dev-secret configuration without ever inlining the secret value itself.
    NEXT_PUBLIC_DEV_SECRET_KEY_CONFIGURED: process.env.NEXT_PUBLIC_DEV_SECRET_KEY
      ? "true"
      : "",
  },
};

export default withBundleAnalyzer(nextConfig);
