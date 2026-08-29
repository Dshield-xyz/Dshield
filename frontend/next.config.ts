import type { NextConfig } from "next";
import withBundleAnalyzerFactory from "@next/bundle-analyzer";

const withBundleAnalyzer = withBundleAnalyzerFactory({
  // Set ANALYZE=true to emit the HTML bundle-analysis reports.
  // e.g.  ANALYZE=true pnpm build
  enabled: process.env.ANALYZE === "true",
  openAnalyzer: false,
});

const nextConfig: NextConfig = {
  // @dshield/core is an internal, source-only workspace package (its package.json
  // `exports` point straight at .ts). It is resolved through the `link:` symlink
  // in node_modules; transpilePackages tells Next/Turbopack to run it through the
  // app's SWC pipeline instead of treating it as pre-built JS, so the shared
  // note/commitment/proof logic is compiled exactly like the app's own.
  transpilePackages: ["@dshield/core"],
  // Turbopack (the default builder) resolves @dshield/core via the node_modules
  // `link:` symlink and compiles it thanks to transpilePackages — no extra
  // config needed. An explicit (empty) block signals that intent to Next 16 so
  // it doesn't warn about the webpack fallback below.
  turbopack: {},
  webpack(config) {
    // Under the `--webpack` builder, keep the symlinked package path so core's
    // bare imports (noir_js, bb.js, stellar-sdk) resolve from the app's hoisted
    // node_modules rather than from packages/core's own (empty) tree.
    config.resolve = config.resolve || {};
    config.resolve.symlinks = false;
    return config;
  },
};

export default withBundleAnalyzer(nextConfig);
