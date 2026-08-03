import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Workspace packages are consumed as TypeScript source rather than built
   * output, so Next compiles them itself. This keeps the shared contracts a
   * single source of truth with no build step between editing and using them.
   */
  transpilePackages: ["@clientatlas/contracts", "@clientatlas/database"],
};

export default nextConfig;
