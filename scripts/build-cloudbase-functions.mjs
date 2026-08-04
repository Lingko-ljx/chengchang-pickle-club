import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const functionTargets = {
  "booking-public-api": {
    entry: "cloudbase/src/functions/booking-public-api.ts",
    outfile: "cloudbase/functions/booking-public-api/index.js",
  },
  "booking-admin-api": {
    entry: "cloudbase/src/functions/booking-admin-api.ts",
    outfile: "cloudbase/functions/booking-admin-api/index.js",
  },
  "booking-mailer": {
    entry: "cloudbase/src/functions/booking-mailer.ts",
    outfile: "cloudbase/functions/booking-mailer/index.js",
  },
};

export function parseTargets(args) {
  if (args.length === 0) throw new Error("At least one CloudBase function target is required");
  for (const target of args) {
    if (!Object.hasOwn(functionTargets, target)) {
      throw new Error(`Unknown CloudBase function target: ${target}`);
    }
  }
  return [...args];
}

export async function buildTargets(args) {
  const targets = parseTargets(args);
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  for (const target of targets) {
    const { entry, outfile } = functionTargets[target];
    const absoluteEntry = resolve(repositoryRoot, entry);
    const absoluteOutfile = resolve(repositoryRoot, outfile);
    if (!existsSync(absoluteEntry)) {
      throw new Error(`CloudBase function source is missing: ${entry}`);
    }
    await mkdir(dirname(absoluteOutfile), { recursive: true });
    await build({
      bundle: true,
      entryPoints: [absoluteEntry],
      external: ["@cloudbase/node-sdk", "tencentcloud-sdk-nodejs-ses"],
      format: "cjs",
      outfile: absoluteOutfile,
      platform: "node",
      target: "node20",
    });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    await buildTargets(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
