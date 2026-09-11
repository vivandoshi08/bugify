import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@bugify/sdk"],
  agentRules: false,
};

export default nextConfig;
