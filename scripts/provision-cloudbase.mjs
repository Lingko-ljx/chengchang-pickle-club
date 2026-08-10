import path from "node:path";
import { pathToFileURL } from "node:url";

const collectionNames = [
  "courts",
  "session_templates",
  "sessions",
  "court_allocations",
  "bookings",
  "booking_codes",
  "audit_logs",
  "notification_outbox",
  "rate_limits",
  "idempotency",
  "system_state",
];

const indexDefinitions = [
  ["bookings", "bookings_sessionId_status", ["sessionId", "status"]],
  ["bookings", "bookings_date_createdAt_id", ["date", "createdAt", "id"]],
  ["bookings", "bookings_date_status_createdAt_id", ["date", "status", "createdAt", "id"]],
  ["bookings", "bookings_proposedDate_status_createdAt_id", ["proposedDate", "status", "createdAt", "id"]],
  ["bookings", "bookings_phoneHash_createdAt", ["phoneHash", "createdAt"]],
  [
    "bookings",
    "bookings_status_terminalAt_personalDataRedactedAt_id",
    ["status", "terminalAt", "personalDataRedactedAt", "id"],
  ],
  ["audit_logs", "audit_logs_bookingId_at_id", ["bookingId", "at", "id"]],
  ["sessions", "sessions_date_startAt", ["date", "startAt"]],
  [
    "notification_outbox",
    "notification_outbox_status_nextAttemptAt_id",
    ["status", "nextAttemptAt", "id"],
  ],
];

const courtSeeds = Array.from({ length: 11 }, (_, index) => {
  const id = String(index + 1).padStart(2, "0");
  return { collection: "courts", id, value: { id, enabled: true, version: 1 } };
});

const templateSeeds = Array.from({ length: 16 }, (_, index) => {
  const hour = index + 7;
  const nextHour = hour + 1;
  const startTime = `${String(hour).padStart(2, "0")}:00`;
  const endTime = `${String(nextHour).padStart(2, "0")}:00`;
  const id = `slot-${String(hour).padStart(2, "0")}00`;
  return {
    collection: "session_templates",
    id,
    value: { id, startTime, endTime, enabled: true, version: 1 },
  };
});

const seedDefinitions = [...courtSeeds, ...templateSeeds];
const databaseAclTags = new Set([
  "READONLY",
  "PRIVATE",
  "ADMINWRITE",
  "ADMINONLY",
  "CUSTOM",
]);

class ProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvisioningError";
  }
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new ProvisioningError(`Missing configuration: ${name}`);
  return value;
}

export function readProvisioningConfiguration(environment) {
  const stage = requiredEnvironment(environment, "CLOUDBASE_DEPLOYMENT_STAGE");
  if (stage !== "staging") {
    throw new ProvisioningError("Invalid configuration: CLOUDBASE_DEPLOYMENT_STAGE");
  }
  const envId = requiredEnvironment(environment, "CLOUDBASE_ENV_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(envId)) {
    throw new ProvisioningError("Invalid configuration: CLOUDBASE_ENV_ID");
  }
  return {
    stage,
    envId,
    secretId: requiredEnvironment(environment, "TENCENTCLOUD_SECRETID"),
    secretKey: requiredEnvironment(environment, "TENCENTCLOUD_SECRETKEY"),
  };
}

export function createProvisioningClients(
  configuration,
  dependencies,
) {
  const options = {
    envId: configuration.envId,
    secretId: configuration.secretId,
    secretKey: configuration.secretKey,
  };
  const manager = new dependencies.CloudBaseManager(options);
  const app = dependencies.cloudbase.init({
    env: configuration.envId,
    secretId: configuration.secretId,
    secretKey: configuration.secretKey,
  });
  return {
    managerApi: manager.commonService("tcb", "2018-06-08"),
    managerDatabase: manager.database,
    database: app.database(),
  };
}

async function listCollectionNames(managerDatabase) {
  const names = new Set();
  const limit = 100;
  let offset = 0;
  while (true) {
    const response = await managerDatabase.listCollections({
      MgoLimit: limit,
      MgoOffset: offset,
    });
    if (
      !response ||
      !Array.isArray(response.Collections) ||
      !response.Pager ||
      !Number.isSafeInteger(response.Pager.Total) ||
      response.Pager.Total < 0
    ) {
      throw new ProvisioningError("INVALID_MANAGER_RESPONSE: listCollections");
    }
    for (const collection of response.Collections) {
      if (!collection || typeof collection.CollectionName !== "string") {
        throw new ProvisioningError("INVALID_MANAGER_RESPONSE: listCollections");
      }
      names.add(collection.CollectionName);
    }
    offset += response.Collections.length;
    if (offset >= response.Pager.Total) break;
    if (response.Collections.length === 0) {
      throw new ProvisioningError("INVALID_MANAGER_RESPONSE: listCollections");
    }
  }
  return names;
}

function createIndexDefinition(name, fields) {
  return {
    IndexName: name,
    MgoKeySchema: {
      MgoIndexKeys: fields.map((Name) => ({ Name, Direction: "1" })),
      MgoIsUnique: false,
    },
  };
}

function hasExactIndex(existing, fields) {
  return (
    existing.Unique === false &&
    hasExactIndexKeys(existing, fields)
  );
}

function hasExactIndexKeys(existing, fields) {
  return (
    Array.isArray(existing.Keys) &&
    existing.Keys.length === fields.length &&
    existing.Keys.every(
      (key, index) =>
        key?.Name === fields[index] && key?.Direction === "1",
    )
  );
}

async function preflightIndexes(managerDatabase, existingCollections) {
  const missingByCollection = new Map();
  for (const collectionName of new Set(indexDefinitions.map(([name]) => name))) {
    let indexes = [];
    if (existingCollections.has(collectionName)) {
      const response = await managerDatabase.describeCollection(collectionName);
      if (!response || !Array.isArray(response.Indexes)) {
        throw new ProvisioningError(
          `INVALID_MANAGER_RESPONSE: describeCollection/${collectionName}`,
        );
      }
      indexes = response.Indexes;
    }
    for (const [, indexName, fields] of indexDefinitions.filter(
      ([name]) => name === collectionName,
    )) {
      if (
        indexes.some(
          (index) =>
            index?.Name !== indexName && hasExactIndexKeys(index, fields),
        )
      ) {
        throw new ProvisioningError(`INDEX_DRIFT: ${collectionName}/${indexName}`);
      }
      const existing = indexes.find((index) => index?.Name === indexName);
      if (!existing) {
        const missing = missingByCollection.get(collectionName) ?? [];
        missing.push(createIndexDefinition(indexName, fields));
        missingByCollection.set(collectionName, missing);
      } else if (!hasExactIndex(existing, fields)) {
        throw new ProvisioningError(`INDEX_DRIFT: ${collectionName}/${indexName}`);
      }
    }
  }
  return missingByCollection;
}

function hasValidOperationalFields(value) {
  return (
    typeof value.enabled === "boolean" &&
    Number.isSafeInteger(value.version) &&
    value.version >= 1
  );
}

function isExactSeed(existing, expected) {
  if (!hasValidOperationalFields(existing) || existing.id !== expected.id) return false;
  if ("startTime" in expected) {
    return (
      existing.startTime === expected.startTime &&
      existing.endTime === expected.endTime
    );
  }
  return true;
}

async function preflightSeeds(database, existingCollections) {
  const missing = [];
  for (const seed of seedDefinitions) {
    if (!existingCollections.has(seed.collection)) {
      missing.push(seed);
      continue;
    }
    const response = await database.collection(seed.collection).doc(seed.id).get();
    if (!response || !Array.isArray(response.data) || response.data.length > 1) {
      throw new ProvisioningError(
        `INVALID_DATABASE_RESPONSE: ${seed.collection}/${seed.id}`,
      );
    }
    if (response.data.length === 0) {
      missing.push(seed);
    } else if (!isExactSeed(response.data[0], seed.value)) {
      throw new ProvisioningError(`SEED_DRIFT: ${seed.collection}/${seed.id}`);
    }
  }
  return missing;
}

async function describeDatabaseAcl(managerApi, envId, collectionName) {
  const response = await managerApi.call({
    Action: "DescribeDatabaseACL",
    Param: { EnvId: envId, CollectionName: collectionName },
  });
  if (
    !response ||
    typeof response.RequestId !== "string" ||
    response.RequestId.length === 0 ||
    !databaseAclTags.has(response.AclTag)
  ) {
    throw new ProvisioningError(
      `INVALID_MANAGER_RESPONSE: DescribeDatabaseACL/${collectionName}`,
    );
  }
  return response.AclTag;
}

async function preflightDatabaseAcls(managerApi, envId, collections) {
  const drifted = [];
  for (const collectionName of collections) {
    const aclTag = await describeDatabaseAcl(managerApi, envId, collectionName);
    if (aclTag !== "ADMINONLY") drifted.push(collectionName);
  }
  return drifted;
}

async function hardenDatabaseAcl(managerApi, envId, collectionName) {
  const response = await managerApi.call({
    Action: "ModifyDatabaseACL",
    Param: {
      EnvId: envId,
      CollectionName: collectionName,
      AclTag: "ADMINONLY",
    },
  });
  if (
    !response ||
    typeof response.RequestId !== "string" ||
    response.RequestId.length === 0
  ) {
    throw new ProvisioningError(
      `INVALID_MANAGER_RESPONSE: ModifyDatabaseACL/${collectionName}`,
    );
  }
}

async function hasProvisionedPostconditions(
  managerApi,
  envId,
  managerDatabase,
  database,
) {
  const collections = await listCollectionNames(managerDatabase);
  if (collectionNames.some((name) => !collections.has(name))) return false;

  for (const collectionName of collectionNames) {
    const aclTag = await describeDatabaseAcl(managerApi, envId, collectionName);
    if (aclTag !== "ADMINONLY") return false;
  }

  for (const collectionName of new Set(indexDefinitions.map(([name]) => name))) {
    const response = await managerDatabase.describeCollection(collectionName);
    if (!response || !Array.isArray(response.Indexes)) {
      throw new ProvisioningError(
        `INVALID_MANAGER_RESPONSE: describeCollection/${collectionName}`,
      );
    }
    for (const [, indexName, fields] of indexDefinitions.filter(
      ([name]) => name === collectionName,
    )) {
      if (
        response.Indexes.some(
          (index) =>
            index?.Name !== indexName && hasExactIndexKeys(index, fields),
        )
      ) {
        throw new ProvisioningError(`INDEX_DRIFT: ${collectionName}/${indexName}`);
      }
      const existing = response.Indexes.find((index) => index?.Name === indexName);
      if (!existing) return false;
      if (!hasExactIndex(existing, fields)) {
        throw new ProvisioningError(`INDEX_DRIFT: ${collectionName}/${indexName}`);
      }
    }
  }

  for (const seed of seedDefinitions) {
    const response = await database.collection(seed.collection).doc(seed.id).get();
    if (!response || !Array.isArray(response.data) || response.data.length > 1) {
      throw new ProvisioningError(
        `INVALID_DATABASE_RESPONSE: ${seed.collection}/${seed.id}`,
      );
    }
    if (response.data.length === 0) return false;
    if (!isExactSeed(response.data[0], seed.value)) {
      throw new ProvisioningError(`SEED_DRIFT: ${seed.collection}/${seed.id}`);
    }
  }
  return true;
}

const waitFor = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function verifyPostconditions(
  managerApi,
  envId,
  managerDatabase,
  database,
  verification = {},
) {
  const attempts = verification.attempts ?? 60;
  const delayMs = verification.delayMs ?? 5_000;
  const wait = verification.wait ?? waitFor;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || delayMs < 0) {
    throw new ProvisioningError("INVALID_VERIFICATION_CONFIGURATION");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (
      await hasProvisionedPostconditions(
        managerApi,
        envId,
        managerDatabase,
        database,
      )
    ) return;
    if (attempt < attempts) await wait(delayMs);
  }
  throw new ProvisioningError("POSTCONDITION_NOT_MET");
}

export async function provisionCloudbase({
  envId,
  managerApi,
  managerDatabase,
  database,
  verification,
}) {
  if (
    typeof envId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{2,63}$/i.test(envId) ||
    typeof managerApi?.call !== "function" ||
    typeof managerDatabase?.listCollections !== "function" ||
    typeof database?.collection !== "function"
  ) {
    throw new ProvisioningError("INVALID_PROVISIONING_CONFIGURATION");
  }
  const existingCollections = await listCollectionNames(managerDatabase);
  const missingIndexes = await preflightIndexes(managerDatabase, existingCollections);
  const missingSeeds = await preflightSeeds(database, existingCollections);
  const missingCollections = collectionNames.filter(
    (name) => !existingCollections.has(name),
  );

  const existingCollectionAcls = await preflightDatabaseAcls(
    managerApi,
    envId,
    collectionNames.filter((name) => existingCollections.has(name)),
  );
  let updatedCollectionAcls = 0;
  for (const name of existingCollectionAcls) {
    await hardenDatabaseAcl(managerApi, envId, name);
    updatedCollectionAcls += 1;
  }
  for (const name of missingCollections) {
    await managerDatabase.createCollection(name);
    const aclTag = await describeDatabaseAcl(managerApi, envId, name);
    if (aclTag !== "ADMINONLY") {
      await hardenDatabaseAcl(managerApi, envId, name);
      updatedCollectionAcls += 1;
    }
  }
  for (const [name, indexes] of missingIndexes) {
    if (indexes.length > 0) {
      await managerDatabase.updateCollection(name, { CreateIndexes: indexes });
    }
  }
  for (const seed of missingSeeds) {
    await database.collection(seed.collection).doc(seed.id).set(seed.value);
  }

  await verifyPostconditions(
    managerApi,
    envId,
    managerDatabase,
    database,
    verification,
  );

  return {
    createdCollections: missingCollections.length,
    updatedCollectionAcls,
    createdIndexes: [...missingIndexes.values()].reduce(
      (total, indexes) => total + indexes.length,
      0,
    ),
    createdSeeds: missingSeeds.length,
  };
}

export async function provisionFromEnvironment(
  environment = process.env,
  dependencies,
) {
  const configuration = readProvisioningConfiguration(environment);
  const resolvedDependencies = dependencies ?? await loadDependencies();
  return provisionCloudbase({
    envId: configuration.envId,
    ...createProvisioningClients(configuration, resolvedDependencies),
  });
}

export function formatProvisioningError(error) {
  return error instanceof ProvisioningError
    ? error.message
    : "CloudBase provisioning failed";
}

async function loadDependencies() {
  const [managerModule, nodeSdkModule] = await Promise.all([
    import("@cloudbase/manager-node"),
    import("@cloudbase/node-sdk"),
  ]);
  return {
    CloudBaseManager: managerModule.default,
    cloudbase: nodeSdkModule.default,
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    await provisionFromEnvironment();
  } catch (error) {
    console.error(formatProvisioningError(error));
    process.exitCode = 1;
  }
}
