import assert from "node:assert/strict";
import test from "node:test";
import { CloudBaseOutboxRepository } from "../cloudbase/src/repositories/cloudbase-outbox-repository.ts";

const OFFICIAL_REQUEST_ID = "8979fc1e-9564-4fc9-bf7d-2958ce679b72";
const OFFICIAL_MESSAGE_ID = "qcloudses-30-4123414323-date-20210101094334-syNARhMTbKI1";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function event(overrides = {}) {
  return {
    id: "event-001",
    bookingId: "booking-001",
    bookingVersion: 1,
    kind: "created",
    recipientType: "staff",
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: "2026-08-09T00:00:00.000Z",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function matches(record, condition) {
  return Object.entries(condition).every(([field, expected]) => {
    if (expected && typeof expected === "object" && expected.operator === "lte") {
      return record[field] <= expected.value;
    }
    return record[field] === expected;
  });
}

class FakeDocument {
  constructor(database, state, id) {
    this.database = database;
    this.state = state;
    this.id = id;
  }

  async get() {
    this.database.operations.push({ type: "get", id: this.id, transaction: true });
    const value = this.state.get(this.id);
    return { data: value === undefined ? [] : [clone(value)] };
  }

  async update(changes) {
    this.database.operations.push({
      type: "update",
      id: this.id,
      transaction: true,
      changes: clone(changes),
    });
    const current = this.state.get(this.id);
    if (!current) throw new Error("DOCUMENT_NOT_FOUND");
    const updated = { ...clone(current) };
    for (const [key, value] of Object.entries(changes)) {
      if (value && typeof value === "object" && value.removeField === true) delete updated[key];
      else updated[key] = clone(value);
    }
    this.state.set(this.id, updated);
    return { updated: 1 };
  }
}

class FakeCollection {
  constructor(database, state, transactional) {
    this.database = database;
    this.state = state;
    this.transactional = transactional;
    this.condition = {};
    this.orders = [];
    this.offset = 0;
    this.pageSize = 100;
  }

  doc(id) {
    return new FakeDocument(this.database, this.state, id);
  }

  where(condition) {
    if (this.transactional) {
      this.database.whereInTransaction += 1;
      throw new Error("TRANSACTION_WHERE_FORBIDDEN");
    }
    this.condition = clone(condition);
    return this;
  }

  orderBy(field, direction) {
    this.orders.push([field, direction]);
    return this;
  }

  skip(value) {
    this.offset = value;
    return this;
  }

  limit(value) {
    this.pageSize = value;
    return this;
  }

  async get() {
    this.database.queries.push({
      condition: clone(this.condition),
      orders: clone(this.orders),
      offset: this.offset,
      pageSize: this.pageSize,
    });
    const values = Array.from(this.state.values())
      .filter((value) => matches(value, this.condition))
      .sort((left, right) => {
        for (const [field, direction] of this.orders) {
          const comparison = String(left[field]).localeCompare(String(right[field]));
          if (comparison !== 0) return direction === "asc" ? comparison : -comparison;
        }
        return 0;
      });
    return { data: values.slice(this.offset, this.offset + this.pageSize).map(clone) };
  }
}

class FakeOutboxDatabase {
  constructor(events) {
    this.state = new Map(events.map((value) => [value.id, clone(value)]));
    this.queries = [];
    this.operations = [];
    this.whereInTransaction = 0;
    this.transactionRetries = [];
    this.queue = Promise.resolve();
    this.command = {
      lte: (value) => ({ operator: "lte", value }),
      remove: () => ({ removeField: true }),
    };
  }

  collection(name) {
    assert.equal(name, "notification_outbox");
    return new FakeCollection(this, this.state, false);
  }

  runTransaction(work, retries) {
    this.transactionRetries.push(retries);
    const result = this.queue.then(async () => {
      const next = new Map(Array.from(this.state, ([id, value]) => [id, clone(value)]));
      const transaction = {
        collection: (name) => {
          assert.equal(name, "notification_outbox");
          return new FakeCollection(this, next, true);
        },
      };
      const value = await work(transaction);
      this.state = next;
      return clone(value);
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  value(id) {
    return clone(this.state.get(id));
  }
}

test("eligible reads stable pages for every due state before applying the caller limit", async () => {
  // Catches an unordered first page hiding older eligible work in another status.
  const now = "2026-08-09T05:00:00.000Z";
  const pending = Array.from({ length: 101 }, (_, index) =>
    event({
      id: `pending-${String(index).padStart(3, "0")}`,
      nextAttemptAt: `2026-08-09T04:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }),
  );
  const database = new FakeOutboxDatabase([
    ...pending,
    event({ id: "retry-first", status: "retry", nextAttemptAt: "2026-08-09T01:00:00.000Z" }),
    event({
      id: "sending-inconsistent-future-lease",
      status: "sending",
      attemptCount: 1,
      leaseOwner: "active-worker",
      leaseToken: "active-token",
      leaseUntil: "2026-08-09T07:00:00.000Z",
      nextAttemptAt: "2026-08-09T00:30:00.000Z",
    }),
    event({
      id: "sending-expired",
      status: "sending",
      attemptCount: 1,
      leaseOwner: "old-worker",
      leaseToken: "old-token",
      leaseUntil: "2026-08-09T02:00:00.000Z",
      nextAttemptAt: "2026-08-09T02:00:00.000Z",
    }),
    event({ id: "future", nextAttemptAt: "2026-08-09T06:00:00.000Z" }),
    event({ id: "sent", status: "sent", nextAttemptAt: "2026-08-09T00:00:00.000Z" }),
  ]);
  const repository = new CloudBaseOutboxRepository(database);

  const result = await repository.listEligible(103, now);

  assert.equal(result.length, 103);
  assert.deepEqual(result.slice(0, 2).map(({ id }) => id), ["retry-first", "sending-expired"]);
  assert.equal(
    result.some(({ id }) =>
      id === "future" || id === "sent" || id === "sending-inconsistent-future-lease",
    ),
    false,
  );
  assert.deepEqual(
    [...new Set(database.queries.map(({ condition }) => condition.status))],
    ["pending", "retry", "sending"],
  );
  assert.equal(
    database.queries.some(({ condition }) =>
      condition.nextAttemptAt?.operator === "lte" && condition.nextAttemptAt.value === now,
    ),
    true,
  );
  assert.deepEqual(database.queries[0].orders, [["nextAttemptAt", "asc"], ["id", "asc"]]);
  assert.deepEqual(
    database.queries.filter(({ condition }) => condition.status === "pending").map(({ offset }) => offset),
    [0, 100],
  );
});

test("two workers racing for one event produce exactly one fenced claim", async () => {
  // Catches a read-then-write claim outside a transaction.
  const database = new FakeOutboxDatabase([event()]);
  const repository = new CloudBaseOutboxRepository(database);
  const [first, second] = await Promise.all([
    repository.claim(
      "event-001",
      "worker-a",
      "token-a",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:05:00.000Z",
    ),
    repository.claim(
      "event-001",
      "worker-b",
      "token-b",
      "2026-08-09T00:00:00.000Z",
      "2026-08-09T00:05:00.000Z",
    ),
  ]);

  assert.equal([first, second].filter(Boolean).length, 1);
  assert.deepEqual(database.value("event-001"), {
    ...event(),
    status: "sending",
    attemptCount: 1,
    nextAttemptAt: "2026-08-09T00:05:00.000Z",
    leaseOwner: first ? "worker-a" : "worker-b",
    leaseToken: first ? "token-a" : "token-b",
    leaseUntil: "2026-08-09T00:05:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  });
  assert.equal(database.whereInTransaction, 0);
  assert.deepEqual(database.transactionRetries, [3, 3]);
});

test("reclaimed leases fence every stale completion and clear lease fields atomically", async () => {
  // Catches an old worker overwriting the result of a reclaimed lease.
  const database = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 1,
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
      leaseOwner: "worker-old",
      leaseToken: "token-old",
      leaseUntil: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const repository = new CloudBaseOutboxRepository(database);
  const reclaimed = await repository.claim(
    "event-001",
    "worker-new",
    "token-new",
    "2026-08-09T00:05:00.000Z",
    "2026-08-09T00:10:00.000Z",
  );

  assert.equal(reclaimed.attemptCount, 2);
  assert.equal(
    await repository.markSent("event-001", "token-old", "2026-08-09T00:06:00.000Z", {
      providerRequestId: OFFICIAL_REQUEST_ID,
    }),
    false,
  );
  assert.equal(
    await repository.markRetry(
      "event-001",
      "token-new",
      "2026-08-09T00:06:00.000Z",
      "2026-08-09T00:08:00.000Z",
      "NETWORK_ERROR",
    ),
    true,
  );
  assert.deepEqual(database.value("event-001"), {
    ...event(),
    status: "retry",
    attemptCount: 2,
    nextAttemptAt: "2026-08-09T00:08:00.000Z",
    lastErrorCode: "NETWORK_ERROR",
    updatedAt: "2026-08-09T00:06:00.000Z",
  });
  assert.equal(
    await repository.markFailed(
      "event-001",
      "token-old",
      "2026-08-09T00:07:00.000Z",
      "PERMANENT_ERROR",
    ),
    false,
  );
});

test("a reclaim rejects an empty or reused fencing token without mutation", async () => {
  // Catches a caller accidentally preserving the old worker's authority.
  const seeded = event({
    status: "sending",
    attemptCount: 1,
    nextAttemptAt: "2026-08-09T00:05:00.000Z",
    leaseOwner: "worker-old",
    leaseToken: "token-old",
    leaseUntil: "2026-08-09T00:05:00.000Z",
  });
  const database = new FakeOutboxDatabase([seeded]);
  const repository = new CloudBaseOutboxRepository(database);

  assert.equal(
    await repository.claim(
      "event-001",
      "worker-new",
      "token-old",
      "2026-08-09T00:05:00.000Z",
      "2026-08-09T00:10:00.000Z",
    ),
    null,
  );
  assert.equal(
    await repository.claim(
      "event-001",
      "worker-new",
      "",
      "2026-08-09T00:05:00.000Z",
      "2026-08-09T00:10:00.000Z",
    ),
    null,
  );
  assert.deepEqual(database.value("event-001"), seeded);
});

test("successful and terminal marks persist only normalized result fields", async () => {
  const sentDatabase = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 1,
      leaseOwner: "worker-a",
      leaseToken: "token-a",
      leaseUntil: "2026-08-09T00:05:00.000Z",
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const sentRepository = new CloudBaseOutboxRepository(sentDatabase);
  assert.equal(
    await sentRepository.markSent("event-001", "token-a", "2026-08-09T00:01:00.000Z", {
      providerRequestId: OFFICIAL_REQUEST_ID,
      providerMessageId: OFFICIAL_MESSAGE_ID,
    }),
    true,
  );
  assert.deepEqual(sentDatabase.value("event-001"), {
    ...event(),
    status: "sent",
    attemptCount: 1,
    nextAttemptAt: "2026-08-09T00:05:00.000Z",
    providerRequestId: OFFICIAL_REQUEST_ID,
    providerMessageId: OFFICIAL_MESSAGE_ID,
    sentAt: "2026-08-09T00:01:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
  });

  const failedDatabase = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 5,
      leaseOwner: "worker-a",
      leaseToken: "token-a",
      leaseUntil: "2026-08-09T00:05:00.000Z",
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const failedRepository = new CloudBaseOutboxRepository(failedDatabase);
  assert.equal(
    await failedRepository.markFailed(
      "event-001",
      "token-a",
      "2026-08-09T00:01:00.000Z",
      "INVALID_ADDRESS",
    ),
    true,
  );
  assert.deepEqual(failedDatabase.value("event-001"), {
    ...event(),
    status: "failed",
    attemptCount: 5,
    nextAttemptAt: "2026-08-09T00:05:00.000Z",
    lastErrorCode: "INVALID_ADDRESS",
    failedAt: "2026-08-09T00:01:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
  });
});

test("an expired fifth claim is terminalized without creating a sixth send", async () => {
  // Catches a crashed fifth sender being reclaimed into an unauthorized sixth attempt.
  const database = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 5,
      leaseOwner: "worker-old",
      leaseToken: "token-old",
      leaseUntil: "2026-08-09T00:05:00.000Z",
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const repository = new CloudBaseOutboxRepository(database);

  const claim = await repository.claim(
    "event-001",
    "worker-new",
    "token-new",
    "2026-08-09T00:05:00.000Z",
    "2026-08-09T00:10:00.000Z",
  );

  assert.equal(claim, null);
  assert.deepEqual(database.value("event-001"), {
    ...event(),
    status: "failed",
    attemptCount: 5,
    nextAttemptAt: "2026-08-09T00:05:00.000Z",
    lastErrorCode: "ATTEMPTS_EXHAUSTED",
    failedAt: "2026-08-09T00:05:00.000Z",
    updatedAt: "2026-08-09T00:05:00.000Z",
  });
});

test("repository defenses never persist PII-shaped provider fields or raw error text", async () => {
  // Catches sanitization that merely replaces punctuation while retaining recognizable PII.
  const sentDatabase = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 1,
      leaseOwner: "worker-a",
      leaseToken: "token-a",
      leaseUntil: "2026-08-09T00:05:00.000Z",
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const sentRepository = new CloudBaseOutboxRepository(sentDatabase);
  await sentRepository.markSent("event-001", "token-a", "2026-08-09T00:01:00.000Z", {
    providerRequestId: "13800138000",
    providerMessageId: "alice@example.com",
  });
  const sentJson = JSON.stringify(sentDatabase.value("event-001"));
  assert.equal(sentJson.includes("alice"), false);
  assert.equal(sentJson.includes("13800138000"), false);
  assert.match(sentJson, /REDACTED/);

  const namedDatabase = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 1,
      leaseOwner: "worker-a",
      leaseToken: "token-a",
      leaseUntil: "2026-08-09T00:05:00.000Z",
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const namedRepository = new CloudBaseOutboxRepository(namedDatabase);
  await namedRepository.markSent("event-001", "token-a", "2026-08-09T00:01:00.000Z", {
    providerRequestId: "AdaLovelace",
    providerMessageId: "Alice123",
  });
  const namedJson = JSON.stringify(namedDatabase.value("event-001"));
  assert.equal(namedJson.includes("AdaLovelace"), false);
  assert.equal(namedJson.includes("Alice123"), false);
  assert.equal((namedJson.match(/REDACTED/g) ?? []).length, 2);

  const failedDatabase = new FakeOutboxDatabase([
    event({
      status: "sending",
      attemptCount: 1,
      leaseOwner: "worker-a",
      leaseToken: "token-a",
      leaseUntil: "2026-08-09T00:05:00.000Z",
      nextAttemptAt: "2026-08-09T00:05:00.000Z",
    }),
  ]);
  const failedRepository = new CloudBaseOutboxRepository(failedDatabase);
  await failedRepository.markFailed(
    "event-001",
    "token-a",
    "2026-08-09T00:01:00.000Z",
    "delivery failed for alice@example.com",
  );
  assert.equal(failedDatabase.value("event-001").lastErrorCode, "UNKNOWN_ERROR");
  assert.equal(JSON.stringify(failedDatabase.value("event-001")).includes("alice"), false);
});
