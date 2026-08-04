import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const testsDirectory = fileURLToPath(new URL("../tests/", import.meta.url));
const files = readdirSync(testsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => entry.name)
  .filter((name) => name !== "pages-static-export.test.mjs")
  .sort()
  .map((name) => join(testsDirectory, name));

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
