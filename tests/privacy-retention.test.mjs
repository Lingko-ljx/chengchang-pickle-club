import assert from "node:assert/strict";
import test from "node:test";
import { BookingService } from "../lib/booking/booking-service.ts";
import { BookingError } from "../lib/booking/errors.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";
import { CloudBaseBookingRepository } from "../cloudbase/src/repositories/cloudbase-booking-repository.ts";
import { runPrivacyRetention } from "../cloudbase/src/privacy/redact-expired.ts";

const DAY = 24 * 60 * 60 * 1000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MarkerDocument {
  constructor(database, state, id) {
    this.database = database;
    this.state = state;
    this.id = id;
  }

  async get() {
    this.database.operations.push({ type: "get", id: this.id });
    const value = this.state.get(this.id);
    return { data: value === undefined ? [] : [clone(value)] };
  }

  async set(value) {
    this.database.operations.push({ type: "set", id: this.id, value: clone(value) });
    this.state.set(this.id, clone(value));
    return { updated: 1 };
  }
}

class MarkerDatabase {
  constructor() {
    this.state = new Map();
    this.operations = [];
    this.transactionCount = 0;
    this.whereInTransaction = 0;
    this.queue = Promise.resolve();
  }

  runTransaction(work, retries) {
    this.transactionCount += 1;
    assert.equal(retries, 3);
    const result = this.queue.then(async () => {
      const next = new Map(Array.from(this.state, ([id, value]) => [id, clone(value)]));
      const transaction = {
        collection: (name) => {
          assert.equal(name, "system_state");
          return {
            doc: (id) => new MarkerDocument(this, next, id),
            where: () => {
              this.whereInTransaction += 1;
              throw new Error("TRANSACTION_WHERE_FORBIDDEN");
            },
          };
        },
      };
      const value = await work(transaction);
      this.state = next;
      return value;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  marker() {
    return clone(this.state.get("retention-daily"));
  }
}

function record(overrides = {}) {
  return {
    id: "booking-001",
    code: "PICKLE2345",
    idempotencyKeyHash: "idempotency-secret",
    sessionId: "2026-01-01__slot-0700",
    date: "2026-01-01",
    startAt: "2025-12-31T23:00:00.000Z",
    endAt: "2026-01-01T00:00:00.000Z",
    courtId: "01",
    mode: "open",
    partySize: 2,
    status: "cancelled",
    name: "Ada Lovelace",
    phone: "13800138000",
    phoneHash: "phone-hash-secret",
    email: "ada@example.invalid",
    note: "private note",
    privacyConsentAt: "2025-12-01T00:00:00.000Z",
    canCancelUntil: "2025-12-31T23:00:00.000Z",
    createdAt: "2025-12-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    terminalAt: "2026-01-01T00:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

function expression(operator, value) {
  return { operator, value };
}

function queryMatches(value, condition) {
  return Object.entries(condition).every(([field, expected]) => {
    if (expected && typeof expected === "object" && expected.operator === "lt") {
      return value[field] < expected.value;
    }
    if (expected && typeof expected === "object" && expected.operator === "exists") {
      return (field in value) === expected.value;
    }
    return value[field] === expected;
  });
}

class RetentionQuery {
  constructor(database, records) {
    this.database = database;
    this.records = records;
    this.condition = {};
    this.orders = [];
    this.offset = 0;
    this.pageSize = 100;
  }

  where(condition) { this.condition = clone(condition); return this; }
  orderBy(field, direction) { this.orders.push([field, direction]); return this; }
  skip(value) { this.offset = value; return this; }
  limit(value) { this.pageSize = value; return this; }

  async get() {
    this.database.queries.push({
      condition: clone(this.condition),
      orders: clone(this.orders),
      offset: this.offset,
      pageSize: this.pageSize,
    });
    const values = this.records
      .filter((value) => queryMatches(value, this.condition))
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

test("Shanghai 03:15 is inclusive and one concurrent daily marker wins", async () => {
  // Catches a UTC-day marker, an early write, or two workers both running the batch.
  const database = new MarkerDatabase();
  let listCalls = 0;
  const repository = {
    listExpiredPersonalData: async () => {
      listCalls += 1;
      return [];
    },
  };
  const service = {
    redactPersonalData: async () => {
      throw new Error("NOT_EXPECTED");
    },
  };

  const before = await runPrivacyRetention({
    database,
    repository,
    service,
    clock: { now: () => new Date("2026-08-09T19:14:59.999Z") },
  });
  assert.deepEqual(before, { claimed: false, selected: 0, redacted: 0, skipped: 0 });
  assert.equal(database.transactionCount, 0);
  assert.equal(database.marker(), undefined);

  const dependencies = {
    database,
    repository,
    service,
    clock: { now: () => new Date("2026-08-09T19:15:00.000Z") },
  };
  const results = await Promise.all([
    runPrivacyRetention(dependencies),
    runPrivacyRetention(dependencies),
  ]);

  assert.equal(results.filter(({ claimed }) => claimed).length, 1);
  assert.equal(listCalls, 1);
  assert.deepEqual(database.marker(), {
    date: "2026-08-10",
    claimedAt: "2026-08-09T19:15:00.000Z",
  });
  assert.equal(database.whereInTransaction, 0);
});

test("CloudBase retention uses strict indexed stable pages before its global limit", async () => {
  // Catches unordered status reads that hide older eligible records.
  const cutoff = "2026-02-11T19:15:00.000Z";
  const cancelled = Array.from({ length: 151 }, (_, index) =>
    record({
      id: `cancelled-${String(index).padStart(3, "0")}`,
      terminalAt: new Date(Date.parse(cutoff) - (400 - index) * 60_000).toISOString(),
    }),
  );
  const completed = Array.from({ length: 30 }, (_, index) =>
    record({
      id: `completed-${String(index).padStart(3, "0")}`,
      status: "completed",
      terminalAt: new Date(Date.parse(cutoff) - (350 - index * 2) * 60_000).toISOString(),
    }),
  );
  const ineligible = [
    record({ id: "exact-cutoff", terminalAt: cutoff }),
    record({ id: "newer", terminalAt: new Date(Date.parse(cutoff) + 1).toISOString() }),
    record({ id: "active", status: "confirmed" }),
    record({ id: "already-redacted", personalDataRedactedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  const records = [...cancelled, ...completed, ...ineligible];
  const database = {
    queries: [],
    command: {
      lt: (value) => expression("lt", value),
      exists: (value) => expression("exists", value),
    },
    collection(name) {
      assert.equal(name, "bookings");
      return new RetentionQuery(this, records);
    },
  };
  const repository = new CloudBaseBookingRepository(database);
  const expected = [...cancelled, ...completed]
    .sort((left, right) =>
      left.terminalAt.localeCompare(right.terminalAt) || left.id.localeCompare(right.id),
    )
    .slice(0, 150)
    .map(({ id }) => id);

  const result = await repository.listExpiredPersonalData(cutoff, 150);

  assert.deepEqual(result.map(({ id }) => id), expected);
  assert.equal(result.some(({ id }) => ineligible.some((item) => item.id === id)), false);
  assert.deepEqual(database.queries[0].condition, {
    status: "cancelled",
    terminalAt: expression("lt", cutoff),
    personalDataRedactedAt: expression("exists", false),
  });
  assert.deepEqual(database.queries[0].orders, [["terminalAt", "asc"], ["id", "asc"]]);
  assert.deepEqual(
    database.queries.filter(({ condition }) => condition.status === "cancelled").map(({ offset }) => offset),
    [0, 100],
  );
  assert.deepEqual(
    [...new Set(database.queries.map(({ condition }) => condition.status))],
    ["cancelled", "completed"],
  );
});

test("memory retention breaks equal terminal timestamps by booking ID", async () => {
  const terminalAt = "2026-01-01T00:00:00.000Z";
  const repository = new MemoryBookingRepository({
    bookings: [
      record({ id: "booking-z", code: "CODEZ", terminalAt }),
      record({ id: "booking-a", code: "CODEA", terminalAt }),
    ],
  });

  assert.deepEqual(
    (await repository.listExpiredPersonalData("2026-01-02T00:00:00.000Z", 10)).map(
      ({ id }) => id,
    ),
    ["booking-a", "booking-z"],
  );
});

test("retention enforces strict 180 days, caps 100, continues conflicts, and redacts atomically", async () => {
  const now = new Date("2026-08-10T19:15:00.000Z");
  const cutoff = new Date(now.getTime() - 180 * DAY).toISOString();
  const eligible = Array.from({ length: 102 }, (_, index) =>
    record({
      id: `eligible-${String(index).padStart(3, "0")}`,
      code: `CODE${String(index).padStart(24, "0")}`,
      idempotencyKeyHash: `idempotency-${index}`,
      status: index % 2 === 0 ? "cancelled" : "completed",
      terminalAt: new Date(Date.parse(cutoff) - (200 - index) * 60_000).toISOString(),
    }),
  );
  const exact = record({ id: "exact-cutoff", code: "EXACTCODE", terminalAt: cutoff });
  const active = record({ id: "active-old", code: "ACTIVECODE", status: "confirmed" });
  const redacted = record({
    id: "already-redacted",
    code: "REDACTEDCODE",
    personalDataRedactedAt: "2026-03-01T00:00:00.000Z",
  });
  const repository = new MemoryBookingRepository({
    bookings: [...eligible, exact, active, redacted],
    idempotency: eligible.map((item) => ({
      keyHash: item.idempotencyKeyHash,
      bookingId: item.id,
    })),
  });
  const realService = new BookingService(repository);
  const conflictId = eligible[0].id;
  let conflictInjected = false;
  const service = {
    redactPersonalData: async (...args) => {
      if (!conflictInjected && args[0] === conflictId) {
        conflictInjected = true;
        throw new BookingError("CONFLICT");
      }
      return realService.redactPersonalData(...args);
    },
  };

  const result = await runPrivacyRetention({
    database: new MarkerDatabase(),
    repository,
    service,
    clock: { now: () => new Date(now) },
  });

  assert.deepEqual(result, { claimed: true, selected: 100, redacted: 99, skipped: 1 });
  assert.deepEqual(
    (await repository.listExpiredPersonalData(cutoff, 200)).map(({ id }) => id),
    [conflictId, "eligible-100", "eligible-101"],
  );
  assert.ok((await realService.lookup(eligible[1].code, eligible[1].phone)) === null);
  const stored = (await realService.listBookings({ query: eligible[1].id }))[0];
  assert.deepEqual(
    ["name", "phone", "phoneHash", "email", "note", "idempotencyKeyHash"].filter(
      (field) => field in stored,
    ),
    [],
  );
  assert.equal((await realService.listBookings({ query: exact.id }))[0].name, "Ada Lovelace");
  assert.equal((await realService.listBookings({ query: active.id }))[0].name, "Ada Lovelace");
  const audit = (await repository.listAuditLogs(eligible[1].id)).find(
    (entry) => entry.action === "personal_data_redacted",
  );
  assert.equal(audit.actorType, "system");
  assert.equal(audit.actorId, "retention-worker");
  assert.deepEqual(audit.metadata, {});
  const auditJson = JSON.stringify(audit);
  assert.equal(auditJson.includes("Ada Lovelace"), false);
  assert.equal(auditJson.includes("13800138000"), false);
  assert.equal(auditJson.includes("ada@example.invalid"), false);
});
