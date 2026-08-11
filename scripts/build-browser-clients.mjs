import { build } from "esbuild";

await build({
  entryPoints: {
    "admin-app": "admin-client/index.ts",
    "homepage-media": "homepage-media-client/index.ts",
    "wechat-entry": "wechat-entry-client/index.ts",
  },
  outdir: "public",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2017",
  define: {
    "process.env.CLOUDBASE_ENV": "undefined",
  },
  legalComments: "none",
  minify: true,
  sourcemap: false,
});
