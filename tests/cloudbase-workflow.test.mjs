import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function workflow() {
  const source = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "cloudbase.yml"),
    "utf8",
  );
  return { source, value: parse(source) };
}

function namedStep(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing workflow step: ${name}`);
  return step;
}

test("CloudBase deployment is manual, staging-gated, and serialized by explicit env ID", async () => {
  const { value } = await workflow();
  assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]);
  assert.equal(
    value.on.workflow_dispatch.inputs.confirm_environment_id.required,
    true,
  );
  assert.equal(value.on.workflow_dispatch.inputs.confirm_environment_id.type, "string");
  assert.equal(value.concurrency.group, "cloudbase-${{ vars.CLOUDBASE_ENV_ID }}");
  assert.equal(value.concurrency["cancel-in-progress"], false);
  assert.equal(value.jobs.deploy.environment, "cloudbase-staging");
  assert.deepEqual(value.jobs.deploy.env, {
    BOOKING_API_BASE_URL: "${{ vars.BOOKING_API_BASE_URL }}",
    CLOUDBASE_DEPLOYMENT_REVISION: "${{ github.sha }}",
    CLOUDBASE_DEPLOYMENT_STAGE: "${{ vars.CLOUDBASE_DEPLOYMENT_STAGE }}",
    CLOUDBASE_ENV_ID: "${{ vars.CLOUDBASE_ENV_ID }}",
    CLOUDBASE_SITE_URL: "${{ vars.CLOUDBASE_SITE_URL }}",
  });
});

test("preflight validates both repository variables, staging, confirmation, and both secrets", async () => {
  const { source, value } = await workflow();
  const step = namedStep(value.jobs.deploy.steps, "Validate staging deployment gate");
  assert.deepEqual(step.env, {
    CONFIRMED_CLOUDBASE_ENV_ID: "${{ inputs.confirm_environment_id }}",
    TENCENTCLOUD_SECRETID: "${{ secrets.TENCENTCLOUD_SECRET_ID }}",
    TENCENTCLOUD_SECRETKEY: "${{ secrets.TENCENTCLOUD_SECRET_KEY }}",
  });
  for (const name of [
    "BOOKING_API_BASE_URL",
    "CLOUDBASE_DEPLOYMENT_STAGE",
    "CLOUDBASE_ENV_ID",
    "CLOUDBASE_SITE_URL",
    "CONFIRMED_CLOUDBASE_ENV_ID",
    "TENCENTCLOUD_SECRETID",
    "TENCENTCLOUD_SECRETKEY",
  ]) {
    assert.match(step.run, new RegExp(`\\$\\{${name}(?::-[^}]*)?\\}`), name);
  }
  assert.match(step.run, /CLOUDBASE_DEPLOYMENT_STAGE[^\n]*staging/);
  assert.match(step.run, /CONFIRMED_CLOUDBASE_ENV_ID[^\n]*CLOUDBASE_ENV_ID/);
  assert.doesNotMatch(source, /\becho\b/);
  assert.doesNotMatch(source, /TENCENTCLOUD_SECRET_(?:ID|KEY):\s*(?!\$\{\{)/);
  assert.doesNotMatch(source, /BOOKING_SES_SECRET_(?:ID|KEY)/);
  assert.doesNotMatch(source, /BOOKING_ADMIN_USER_IDS/);
  assert.match(step.run, /verify-cloudbase-hosting\.mjs --check-config/);
});

test("workflow tests and lints before rendering, provisioning, or deployment", async () => {
  const { source, value } = await workflow();
  const steps = value.jobs.deploy.steps;
  const commands = steps
    .filter((step) => typeof step.run === "string")
    .map((step) => [step.name, step.run]);
  assert.deepEqual(commands.slice(1, 12), [
    ["Install locked dependencies", "npm ci"],
    ["Run configured unit suite", "npm test"],
    ["Lint source before deployment", "npm run lint"],
    ["Build CloudBase functions", "npm run build:cloudbase"],
    ["Build root CloudBase static site", "npm run build:pages"],
    ["Verify root CloudBase static export", "npm run test:pages"],
    ["Render secret-free CloudBase config", "npm run render:cloudbase"],
    ["Provision additive database resources", "npm run provision:cloudbase"],
    [
      "Ensure CloudBase storage upload CORS",
      "node scripts/ensure-cloudbase-storage-cors.mjs",
    ],
    [
      "Deploy all CloudBase functions",
      'node scripts/run-cloudbase-cli.mjs -- -e "$CLOUDBASE_ENV_ID" --yes fn deploy --all',
    ],
    [
      "Backfill and verify booking v2 daily inventory",
      "set -euo pipefail\nnode scripts/migrate-booking-inventory-v2.mjs --apply\nnode scripts/verify-booking-inventory-v2.mjs\n",
    ],
  ]);

  const unit = namedStep(steps, "Run configured unit suite");
  assert.deepEqual(unit.env, {
    GITHUB_PAGES: "false",
    NEXT_PUBLIC_BOOKING_API_BASE_URL: "${{ env.BOOKING_API_BASE_URL }}",
    NEXT_PUBLIC_CLOUDBASE_ENV_ID: "${{ env.CLOUDBASE_ENV_ID }}",
  });

  const rootBuild = namedStep(steps, "Build root CloudBase static site");
  const rootVerify = namedStep(steps, "Verify root CloudBase static export");
  const expectedStaticEnvironment = {
    GITHUB_PAGES: "true",
    PAGES_BASE_PATH: "/",
    NEXT_PUBLIC_SITE_URL: "${{ env.CLOUDBASE_SITE_URL }}",
    NEXT_PUBLIC_BOOKING_API_BASE_URL: "${{ env.BOOKING_API_BASE_URL }}",
    NEXT_PUBLIC_CLOUDBASE_ENV_ID: "${{ env.CLOUDBASE_ENV_ID }}",
  };
  assert.deepEqual(rootBuild.env, expectedStaticEnvironment);
  assert.deepEqual(rootVerify.env, expectedStaticEnvironment);

  const provision = namedStep(steps, "Provision additive database resources");
  const storageCors = namedStep(steps, "Ensure CloudBase storage upload CORS");
  const migrate = namedStep(steps, "Backfill and verify booking v2 daily inventory");
  const deploy = namedStep(steps, "Deploy all CloudBase functions");
  const deployStatic = namedStep(steps, "Deploy root CloudBase static site");
  const smokeApi = namedStep(steps, "Verify deployed public booking API");
  const smokeStatic = namedStep(steps, "Verify deployed root static site");
  const verify = namedStep(steps, "Verify deployed function configuration and mailer timer");
  for (const step of [
    provision,
    storageCors,
    migrate,
    deploy,
    deployStatic,
    verify,
  ]) {
    assert.deepEqual(step.env, {
      TENCENTCLOUD_SECRETID: "${{ secrets.TENCENTCLOUD_SECRET_ID }}",
      TENCENTCLOUD_SECRETKEY: "${{ secrets.TENCENTCLOUD_SECRET_KEY }}",
    });
  }
  assert.equal(
    deployStatic.run,
    'node scripts/run-cloudbase-cli.mjs -- -e "$CLOUDBASE_ENV_ID" --yes hosting deploy out',
  );
  assert.equal(
    smokeApi.run,
    "node scripts/verify-cloudbase-hosting.mjs --api-smoke",
  );
  assert.equal(
    smokeStatic.run,
    "node scripts/verify-cloudbase-hosting.mjs --smoke",
  );
  assert.ok(steps.indexOf(deploy) < steps.indexOf(verify));
  assert.ok(steps.indexOf(provision) < steps.indexOf(storageCors));
  assert.ok(steps.indexOf(storageCors) < steps.indexOf(deploy));
  assert.ok(steps.indexOf(storageCors) < steps.indexOf(deployStatic));
  assert.equal(storageCors.run, "node scripts/ensure-cloudbase-storage-cors.mjs");
  assert.ok(steps.indexOf(deploy) < steps.indexOf(migrate));
  assert.ok(steps.indexOf(migrate) < steps.indexOf(verify));
  assert.match(migrate.run, /migrate-booking-inventory-v2\.mjs --apply/);
  assert.match(migrate.run, /verify-booking-inventory-v2\.mjs/);
  assert.ok(steps.indexOf(verify) < steps.indexOf(smokeApi));
  assert.ok(steps.indexOf(smokeApi) < steps.indexOf(deployStatic));
  assert.ok(steps.indexOf(deployStatic) < steps.indexOf(smokeStatic));
  assert.doesNotMatch(source, /hosting delete|hosting destroy/i);
  assert.match(verify.run, /booking-public-api booking-admin-api booking-mailer/);
  assert.match(
    verify.run,
    /run-cloudbase-cli\.mjs -- -e "\$CLOUDBASE_ENV_ID" --yes fn detail "\$function_name" --json > "\$details_dir\/\$function_name\.json"/,
  );
  assert.doesNotMatch(source, /\bnpx tcb\b/);
  assert.match(
    verify.run,
    /node scripts\/verify-cloudbase-deployment\.mjs "\$details_dir" "\$CLOUDBASE_DEPLOYMENT_REVISION"/,
  );
  assert.match(verify.run, /seq 1 30/);
  assert.match(verify.run, /sleep 10/);
  assert.match(verify.run, /umask 077/);
  assert.match(
    verify.run,
    /rm -rf "\$\{RUNNER_TEMP:\?\}\/cloudbase-function-details"/,
  );
  const cleanup = namedStep(steps, "Remove function detail files");
  assert.match(cleanup.run, /set -eu/);
  assert.match(
    cleanup.run,
    /rm -rf "\$\{RUNNER_TEMP:\?\}\/cloudbase-function-details"/,
  );
  assert.ok(steps.indexOf(verify) > steps.indexOf(deploy));
  for (const externalWrite of [
    "Render secret-free CloudBase config",
    "Provision additive database resources",
    "Ensure CloudBase storage upload CORS",
    "Backfill and verify booking v2 daily inventory",
    "Deploy all CloudBase functions",
  ]) {
    assert.ok(steps.indexOf(unit) < steps.indexOf(namedStep(steps, externalWrite)));
    assert.ok(
      steps.indexOf(namedStep(steps, "Lint source before deployment")) <
        steps.indexOf(namedStep(steps, externalWrite)),
    );
  }
});

test("CloudBase runtime and provisioning packages are exact supported versions", async () => {
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(rootManifest.dependencies["@cloudbase/node-sdk"], "3.18.3");
  assert.equal(rootManifest.devDependencies["@cloudbase/cli"], "3.7.0");
  assert.equal(rootManifest.devDependencies["@cloudbase/manager-node"], "5.6.6");
  assert.equal(
    rootManifest.scripts["render:cloudbase"],
    "node scripts/render-cloudbase-config.mjs",
  );
  assert.equal(
    rootManifest.scripts["provision:cloudbase"],
    "node scripts/provision-cloudbase.mjs",
  );
  assert.match(
    rootManifest.scripts.lint,
    /--ignore-pattern cloudbase\/functions\/\*\/index\.js/,
  );
  for (const name of ["booking-public-api", "booking-admin-api"]) {
    const manifest = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "cloudbase", "functions", name, "package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.dependencies["@cloudbase/node-sdk"], "3.18.3");
  }
});

const environmentKeys = {
  "booking-public-api": [
    "PUBLIC_ALLOWED_ORIGINS",
    "PUBLIC_RESULT_URL",
    "DATA_TIMEZONE",
    "RATE_LIMIT_SALT",
    "PHONE_HASH_SALT",
    "IDEMPOTENCY_SALT",
  ],
  "booking-admin-api": [
    "CLOUDBASE_ENV_ID",
    "DATA_TIMEZONE",
    "BOOKING_ADMIN_USER_IDS",
  ],
  "booking-mailer": [
    "BOOKING_SES_SECRET_ID",
    "BOOKING_SES_SECRET_KEY",
    "SES_REGION",
    "SES_FROM_EMAIL",
    "SES_TEMPLATE_ID",
    "SES_REPLY_TO",
    "STAFF_NOTIFICATION_EMAIL",
  ],
};

function detail(name, triggers = [], keys = environmentKeys[name]) {
  return {
    Namespace: "booking-test-000001",
    FunctionName: name,
    Description: "deployment-revision:0123456789abcdef0123456789abcdef01234567",
    Status: "Active",
    CodeSize: 1234,
    Environment: {
      Variables: keys.map((Key) => ({ Key, Value: `never-print-${Key}` })),
    },
    Handler: "index.main",
    MemorySize: 256,
    Runtime: "Nodejs20.19",
    Timeout: 3,
    VpcConfig: {},
    Triggers: triggers,
    ModTime: "2026-08-09 12:00:00",
    InstallDependency: "TRUE",
    RequestId: "request-id",
  };
}

async function detailsFixture(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudbase-details-"));
  const values = {
    "booking-public-api": detail("booking-public-api"),
    "booking-admin-api": detail("booking-admin-api"),
    "booking-mailer": detail("booking-mailer", [
      {
        TriggerName: "booking-mailer-every-minute",
        Type: "timer",
        TriggerDesc: JSON.stringify({ cron: "0 * * * * * *" }),
      },
    ]),
    ...overrides,
  };
  await Promise.all(
    Object.entries(values).map(([name, value]) =>
      writeFile(
        path.join(directory, `${name}.json`),
        `${JSON.stringify({ data: value })}\n`,
        "utf8",
      ),
    ),
  );
  return directory;
}

function runVerifier(
  directory,
  revision = "0123456789abcdef0123456789abcdef01234567",
) {
  return spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts", "verify-cloudbase-deployment.mjs"),
      directory,
      revision,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
}

test("deployment verifier accepts exact function details without printing Environment", async (t) => {
  const directory = await detailsFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = runVerifier(directory);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CloudBase deployment configuration verified\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET_CANARY|never-print/);
});

test("deployment verifier enforces the free-tier three-second timeout", async (t) => {
  const directory = await detailsFixture({
    "booking-public-api": {
      ...detail("booking-public-api"),
      Timeout: 10,
    },
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = runVerifier(directory);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "CloudBase deployment verification failed\n");
});

test("deployment verifier keeps compatibility with the planned plain cron trigger description", async (t) => {
  const directory = await detailsFixture({
    "booking-mailer": detail("booking-mailer", [
      {
        TriggerName: "booking-mailer-every-minute",
        Type: "timer",
        TriggerDesc: "0 * * * * * *",
      },
    ]),
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = runVerifier(directory);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "CloudBase deployment configuration verified\n");
});

test("deployment verifier rejects malformed, extra, or incorrect mailer schedules", async (t) => {
  const invalidDescriptions = [
    JSON.stringify({ cron: "0 * * * * * *", timezone: "Asia/Shanghai" }),
    JSON.stringify({ cron: "0 */2 * * * * *" }),
    "0 */2 * * * * *",
    "{not-json}",
  ];
  const directories = await Promise.all(
    invalidDescriptions.map((TriggerDesc) =>
      detailsFixture({
        "booking-mailer": detail("booking-mailer", [
          {
            TriggerName: "booking-mailer-every-minute",
            Type: "timer",
            TriggerDesc,
          },
        ]),
      }),
    ),
  );
  t.after(() =>
    Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ),
  );

  for (const directory of directories) {
    const result = runVerifier(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "CloudBase deployment verification failed\n");
  }
});

test("deployment verifier fails closed when the exact mailer timer is absent", async (t) => {
  const directory = await detailsFixture({
    "booking-mailer": detail("booking-mailer", []),
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = runVerifier(directory);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "CloudBase deployment verification failed\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET_CANARY|never-print/);
});

test("deployment verifier rejects an old revision and malformed detail envelope", async (t) => {
  const staleDirectory = await detailsFixture({
    "booking-public-api": {
      ...detail("booking-public-api"),
      Description: "deployment-revision:89abcdef0123456789abcdef0123456789abcdef",
    },
  });
  const directDirectory = await detailsFixture();
  t.after(() => rm(staleDirectory, { recursive: true, force: true }));
  t.after(() => rm(directDirectory, { recursive: true, force: true }));
  await writeFile(
    path.join(directDirectory, "booking-admin-api.json"),
    `${JSON.stringify(detail("booking-admin-api"))}\n`,
    "utf8",
  );

  for (const directory of [staleDirectory, directDirectory]) {
    const result = runVerifier(directory);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "CloudBase deployment verification failed\n");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET_CANARY|never-print/);
  }
});

test("deployment verifier distinguishes retryable transitions from failed terminal states", async (t) => {
  const updatingDirectory = await detailsFixture({
    "booking-public-api": {
      ...detail("booking-public-api"),
      Status: "Updating",
    },
  });
  const failedDirectory = await detailsFixture({
    "booking-public-api": {
      ...detail("booking-public-api"),
      Status: "UpdateFailed",
    },
  });
  t.after(() => rm(updatingDirectory, { recursive: true, force: true }));
  t.after(() => rm(failedDirectory, { recursive: true, force: true }));

  const updating = runVerifier(updatingDirectory);
  assert.equal(updating.status, 2);
  assert.equal(updating.stdout, "");
  assert.equal(updating.stderr, "CloudBase functions are not active yet\n");

  const failed = runVerifier(failedDirectory);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.equal(failed.stderr, "CloudBase deployment verification failed\n");
});

test("deployment verifier requires each exact least-privilege runtime key set", async (t) => {
  const missingDirectory = await detailsFixture({
    "booking-public-api": detail(
      "booking-public-api",
      [],
      environmentKeys["booking-public-api"].slice(1),
    ),
  });
  const extraDirectory = await detailsFixture({
    "booking-admin-api": detail("booking-admin-api", [], [
      ...environmentKeys["booking-admin-api"],
      "PHONE_HASH_SALT",
    ]),
  });
  const missingAdminAllowlistDirectory = await detailsFixture({
    "booking-admin-api": detail(
      "booking-admin-api",
      [],
      environmentKeys["booking-admin-api"].slice(0, 2),
    ),
  });
  const reservedPrefixDirectory = await detailsFixture({
    "booking-mailer": detail("booking-mailer", [
      {
        TriggerName: "booking-mailer-every-minute",
        Type: "timer",
        TriggerDesc: "0 * * * * * *",
      },
    ], [
      "TENCENTCLOUD_SECRET_ID",
      "TENCENTCLOUD_SECRET_KEY",
      ...environmentKeys["booking-mailer"].slice(2),
    ]),
  });
  t.after(() => rm(missingDirectory, { recursive: true, force: true }));
  t.after(() => rm(extraDirectory, { recursive: true, force: true }));
  t.after(() =>
    rm(missingAdminAllowlistDirectory, { recursive: true, force: true }),
  );
  t.after(() => rm(reservedPrefixDirectory, { recursive: true, force: true }));

  for (const directory of [
    missingDirectory,
    extraDirectory,
    missingAdminAllowlistDirectory,
    reservedPrefixDirectory,
  ]) {
    const result = runVerifier(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "CloudBase deployment verification failed\n");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /PHONE_HASH_SALT|never-print/);
  }
});

test("runtime key verification never reads or prints environment values", () => {
  const verifierUrl = pathToFileURL(
    path.join(repositoryRoot, "scripts", "verify-cloudbase-deployment.mjs"),
  ).href;
  const probe = `
    import { hasExactRuntimeEnvironment } from ${JSON.stringify(verifierUrl)};
    const keys = ${JSON.stringify(environmentKeys["booking-mailer"])};
    const variables = keys.map((Key) => new Proxy({ Key }, {
      get(target, property, receiver) {
        if (property === "Value") throw new Error("ENVIRONMENT_VALUE_WAS_READ");
        return Reflect.get(target, property, receiver);
      },
    }));
    if (!hasExactRuntimeEnvironment({ Environment: { Variables: variables } }, "booking-mailer")) {
      process.exitCode = 1;
    }
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", probe],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /ENVIRONMENT_VALUE_WAS_READ|never-print/);
});
