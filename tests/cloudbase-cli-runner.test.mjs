import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCloudBaseCli } from "../scripts/run-cloudbase-cli.mjs";

const secretId = "secret-id-runner-canary";
const secretKey = "secret-key-runner-canary";

function environment() {
  return {
    PATH: process.env.PATH ?? "",
    TENCENTCLOUD_SECRETID: secretId,
    TENCENTCLOUD_SECRETKEY: secretKey,
  };
}

test("CLI runner exposes credentials only through a temporary 0600 auth store", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudbase-cli-runner-"));
  const authFilePath = path.join(directory, ".cloudbase", "auth.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  let childObserved = false;
  const exitCode = await runCloudBaseCli({
    args: ["-e", "booking-staging-test", "fn", "list"],
    authFilePath,
    environment: environment(),
    executablePath: "/repo/node_modules/.bin/tcb",
    spawnProcess: async (executable, args, options) => {
      childObserved = true;
      assert.equal(executable, "/repo/node_modules/.bin/tcb");
      assert.deepEqual(args, ["-e", "booking-staging-test", "fn", "list"]);
      assert.equal(options.stdio, "inherit");
      assert.equal(options.shell, false);
      assert.equal(options.env.TENCENTCLOUD_SECRETID, undefined);
      assert.equal(options.env.TENCENTCLOUD_SECRETKEY, undefined);
      assert.doesNotMatch(JSON.stringify(args), /runner-canary/);

      const auth = JSON.parse(await readFile(authFilePath, "utf8"));
      assert.deepEqual(auth, {
        credential: { secretId, secretKey },
      });
      if (process.platform !== "win32") {
        assert.equal((await stat(authFilePath)).mode & 0o777, 0o600);
      }
      return { code: 0, signal: null };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(childObserved, true);
  await assert.rejects(access(authFilePath));
});

test("CLI runner removes its auth store after a failed child command", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudbase-cli-runner-"));
  const authFilePath = path.join(directory, ".cloudbase", "auth.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const exitCode = await runCloudBaseCli({
    args: ["fn", "deploy", "--all"],
    authFilePath,
    environment: environment(),
    executablePath: "/repo/node_modules/.bin/tcb",
    spawnProcess: async () => ({ code: 23, signal: null }),
  });

  assert.equal(exitCode, 23);
  await assert.rejects(access(authFilePath));
});

test("CLI runner refuses to overwrite an existing credential store", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudbase-cli-runner-"));
  const authFilePath = path.join(directory, "auth.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(authFilePath, '{"credential":{"sentinel":true}}', "utf8");

  let spawned = false;
  await assert.rejects(
    runCloudBaseCli({
      args: ["fn", "list"],
      authFilePath,
      environment: environment(),
      executablePath: "/repo/node_modules/.bin/tcb",
      spawnProcess: async () => {
        spawned = true;
        return { code: 0, signal: null };
      },
    }),
    /CloudBase CLI credential store already exists/,
  );

  assert.equal(spawned, false);
  assert.equal(
    await readFile(authFilePath, "utf8"),
    '{"credential":{"sentinel":true}}',
  );
});

test("CLI runner fails closed when either mapped GitHub secret is absent", async () => {
  for (const missing of ["TENCENTCLOUD_SECRETID", "TENCENTCLOUD_SECRETKEY"]) {
    const env = environment();
    delete env[missing];
    await assert.rejects(
      runCloudBaseCli({
        args: ["fn", "list"],
        authFilePath: path.join(os.tmpdir(), `unused-${missing}.json`),
        environment: env,
        executablePath: "/repo/node_modules/.bin/tcb",
        spawnProcess: async () => ({ code: 0, signal: null }),
      }),
      new RegExp(`Missing CloudBase CLI credential: ${missing}`),
    );
  }
});
