import assert from "node:assert/strict";
import test from "node:test";

import {
  createProvisioningClients,
  formatProvisioningError,
  provisionCloudbase,
  provisionFromEnvironment,
  readProvisioningConfiguration,
} from "../scripts/provision-cloudbase.mjs";

const TEST_ENV_ID = "booking-test-000001";

const COLLECTIONS = [
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
  "court_day_allocations",
];

const INDEXES = [
  ["bookings", "bookings_sessionId_status", ["sessionId", "status"]],
  ["bookings", "bookings_date_createdAt_id", ["date", "createdAt", "id"]],
  ["bookings", "bookings_date_status_createdAt_id", ["date", "status", "createdAt", "id"]],
  ["bookings", "bookings_date_mode_createdAt_id", ["date", "mode", "createdAt", "id"]],
  ["bookings", "bookings_date_status_mode_createdAt_id", ["date", "status", "mode", "createdAt", "id"]],
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
    "court_day_allocations",
    "court_day_allocations_date_courtId",
    ["date", "courtId"],
  ],
  [
    "notification_outbox",
    "notification_outbox_status_nextAttemptAt_id",
    ["status", "nextAttemptAt", "id"],
  ],
];

const TEMPLATES = [
  ["slot-0700", "07:00", "08:00"],
  ["slot-0800", "08:00", "09:00"],
  ["slot-0900", "09:00", "10:00"],
  ["slot-1000", "10:00", "11:00"],
  ["slot-1100", "11:00", "12:00"],
  ["slot-1200", "12:00", "13:00"],
  ["slot-1300", "13:00", "14:00"],
  ["slot-1400", "14:00", "15:00"],
  ["slot-1500", "15:00", "16:00"],
  ["slot-1600", "16:00", "17:00"],
  ["slot-1700", "17:00", "18:00"],
  ["slot-1800", "18:00", "19:00"],
  ["slot-1900", "19:00", "20:00"],
  ["slot-2000", "20:00", "21:00"],
  ["slot-2100", "21:00", "22:00"],
  ["slot-2200", "22:00", "23:00"],
];

function clone(value) {
  return structuredClone(value);
}

function indexInfo(name, fields, unique = false) {
  return {
    Name: name,
    Size: 0,
    Keys: fields.map((field) => ({ Name: field, Direction: "1" })),
    Accesses: { Ops: 0, Since: "2026-08-09T00:00:00.000Z" },
    Unique: unique,
  };
}

class FakeManagerApi {
  constructor(managerDatabase, aclTags = {}) {
    this.managerDatabase = managerDatabase;
    this.aclTags = new Map(Object.entries(aclTags));
    this.calls = { describe: [], modify: [] };
    this.failModifyAt = null;
    this.modifyAttempts = 0;
    this.deferModifications = false;
    this.pendingAclTags = new Map();
    this.invalidDescribeFor = null;
  }

  async call(options) {
    assert.deepEqual(Object.keys(options).sort(), ["Action", "Param"]);
    const { Action, Param } = options;
    assert.deepEqual(Object.keys(Param).sort(),
      Action === "ModifyDatabaseACL"
        ? ["AclTag", "CollectionName", "EnvId"]
        : ["CollectionName", "EnvId"]);
    assert.equal(Param.EnvId, TEST_ENV_ID);
    assert.equal(this.managerDatabase.collections.has(Param.CollectionName), true);

    if (Action === "DescribeDatabaseACL") {
      this.calls.describe.push(clone(options));
      if (Param.CollectionName === this.invalidDescribeFor) {
        return { RequestId: `describe-acl-${Param.CollectionName}` };
      }
      return {
        AclTag: this.aclTags.get(Param.CollectionName) ?? "READONLY",
        RequestId: `describe-acl-${Param.CollectionName}`,
      };
    }
    if (Action === "ModifyDatabaseACL") {
      this.calls.modify.push(clone(options));
      this.modifyAttempts += 1;
      assert.equal(Param.AclTag, "ADMINONLY");
      if (this.modifyAttempts === this.failModifyAt) {
        throw new Error(`simulated ACL failure: ${Param.CollectionName}`);
      }
      if (this.deferModifications) {
        this.pendingAclTags.set(Param.CollectionName, Param.AclTag);
      } else {
        this.aclTags.set(Param.CollectionName, Param.AclTag);
      }
      return { RequestId: `modify-acl-${Param.CollectionName}` };
    }
    assert.fail(`unexpected manager API action: ${Action}`);
  }

  resetCalls() {
    this.calls = { describe: [], modify: [] };
    this.modifyAttempts = 0;
  }

  revealModifications() {
    for (const [collectionName, aclTag] of this.pendingAclTags) {
      this.aclTags.set(collectionName, aclTag);
    }
    this.pendingAclTags.clear();
  }
}

class FakeManagerDatabase {
  constructor(collections = []) {
    this.collections = new Set(collections);
    this.indexes = new Map(
      collections.map((name) => [name, [indexInfo("_id_", ["_id"], true)]]),
    );
    this.calls = { create: [], describe: [], list: [], update: [] };
    this.managerApi = new FakeManagerApi(this);
  }

  async listCollections(options) {
    this.calls.list.push(clone(options));
    const all = [...this.collections];
    const page = all.slice(options.MgoOffset, options.MgoOffset + options.MgoLimit);
    return {
      RequestId: "list-request",
      Collections: page.map((CollectionName) => ({
        CollectionName,
        TableName: CollectionName,
        Count: 0,
        Size: 0,
        IndexCount: this.indexes.get(CollectionName)?.length ?? 0,
        IndexSize: 0,
      })),
      Pager: {
        Offset: options.MgoOffset,
        Limit: options.MgoLimit,
        Total: all.length,
      },
    };
  }

  async createCollection(name) {
    this.calls.create.push(name);
    assert.equal(this.collections.has(name), false, `duplicate collection create: ${name}`);
    this.collections.add(name);
    this.indexes.set(name, [indexInfo("_id_", ["_id"], true)]);
    return { RequestId: `create-${name}` };
  }

  async describeCollection(name) {
    this.calls.describe.push(name);
    assert.equal(this.collections.has(name), true, `unknown collection: ${name}`);
    const indexes = clone(this.indexes.get(name));
    return {
      RequestId: `describe-${name}`,
      Indexes: indexes,
      IndexNum: indexes.length,
    };
  }

  async updateCollection(name, options) {
    this.calls.update.push([name, clone(options)]);
    assert.deepEqual(Object.keys(options), ["CreateIndexes"]);
    for (const index of options.CreateIndexes) {
      assert.equal(
        this.indexes.get(name).some((candidate) => candidate.Name === index.IndexName),
        false,
        `duplicate index create: ${name}/${index.IndexName}`,
      );
      this.indexes.get(name).push(indexInfo(
        index.IndexName,
        index.MgoKeySchema.MgoIndexKeys.map(({ Name }) => Name),
        index.MgoKeySchema.MgoIsUnique,
      ));
    }
    return { RequestId: `update-${name}` };
  }

  resetCalls() {
    this.calls = { create: [], describe: [], list: [], update: [] };
    this.managerApi.resetCalls();
  }
}

function provisionForTest({ managerDatabase, database, verification }) {
  return provisionCloudbase({
    envId: TEST_ENV_ID,
    managerApi: managerDatabase.managerApi,
    managerDatabase,
    database,
    verification,
  });
}

class FakeDocumentDatabase {
  constructor({ persistSets = true } = {}) {
    this.values = new Map();
    this.calls = { get: [], set: [] };
    this.persistSets = persistSets;
  }

  collection(name) {
    return {
      doc: (id) => {
        const key = `${name}/${id}`;
        return {
          get: async () => {
            this.calls.get.push(key);
            return {
              data: this.values.has(key) ? [clone(this.values.get(key))] : [],
              requestId: `get-${name}-${id}`,
            };
          },
          set: async (value) => {
            this.calls.set.push([key, clone(value)]);
            if (this.persistSets) this.values.set(key, clone(value));
            return { requestId: `set-${name}-${id}` };
          },
        };
      },
    };
  }

  resetCalls() {
    this.calls = { get: [], set: [] };
  }
}

function expectedIndexCreate(name, fields) {
  return {
    IndexName: name,
    MgoKeySchema: {
      MgoIndexKeys: fields.map((Name) => ({ Name, Direction: "1" })),
      MgoIsUnique: false,
    },
  };
}

function expectedAclModify(collectionName) {
  return {
    Action: "ModifyDatabaseACL",
    Param: {
      EnvId: TEST_ENV_ID,
      CollectionName: collectionName,
      AclTag: "ADMINONLY",
    },
  };
}

function expectedAclDescribe(collectionName) {
  return {
    Action: "DescribeDatabaseACL",
    Param: { EnvId: TEST_ENV_ID, CollectionName: collectionName },
  };
}

test("creates booking v2 storage, policy, eleven courts, and preserves sixteen legacy templates", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();

  const result = await provisionForTest({ managerDatabase, database });

  assert.deepEqual(managerDatabase.calls.create, COLLECTIONS);
  assert.deepEqual([...managerDatabase.collections], COLLECTIONS);
  assert.deepEqual(
    managerDatabase.managerApi.calls.describe.slice(0, COLLECTIONS.length),
    COLLECTIONS.map(expectedAclDescribe),
  );
  assert.deepEqual(
    managerDatabase.managerApi.calls.modify,
    COLLECTIONS.map(expectedAclModify),
  );
  assert.deepEqual(
    COLLECTIONS.map((name) => managerDatabase.managerApi.aclTags.get(name)),
    COLLECTIONS.map(() => "ADMINONLY"),
  );
  assert.deepEqual(
    managerDatabase.calls.update.flatMap(([collection, options]) =>
      options.CreateIndexes.map((index) => [collection, index]),
    ),
    INDEXES.map(([collection, name, fields]) => [
      collection,
      expectedIndexCreate(name, fields),
    ]),
  );
  assert.deepEqual(
    database.calls.set,
    [
      ...Array.from({ length: 11 }, (_, index) => {
        const id = String(index + 1).padStart(2, "0");
        return [`courts/${id}`, { id, enabled: true, version: 1 }];
      }),
      ...TEMPLATES.map(([id, startTime, endTime]) => [
        `session_templates/${id}`,
        { id, startTime, endTime, enabled: true, version: 1 },
      ]),
      [
        "system_state/booking-policy-v2",
        {
          id: "booking-policy-v2",
          timezone: "Asia/Shanghai",
          openingTime: "09:00",
          closingTime: "22:00",
          startIntervalMinutes: 30,
          minimumDurationMinutes: 60,
          durationStepMinutes: 60,
          maximumDurationMinutes: 240,
          version: 1,
        },
      ],
    ],
  );
  assert.deepEqual(result, {
    createdCollections: 12,
    updatedCollectionAcls: 12,
    createdIndexes: 12,
    createdSeeds: 28,
  });
});

test("an exact rerun is a no-op and preserves existing enabled and version values", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();
  await provisionForTest({ managerDatabase, database });
  database.values.set("courts/03", { id: "03", enabled: false, version: 7 });
  database.values.set("session_templates/slot-1900", {
    id: "slot-1900",
    startTime: "19:00",
    endTime: "20:00",
    enabled: false,
    version: 12,
  });
  managerDatabase.resetCalls();
  database.resetCalls();

  const result = await provisionForTest({ managerDatabase, database });

  assert.deepEqual(managerDatabase.calls.create, []);
  assert.deepEqual(managerDatabase.calls.update, []);
  assert.deepEqual(managerDatabase.managerApi.calls.modify, []);
  assert.deepEqual(
    managerDatabase.managerApi.calls.describe.slice(0, COLLECTIONS.length),
    COLLECTIONS.map(expectedAclDescribe),
  );
  assert.deepEqual(database.calls.set, []);
  assert.deepEqual(database.values.get("courts/03"), {
    id: "03",
    enabled: false,
    version: 7,
  });
  assert.deepEqual(database.values.get("session_templates/slot-1900"), {
    id: "slot-1900",
    startTime: "19:00",
    endTime: "20:00",
    enabled: false,
    version: 12,
  });
  assert.deepEqual(result, {
    createdCollections: 0,
    updatedCollectionAcls: 0,
    createdIndexes: 0,
    createdSeeds: 0,
  });
});

test("an interrupted ACL hardening run resumes without rewriting completed collections", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();
  managerDatabase.managerApi.failModifyAt = 6;

  await assert.rejects(
    () => provisionForTest({ managerDatabase, database }),
    /simulated ACL failure: booking_codes/,
  );
  assert.deepEqual(
    COLLECTIONS.slice(0, 5).map(
      (name) => managerDatabase.managerApi.aclTags.get(name),
    ),
    COLLECTIONS.slice(0, 5).map(() => "ADMINONLY"),
  );
  assert.deepEqual([...managerDatabase.collections], COLLECTIONS.slice(0, 6));
  assert.deepEqual(managerDatabase.calls.update, []);
  assert.deepEqual(database.calls.set, []);

  managerDatabase.managerApi.failModifyAt = null;
  managerDatabase.resetCalls();
  database.resetCalls();
  const result = await provisionForTest({ managerDatabase, database });

  assert.deepEqual(
    managerDatabase.managerApi.calls.modify,
    COLLECTIONS.slice(5).map(expectedAclModify),
  );
  assert.deepEqual(result, {
    createdCollections: 6,
    updatedCollectionAcls: 7,
    createdIndexes: 12,
    createdSeeds: 28,
  });
});

test("an invalid ACL preflight response fails closed before any ACL or data write", async () => {
  const managerDatabase = new FakeManagerDatabase(COLLECTIONS);
  const database = new FakeDocumentDatabase();
  managerDatabase.managerApi.invalidDescribeFor = "courts";

  await assert.rejects(
    () => provisionForTest({ managerDatabase, database }),
    /INVALID_MANAGER_RESPONSE: DescribeDatabaseACL\/courts/,
  );
  assert.deepEqual(managerDatabase.calls.create, []);
  assert.deepEqual(managerDatabase.calls.update, []);
  assert.deepEqual(managerDatabase.managerApi.calls.modify, []);
  assert.deepEqual(database.calls.set, []);
});

test("same-name index drift fails closed before any create, update, or seed write", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();
  await provisionForTest({ managerDatabase, database });
  const drifted = managerDatabase.indexes
    .get("bookings")
    .find(({ Name }) => Name === "bookings_sessionId_status");
  drifted.Keys = [
    { Name: "status", Direction: "1" },
    { Name: "sessionId", Direction: "1" },
  ];
  managerDatabase.collections.delete("system_state");
  managerDatabase.indexes.delete("system_state");
  managerDatabase.resetCalls();
  database.resetCalls();

  await assert.rejects(
    () => provisionForTest({ managerDatabase, database }),
    /INDEX_DRIFT: bookings\/bookings_sessionId_status/,
  );
  assert.deepEqual(managerDatabase.calls.create, []);
  assert.deepEqual(managerDatabase.calls.update, []);
  assert.deepEqual(managerDatabase.managerApi.calls.modify, []);
  assert.deepEqual(database.calls.set, []);
});

test("same-key index drift under a different name fails before any mutation", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();
  await provisionForTest({ managerDatabase, database });
  const indexes = managerDatabase.indexes.get("bookings");
  const expected = indexes.find(
    ({ Name }) => Name === "bookings_sessionId_status",
  );
  expected.Name = "legacy_session_status_name";
  managerDatabase.collections.delete("system_state");
  managerDatabase.indexes.delete("system_state");
  managerDatabase.resetCalls();
  database.resetCalls();

  await assert.rejects(
    () => provisionForTest({ managerDatabase, database }),
    /INDEX_DRIFT: bookings\/bookings_sessionId_status/,
  );
  assert.deepEqual(managerDatabase.calls.create, []);
  assert.deepEqual(managerDatabase.calls.update, []);
  assert.deepEqual(managerDatabase.managerApi.calls.modify, []);
  assert.deepEqual(database.calls.set, []);
});

test("same-ID seed drift fails closed while operational enabled/version changes remain valid", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();
  await provisionForTest({ managerDatabase, database });
  database.values.set("session_templates/slot-0700", {
    id: "slot-0700",
    startTime: "07:15",
    endTime: "08:15",
    enabled: false,
    version: 4,
  });
  managerDatabase.collections.delete("system_state");
  managerDatabase.indexes.delete("system_state");
  managerDatabase.resetCalls();
  database.resetCalls();

  await assert.rejects(
    () => provisionForTest({ managerDatabase, database }),
    /SEED_DRIFT: session_templates\/slot-0700/,
  );
  assert.deepEqual(managerDatabase.calls.create, []);
  assert.deepEqual(managerDatabase.calls.update, []);
  assert.deepEqual(managerDatabase.managerApi.calls.modify, []);
  assert.deepEqual(database.calls.set, []);
});

test("requires an explicit staging gate and reads only the two named Tencent credentials", () => {
  const accessed = [];
  const environment = new Proxy(
    {
      CLOUDBASE_DEPLOYMENT_STAGE: "staging",
      CLOUDBASE_ENV_ID: "opaque-production-identifier",
      TENCENTCLOUD_SECRETID: "secret-id-canary",
      TENCENTCLOUD_SECRETKEY: "secret-key-canary",
      TENCENTCLOUD_SECRET_ID: "must-not-be-read",
      TENCENTCLOUD_SECRET_KEY: "must-not-be-read",
    },
    {
      get(target, property, receiver) {
        if (typeof property === "string") accessed.push(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );

  assert.deepEqual(readProvisioningConfiguration(environment), {
    stage: "staging",
    envId: "opaque-production-identifier",
    secretId: "secret-id-canary",
    secretKey: "secret-key-canary",
  });
  assert.deepEqual(accessed, [
    "CLOUDBASE_DEPLOYMENT_STAGE",
    "CLOUDBASE_ENV_ID",
    "TENCENTCLOUD_SECRETID",
    "TENCENTCLOUD_SECRETKEY",
  ]);

  for (const values of [
    { ...environment, CLOUDBASE_DEPLOYMENT_STAGE: "production" },
    { ...environment, CLOUDBASE_DEPLOYMENT_STAGE: "test" },
    { ...environment, CLOUDBASE_ENV_ID: "attacker.example/" },
    { ...environment, TENCENTCLOUD_SECRETID: "" },
    { ...environment, TENCENTCLOUD_SECRETKEY: "" },
  ]) {
    assert.throws(() => readProvisioningConfiguration(values));
  }
});

test("rejects an invalid environment gate before constructing any cloud client", async () => {
  let constructorCalls = 0;
  const dependencies = {
    CloudBaseManager: class {
      constructor() {
        constructorCalls += 1;
      }
    },
    cloudbase: {
      init() {
        constructorCalls += 1;
      },
    },
  };

  await assert.rejects(
    () => provisionFromEnvironment({
      CLOUDBASE_DEPLOYMENT_STAGE: "production",
      CLOUDBASE_ENV_ID: TEST_ENV_ID,
      TENCENTCLOUD_SECRETID: "secret-id-canary",
      TENCENTCLOUD_SECRETKEY: "secret-key-canary",
    }, dependencies),
    /Invalid configuration: CLOUDBASE_DEPLOYMENT_STAGE/,
  );
  assert.equal(constructorCalls, 0);
});

test("formats unexpected cloud failures without printing credential values", () => {
  const secretId = "secret-id-must-never-be-logged";
  const secretKey = "secret-key-must-never-be-logged";
  const message = formatProvisioningError(
    new Error(`upstream echoed ${secretId} and ${secretKey}`),
  );

  assert.equal(message, "CloudBase provisioning failed");
  assert.equal(message.includes(secretId), false);
  assert.equal(message.includes(secretKey), false);
});

test("initializes manager 5.6 and node SDK 3.18 clients with their real option shapes", () => {
  const calls = [];
  const managerDatabase = { kind: "manager-database" };
  const managerApi = { kind: "manager-api" };
  const database = { kind: "document-database" };
  class FakeCloudBaseManager {
    constructor(options) {
      calls.push(["manager", clone(options)]);
      this.database = managerDatabase;
    }

    commonService(service, version) {
      calls.push(["manager-common-service", service, version]);
      return managerApi;
    }
  }
  const cloudbase = {
    init(options) {
      calls.push(["node-sdk", clone(options)]);
      return {
        database() {
          calls.push(["node-sdk-database"]);
          return database;
        },
      };
    },
  };
  const configuration = {
    stage: "staging",
    envId: "booking-test-000001",
    secretId: "secret-id-canary",
    secretKey: "secret-key-canary",
  };

  assert.deepEqual(
    createProvisioningClients(configuration, {
      CloudBaseManager: FakeCloudBaseManager,
      cloudbase,
    }),
    { managerApi, managerDatabase, database },
  );
  assert.deepEqual(calls, [
    [
      "manager",
      {
        envId: "booking-test-000001",
        secretId: "secret-id-canary",
        secretKey: "secret-key-canary",
      },
    ],
    [
      "node-sdk",
      {
        env: "booking-test-000001",
        secretId: "secret-id-canary",
        secretKey: "secret-key-canary",
      },
    ],
    ["manager-common-service", "tcb", "2018-06-08"],
    ["node-sdk-database"],
  ]);
});

test("retries bounded post-condition reads until created resources are actually visible", async () => {
  class EventuallyVisibleManagerDatabase extends FakeManagerDatabase {
    mutated = false;
    visible = false;

    async createCollection(name) {
      const result = await super.createCollection(name);
      this.mutated = true;
      return result;
    }

    async listCollections(options) {
      const result = await super.listCollections(options);
      if (!this.mutated || this.visible) return result;
      return {
        ...result,
        Collections: [],
        Pager: { ...result.Pager, Total: 0 },
      };
    }
  }
  const managerDatabase = new EventuallyVisibleManagerDatabase();
  const database = new FakeDocumentDatabase();
  let waits = 0;

  const result = await provisionForTest({
    managerDatabase,
    database,
    verification: {
      attempts: 3,
      delayMs: 0,
      wait: async () => {
        waits += 1;
        managerDatabase.visible = true;
      },
    },
  });

  assert.equal(waits, 1);
  assert.deepEqual(result, {
    createdCollections: 12,
    updatedCollectionAcls: 12,
    createdIndexes: 12,
    createdSeeds: 28,
  });
});

test("retries bounded ACL post-condition reads until ADMINONLY is visible", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase();
  managerDatabase.managerApi.deferModifications = true;
  let waits = 0;

  const result = await provisionForTest({
    managerDatabase,
    database,
    verification: {
      attempts: 3,
      delayMs: 0,
      wait: async () => {
        waits += 1;
        managerDatabase.managerApi.revealModifications();
      },
    },
  });

  assert.equal(waits, 1);
  assert.deepEqual(result, {
    createdCollections: 12,
    updatedCollectionAcls: 12,
    createdIndexes: 12,
    createdSeeds: 28,
  });
  assert.deepEqual(
    COLLECTIONS.map((name) => managerDatabase.managerApi.aclTags.get(name)),
    COLLECTIONS.map(() => "ADMINONLY"),
  );
});

test("fails after bounded verification when seed writes never become visible", async () => {
  const managerDatabase = new FakeManagerDatabase();
  const database = new FakeDocumentDatabase({ persistSets: false });
  let waits = 0;

  await assert.rejects(
    () => provisionForTest({
      managerDatabase,
      database,
      verification: {
        attempts: 2,
        delayMs: 0,
        wait: async () => {
          waits += 1;
        },
      },
    }),
    /POSTCONDITION_NOT_MET/,
  );
  assert.equal(waits, 1);
});
