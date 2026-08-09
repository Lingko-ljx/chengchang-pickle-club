import { build } from "esbuild";

await build({
  entryPoints: ["admin-client/index.ts"],
  outfile: "public/admin-app.js",
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
