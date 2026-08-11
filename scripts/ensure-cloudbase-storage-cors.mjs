import { pathToFileURL } from "node:url";

const GITHUB_PAGES_HOSTNAME = "lingko-ljx.github.io";
const REQUIRED_HEADERS = ["authorization", "content-type", "key", "signature"];
const REQUIRED_X_COS_HEADERS = [
  "x-cos-security-token",
  "x-cos-meta-fileid",
];

class StorageCorsError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageCorsError";
  }
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new StorageCorsError(`Missing configuration: ${name}`);
  return value;
}

function parseSiteHostname(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new StorageCorsError("Invalid configuration: CLOUDBASE_SITE_URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hostname === "" ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
      parsed.hostname,
    )
  ) {
    throw new StorageCorsError("Invalid configuration: CLOUDBASE_SITE_URL");
  }
  return parsed.hostname.toLowerCase();
}

export function readStorageCorsConfiguration(environment) {
  const stage = requiredEnvironment(environment, "CLOUDBASE_DEPLOYMENT_STAGE");
  if (stage !== "staging") {
    throw new StorageCorsError(
      "Invalid configuration: CLOUDBASE_DEPLOYMENT_STAGE",
    );
  }
  const envId = requiredEnvironment(environment, "CLOUDBASE_ENV_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/iu.test(envId)) {
    throw new StorageCorsError("Invalid configuration: CLOUDBASE_ENV_ID");
  }
  const siteHostname = parseSiteHostname(
    requiredEnvironment(environment, "CLOUDBASE_SITE_URL"),
  );
  const secretId = requiredEnvironment(environment, "TENCENTCLOUD_SECRETID");
  const secretKey = requiredEnvironment(environment, "TENCENTCLOUD_SECRETKEY");
  if (siteHostname === GITHUB_PAGES_HOSTNAME) {
    throw new StorageCorsError("Invalid configuration: CLOUDBASE_SITE_URL");
  }
  return {
    stage,
    envId,
    siteHostname,
    targetHostnames: [siteHostname, GITHUB_PAGES_HOSTNAME],
    secretId,
    secretKey,
  };
}

function stringList(rule, pluralName, singularName) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  const value = rule[pluralName] ?? rule[singularName];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    return null;
  }
  return value.map((item) => item.trim());
}

function headerRuleAllowsUpload(headers) {
  const normalized = new Set(headers.map((header) => header.toLowerCase()));
  if (normalized.has("*")) return true;
  if (REQUIRED_HEADERS.some((header) => !normalized.has(header))) return false;
  return (
    normalized.has("x-cos-*") ||
    REQUIRED_X_COS_HEADERS.every((header) => normalized.has(header))
  );
}

export function ruleAllowsBrowserUpload(rule, hostname) {
  if (typeof hostname !== "string" || hostname === "") return false;
  const origins = stringList(rule, "AllowedOrigins", "AllowedOrigin");
  const methods = stringList(rule, "AllowedMethods", "AllowedMethod");
  const headers = stringList(rule, "AllowedHeaders", "AllowedHeader");
  if (!origins || !methods || !headers) return false;
  const allowedOrigins = new Set([
    `http://${hostname}`,
    `https://${hostname}`,
  ]);
  return (
    origins.includes(`https://${hostname}`) &&
    origins.every((origin) => allowedOrigins.has(origin)) &&
    methods.some((method) => method.toUpperCase() === "PUT") &&
    headerRuleAllowsUpload(headers)
  );
}

function assertRules(value) {
  if (!Array.isArray(value)) {
    throw new StorageCorsError("Invalid manager response: getCOSDomains");
  }
  return value;
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSerialize(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isManagerReplaceableTargetRule(rule, targetHostnames) {
  const origins = stringList(rule, "AllowedOrigins", "AllowedOrigin") ?? [];
  return targetHostnames.some(
    (hostname) =>
      origins.length === 2 &&
      origins[0] === `http://${hostname}` &&
      origins[1] === `https://${hostname}`,
  );
}

function assertUnrelatedRulesPreserved(originalRules, currentRules, targetHostnames) {
  const current = new Map();
  for (const rule of currentRules) {
    const fingerprint = stableSerialize(rule);
    current.set(fingerprint, (current.get(fingerprint) ?? 0) + 1);
  }
  for (const rule of originalRules) {
    if (isManagerReplaceableTargetRule(rule, targetHostnames)) continue;
    const fingerprint = stableSerialize(rule);
    const count = current.get(fingerprint) ?? 0;
    if (count < 1) {
      throw new StorageCorsError("Storage CORS preservation post-condition failed");
    }
    current.set(fingerprint, count - 1);
  }
}

function assertManagerEnvironment(manager) {
  const service = manager?.env;
  if (
    !service ||
    typeof service.getCOSDomains !== "function" ||
    typeof service.modifyCosCorsDomain !== "function"
  ) {
    throw new StorageCorsError("Invalid manager environment service");
  }
  return service;
}

function assertManagerStorage(manager) {
  const service = manager?.storage;
  if (
    !service ||
    typeof service.getStorageAcl !== "function" ||
    typeof service.setStorageAcl !== "function"
  ) {
    throw new StorageCorsError("Invalid manager storage service");
  }
  return service;
}

async function ensureAdminOnlyStorage(storage, sleep) {
  const initial = await storage.getStorageAcl();
  const modified = initial !== "ADMINONLY";
  if (modified) await storage.setStorageAcl("ADMINONLY");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await storage.getStorageAcl();
    if (current === "ADMINONLY") {
      return { storageAcl: current, modifiedStorageAcl: modified };
    }
    if (attempt < 5) await sleep(1_000);
  }
  throw new StorageCorsError("Storage ACL post-condition failed");
}

export async function ensureCloudBaseStorageCors(configuration, dependencies) {
  const manager = new dependencies.CloudBaseManager({
    envId: configuration.envId,
    secretId: configuration.secretId,
    secretKey: configuration.secretKey,
  });
  const storage = assertManagerStorage(manager);
  const service = assertManagerEnvironment(manager);
  const aclResult = await ensureAdminOnlyStorage(
    storage,
    dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  );
  let rules = assertRules(await service.getCOSDomains());
  const originalRules = rules;
  const modifiedHostnames = [];

  for (const hostname of configuration.targetHostnames) {
    if (rules.some((rule) => ruleAllowsBrowserUpload(rule, hostname))) continue;
    await service.modifyCosCorsDomain(hostname);
    modifiedHostnames.push(hostname);
    rules = assertRules(await service.getCOSDomains());
    if (!rules.some((rule) => ruleAllowsBrowserUpload(rule, hostname))) {
      throw new StorageCorsError(
        `Storage CORS post-condition failed for ${hostname}`,
      );
    }
  }

  rules = assertRules(await service.getCOSDomains());
  for (const hostname of configuration.targetHostnames) {
    if (!rules.some((rule) => ruleAllowsBrowserUpload(rule, hostname))) {
      throw new StorageCorsError(
        `Storage CORS post-condition failed for ${hostname}`,
      );
    }
  }
  assertUnrelatedRulesPreserved(
    originalRules,
    rules,
    configuration.targetHostnames,
  );

  return {
    ...aclResult,
    targetHostnames: [...configuration.targetHostnames],
    modifiedHostnames,
  };
}

export async function ensureStorageCorsFromEnvironment(
  environment = process.env,
  dependencies,
) {
  const configuration = readStorageCorsConfiguration(environment);
  const resolvedDependencies =
    dependencies ??
    (await import("@cloudbase/manager-node").then((module) => ({
      CloudBaseManager: module.default,
    })));
  return ensureCloudBaseStorageCors(
    configuration,
    resolvedDependencies,
  );
}

export function formatStorageCorsError() {
  return "CloudBase storage CORS configuration failed";
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  ensureStorageCorsFromEnvironment()
    .then(() => {
      process.stdout.write("CloudBase storage CORS verified\n");
    })
    .catch(() => {
      process.stderr.write(`${formatStorageCorsError()}\n`);
      process.exitCode = 1;
    });
}
