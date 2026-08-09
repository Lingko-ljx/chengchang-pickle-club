import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceScript = path.join(repositoryRoot, "scripts", "render-cloudbase-config.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cloudbase-config-"));
  const project = path.join(root, "project");
  const workingDirectory = path.join(root, "unrelated-cwd");
  await mkdir(path.join(project, "scripts"), { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  await copyFile(sourceScript, path.join(project, "scripts", "render-cloudbase-config.mjs"));
  return { root, project, workingDirectory };
}

function runRenderer(project, workingDirectory, environment = {}) {
  return spawnSync(
    process.execPath,
    [path.join(project, "scripts", "render-cloudbase-config.mjs")],
    {
      cwd: workingDirectory,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...environment,
      },
    },
  );
}

test("atomically replaces only the root config and supports repeat rendering", async (t) => {
  const { root, project, workingDirectory } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const unrelatedConfig = path.join(workingDirectory, "cloudbaserc.json");
  await writeFile(unrelatedConfig, "do-not-overwrite\n", "utf8");
  await writeFile(
    path.join(project, "cloudbaserc.json"),
    '{"envId":"previous-test-environment"}\n',
    "utf8",
  );

  const result = runRenderer(project, workingDirectory, {
    CLOUDBASE_ENV_ID: "booking-test-000001",
    CLOUDBASE_DEPLOYMENT_REVISION: "0123456789abcdef0123456789abcdef01234567",
    PHONE_HASH_SALT: "phone-secret-canary",
    TENCENTCLOUD_SECRET_ID: "credential-name-canary",
    TENCENTCLOUD_SECRET_KEY: "credential-value-canary",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(unrelatedConfig, "utf8"), "do-not-overwrite\n");
  const output = await readFile(path.join(project, "cloudbaserc.json"), "utf8");
  assert.deepEqual(JSON.parse(output), {
    $schema: "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
    envId: "booking-test-000001",
    functionRoot: "cloudbase/functions",
    functions: [
      {
        name: "booking-public-api",
        description: "deployment-revision:0123456789abcdef0123456789abcdef01234567",
        runtime: "Nodejs20.19",
        handler: "index.main",
        installDependency: true,
      },
      {
        name: "booking-admin-api",
        description: "deployment-revision:0123456789abcdef0123456789abcdef01234567",
        runtime: "Nodejs20.19",
        handler: "index.main",
        installDependency: true,
      },
      {
        name: "booking-mailer",
        description: "deployment-revision:0123456789abcdef0123456789abcdef01234567",
        runtime: "Nodejs20.19",
        handler: "index.main",
        installDependency: true,
        triggers: [
          {
            name: "booking-mailer-every-minute",
            type: "timer",
            config: "0 * * * * * *",
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(output, /envVariables|PHONE_HASH_SALT|TENCENTCLOUD_SECRET/i);
  assert.doesNotMatch(output, /phone-secret-canary|credential-(?:name|value)-canary/);

  const rerender = runRenderer(project, workingDirectory, {
    CLOUDBASE_ENV_ID: "opaque-production-identifier",
    CLOUDBASE_DEPLOYMENT_REVISION: "89abcdef0123456789abcdef0123456789abcdef",
  });
  assert.equal(rerender.status, 0, rerender.stderr);
  const rerendered = JSON.parse(
    await readFile(path.join(project, "cloudbaserc.json"), "utf8"),
  );
  assert.equal(rerendered.envId, "opaque-production-identifier");
  assert.ok(
    rerendered.functions.every(
      (entry) =>
        entry.description ===
        "deployment-revision:89abcdef0123456789abcdef0123456789abcdef",
    ),
  );
  assert.deepEqual((await readdir(project)).sort(), ["cloudbaserc.json", "scripts"]);
});

test("missing or malformed CloudBase identifiers fail closed without replacing existing config", async (t) => {
  const { root, project, workingDirectory } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(project, "cloudbaserc.json");
  await writeFile(target, "existing-config\n", "utf8");

  for (const environment of [
    {},
    { CLOUDBASE_ENV_ID: "booking-test-000001" },
    {
      CLOUDBASE_ENV_ID: "   ",
      CLOUDBASE_DEPLOYMENT_REVISION: "0123456789abcdef0123456789abcdef01234567",
    },
    {
      CLOUDBASE_ENV_ID: "ab",
      CLOUDBASE_DEPLOYMENT_REVISION: "0123456789abcdef0123456789abcdef01234567",
    },
    {
      CLOUDBASE_ENV_ID: "attacker.example/",
      CLOUDBASE_DEPLOYMENT_REVISION: "0123456789abcdef0123456789abcdef01234567",
    },
    {
      CLOUDBASE_ENV_ID: `booking-${"x".repeat(64)}`,
      CLOUDBASE_DEPLOYMENT_REVISION: "0123456789abcdef0123456789abcdef01234567",
    },
    {
      CLOUDBASE_ENV_ID: "booking-test-000001",
      CLOUDBASE_DEPLOYMENT_REVISION: "not-a-commit-sha",
    },
    {
      CLOUDBASE_ENV_ID: "booking-test-000001",
      CLOUDBASE_DEPLOYMENT_REVISION: "ABCDEF0123456789abcdef0123456789abcdef01",
    },
  ]) {
    const result = runRenderer(project, workingDirectory, environment);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(target, "utf8"), "existing-config\n");
    assert.doesNotMatch(result.stderr, /attacker|booking-x/);
  }
  assert.deepEqual((await readdir(project)).sort(), ["cloudbaserc.json", "scripts"]);
});

test("the generated root config is ignored by Git", () => {
  const result = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`,
      "check-ignore",
      "--quiet",
      "cloudbaserc.json",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
