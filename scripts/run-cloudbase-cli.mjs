import { spawn } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function requiredCredential(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing CloudBase CLI credential: ${name}`);
  }
  return value;
}

function defaultExecutablePath() {
  return path.join(
    repositoryRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tcb.cmd" : "tcb",
  );
}

function defaultAuthFilePath() {
  return path.join(os.homedir(), ".config", ".cloudbase", "auth.json");
}

function spawnProcess(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function runCloudBaseCli({
  args,
  environment = process.env,
  authFilePath = defaultAuthFilePath(),
  executablePath = defaultExecutablePath(),
  spawnProcess: runProcess = spawnProcess,
} = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("CloudBase CLI arguments are required");
  }
  if (!path.isAbsolute(authFilePath)) {
    throw new Error("CloudBase CLI credential store path must be absolute");
  }

  const secretId = requiredCredential(environment, "TENCENTCLOUD_SECRETID");
  const secretKey = requiredCredential(environment, "TENCENTCLOUD_SECRETKEY");
  await mkdir(path.dirname(authFilePath), { recursive: true, mode: 0o700 });

  let handle;
  let installed = false;
  try {
    try {
      handle = await open(authFilePath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("CloudBase CLI credential store already exists");
      }
      throw error;
    }
    installed = true;
    await handle.writeFile(
      JSON.stringify({ credential: { secretId, secretKey } }),
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;

    const childEnvironment = { ...environment };
    delete childEnvironment.TENCENTCLOUD_SECRETID;
    delete childEnvironment.TENCENTCLOUD_SECRETKEY;
    const result = await runProcess(executablePath, args, {
      cwd: repositoryRoot,
      env: childEnvironment,
      shell: false,
      stdio: "inherit",
    });
    return Number.isInteger(result?.code) ? result.code : 1;
  } finally {
    await handle?.close();
    if (installed) await rm(authFilePath, { force: true });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    if (process.argv[2] !== "--") {
      throw new Error("CloudBase CLI arguments must follow --");
    }
    process.exitCode = await runCloudBaseCli({ args: process.argv.slice(3) });
  } catch {
    process.stderr.write("CloudBase CLI credential wrapper failed\n");
    process.exitCode = 1;
  }
}
