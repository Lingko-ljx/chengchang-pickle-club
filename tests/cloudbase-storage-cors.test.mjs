import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureCloudBaseStorageCors,
  formatStorageCorsError,
  readStorageCorsConfiguration,
  ruleAllowsBrowserUpload,
} from "../scripts/ensure-cloudbase-storage-cors.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cloudBaseHostname =
  "pickle-staging-d0gqv3qzy9ba6b400-1465793178.tcloudbaseapp.com";
const githubHostname = "lingko-ljx.github.io";

function validEnvironment(overrides = {}) {
  return {
    CLOUDBASE_DEPLOYMENT_STAGE: "staging",
    CLOUDBASE_ENV_ID: "booking-test-000001",
    CLOUDBASE_SITE_URL: `https://${cloudBaseHostname}/`,
    TENCENTCLOUD_SECRETID: "secret-id-canary",
    TENCENTCLOUD_SECRETKEY: "secret-key-canary",
    ...overrides,
  };
}

function compliantRule(hostname, overrides = {}) {
  return {
    AllowedOrigins: [`http://${hostname}`, `https://${hostname}`],
    AllowedMethods: ["GET", "PUT", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["Etag", "Date"],
    MaxAgeSeconds: "5",
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

function adminOnlyStorage() {
  return {
    getStorageAcl: async () => "ADMINONLY",
    setStorageAcl: async () => assert.fail("ADMINONLY storage must not be rewritten"),
  };
}

test("configuration is staging-gated and derives exactly the two upload hostnames", () => {
  const accessed = [];
  const environment = new Proxy(validEnvironment(), {
    get(target, property, receiver) {
      if (typeof property === "string") accessed.push(property);
      return Reflect.get(target, property, receiver);
    },
  });

  assert.deepEqual(readStorageCorsConfiguration(environment), {
    stage: "staging",
    envId: "booking-test-000001",
    siteHostname: cloudBaseHostname,
    targetHostnames: [cloudBaseHostname, githubHostname],
    secretId: "secret-id-canary",
    secretKey: "secret-key-canary",
  });
  assert.deepEqual(accessed, [
    "CLOUDBASE_DEPLOYMENT_STAGE",
    "CLOUDBASE_ENV_ID",
    "CLOUDBASE_SITE_URL",
    "TENCENTCLOUD_SECRETID",
    "TENCENTCLOUD_SECRETKEY",
  ]);

  for (const invalid of [
    { CLOUDBASE_DEPLOYMENT_STAGE: "production" },
    { CLOUDBASE_ENV_ID: "attacker.example/" },
    { CLOUDBASE_SITE_URL: `http://${cloudBaseHostname}/` },
    { CLOUDBASE_SITE_URL: `https://user:pass@${cloudBaseHostname}/` },
    { CLOUDBASE_SITE_URL: "https://lingko-ljx.github.io/" },
    { TENCENTCLOUD_SECRETID: "" },
    { TENCENTCLOUD_SECRETKEY: "" },
  ]) {
    assert.throws(() => readStorageCorsConfiguration(validEnvironment(invalid)));
  }
});

test("upload rule validation accepts manager wildcard headers and both SDK field shapes", () => {
  assert.equal(ruleAllowsBrowserUpload(compliantRule(cloudBaseHostname), cloudBaseHostname), true);
  assert.equal(
    ruleAllowsBrowserUpload(
      {
        AllowedOrigin: [`https://${cloudBaseHostname}`],
        AllowedMethod: ["put"],
        AllowedHeader: [
          "authorization",
          "content-type",
          "x-cos-*",
          "key",
          "signature",
        ],
      },
      cloudBaseHostname,
    ),
    true,
  );

  for (const invalid of [
    compliantRule(cloudBaseHostname, { AllowedOrigins: [`http://${cloudBaseHostname}`] }),
    compliantRule(cloudBaseHostname, { AllowedMethods: ["GET", "POST"] }),
    compliantRule(cloudBaseHostname, {
      AllowedOrigins: ["*", `https://${cloudBaseHostname}`],
    }),
    compliantRule(cloudBaseHostname, {
      AllowedHeaders: ["Authorization", "Content-Type", "x-cos-*", "key"],
    }),
    compliantRule("unrelated.example", {}),
    null,
  ]) {
    assert.equal(ruleAllowsBrowserUpload(invalid, cloudBaseHostname), false);
  }
});

test("already compliant storage CORS is idempotent and performs no writes", async () => {
  const calls = [];
  const originalRules = [
    compliantRule("unrelated.example"),
    compliantRule(cloudBaseHostname),
    compliantRule(githubHostname),
  ];

  class FakeCloudBaseManager {
    constructor(options) {
      calls.push(["construct", clone(options)]);
      this.storage = adminOnlyStorage();
      this.env = {
        getCOSDomains: async () => {
          calls.push(["read"]);
          return clone(originalRules);
        },
        modifyCosCorsDomain: async (hostname) => {
          calls.push(["modify", hostname]);
        },
      };
    }
  }

  const result = await ensureCloudBaseStorageCors(
    readStorageCorsConfiguration(validEnvironment()),
    { CloudBaseManager: FakeCloudBaseManager },
  );

  assert.deepEqual(result, {
    storageAcl: "ADMINONLY",
    modifiedStorageAcl: false,
    targetHostnames: [cloudBaseHostname, githubHostname],
    modifiedHostnames: [],
  });
  assert.deepEqual(calls, [
    [
      "construct",
      {
        envId: "booking-test-000001",
        secretId: "secret-id-canary",
        secretKey: "secret-key-canary",
      },
    ],
    ["read"],
    ["read"],
  ]);
  assert.deepEqual(originalRules[0], compliantRule("unrelated.example"));
});

test("storage access is tightened to ADMINONLY and verified before upload CORS", async () => {
  const calls = [];
  let acl = "READONLY";
  class FakeCloudBaseManager {
    constructor() {
      this.storage = {
        getStorageAcl: async () => {
          calls.push(["acl-read", acl]);
          return acl;
        },
        setStorageAcl: async (value) => {
          calls.push(["acl-set", value]);
          acl = value;
        },
      };
      this.env = {
        getCOSDomains: async () => [
          compliantRule(cloudBaseHostname),
          compliantRule(githubHostname),
        ],
        modifyCosCorsDomain: async () => assert.fail("CORS must already be compliant"),
      };
    }
  }

  const result = await ensureCloudBaseStorageCors(
    readStorageCorsConfiguration(validEnvironment()),
    { CloudBaseManager: FakeCloudBaseManager },
  );

  assert.equal(result.storageAcl, "ADMINONLY");
  assert.equal(result.modifiedStorageAcl, true);
  assert.deepEqual(calls, [
    ["acl-read", "READONLY"],
    ["acl-set", "ADMINONLY"],
    ["acl-read", "ADMINONLY"],
  ]);
});

test("missing target rules are added sequentially, preserving unrelated rules, then verified", async () => {
  const calls = [];
  const rules = [
    compliantRule("unrelated.example"),
    compliantRule(cloudBaseHostname, { AllowedMethods: ["GET", "HEAD"] }),
  ];

  class FakeCloudBaseManager {
    constructor() {
      this.storage = adminOnlyStorage();
      this.env = {
        getCOSDomains: async () => {
          calls.push(["read", rules.length]);
          return clone(rules);
        },
        modifyCosCorsDomain: async (hostname) => {
          calls.push(["modify", hostname]);
          rules.push({
            AllowedOrigin: [`http://${hostname}`, `https://${hostname}`],
            AllowedMethod: ["GET", "POST", "PUT", "DELETE", "HEAD"],
            AllowedHeader: ["*"],
            ExposeHeader: ["Etag", "Date"],
            MaxAgeSeconds: "5",
          });
        },
      };
    }
  }

  const result = await ensureCloudBaseStorageCors(
    readStorageCorsConfiguration(validEnvironment()),
    { CloudBaseManager: FakeCloudBaseManager },
  );

  assert.deepEqual(result.modifiedHostnames, [cloudBaseHostname, githubHostname]);
  assert.deepEqual(calls, [
    ["read", 2],
    ["modify", cloudBaseHostname],
    ["read", 3],
    ["modify", githubHostname],
    ["read", 4],
    ["read", 4],
  ]);
  assert.deepEqual(rules[0], compliantRule("unrelated.example"));
});

test("post-condition and manager response failures fail closed", async () => {
  class NoOpCloudBaseManager {
    constructor() {
      this.storage = adminOnlyStorage();
      this.env = {
        getCOSDomains: async () => [],
        modifyCosCorsDomain: async () => undefined,
      };
    }
  }
  await assert.rejects(
    () =>
      ensureCloudBaseStorageCors(
        readStorageCorsConfiguration(validEnvironment()),
        { CloudBaseManager: NoOpCloudBaseManager },
      ),
    /post-condition/i,
  );

  class MalformedCloudBaseManager {
    constructor() {
      this.storage = adminOnlyStorage();
      this.env = {
        getCOSDomains: async () => ({ CORSRules: [] }),
        modifyCosCorsDomain: async () => undefined,
      };
    }
  }
  await assert.rejects(
    () =>
      ensureCloudBaseStorageCors(
        readStorageCorsConfiguration(validEnvironment()),
        { CloudBaseManager: MalformedCloudBaseManager },
      ),
    /manager response/i,
  );

  let mixedOriginRules = [
    {
      AllowedOrigins: [
        `https://${cloudBaseHostname}`,
        "https://must-be-preserved.example",
      ],
      AllowedMethods: ["GET"],
      AllowedHeaders: ["Content-Type"],
    },
  ];
  const destructivelyAdded = new Set();
  class DestructiveCloudBaseManager {
    constructor() {
      this.storage = adminOnlyStorage();
      this.env = {
        getCOSDomains: async () => clone(mixedOriginRules),
        modifyCosCorsDomain: async (hostname) => {
          destructivelyAdded.add(hostname);
          mixedOriginRules = [...destructivelyAdded].map((addedHostname) =>
            compliantRule(addedHostname),
          );
        },
      };
    }
  }
  await assert.rejects(
    () =>
      ensureCloudBaseStorageCors(
        readStorageCorsConfiguration(validEnvironment()),
        { CloudBaseManager: DestructiveCloudBaseManager },
      ),
    /preservation post-condition/i,
  );
});

test("CLI and error formatting never expose credentials or provider error details", () => {
  const secretId = "secret-id-must-never-print";
  const secretKey = "secret-key-must-never-print";
  assert.equal(
    formatStorageCorsError(new Error(`provider echoed ${secretId} ${secretKey}`)),
    "CloudBase storage CORS configuration failed",
  );

  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "ensure-cloudbase-storage-cors.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...validEnvironment({
          CLOUDBASE_DEPLOYMENT_STAGE: "production",
          TENCENTCLOUD_SECRETID: secretId,
          TENCENTCLOUD_SECRETKEY: secretKey,
        }),
      },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "CloudBase storage CORS configuration failed\n");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${secretId}|${secretKey}|provider`));
});
