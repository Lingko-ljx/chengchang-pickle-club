import type { NextConfig } from "next";
import { siteConfiguration } from "./app/site-config";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = isGitHubPages
  ? {
      output: "export",
      trailingSlash: true,
      basePath: siteConfiguration.basePath,
      typescript: {
        tsconfigPath: "tsconfig.pages.json",
      },
    }
  : {};

export default nextConfig;
