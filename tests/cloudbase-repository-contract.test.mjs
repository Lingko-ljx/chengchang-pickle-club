import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BookingService } from "../lib/booking/booking-service.ts";
import { CloudBaseBookingRepository } from "../cloudbase/src/repositories/cloudbase-booking-repository.ts";
import { functionTargets, parseTargets } from "../scripts/build-cloudbase-functions.mjs";

const sessionId = "2026-08-10__slot-1900";
const courtIds = Array.from({ length: 11 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class FakeDocument {
  constructor(sdk, state, collectionName, id) {
    this.sdk = sdk;
    this.state = state;
    this.collectionName = collectionName;
    this.id = id;
  }

  async get() {
    this.sdk.readIds.push(this.id);
    this.sdk.operations.push({ type: "get", collection: this.collectionName, id: this.id });
    const value = this.state.get(this.collectionName)?.get(this.id);
    return { data: value === undefined ? [] : [clone(value)] };
  }

  async set(data) {
    this.sdk.operations.push({
      type: "set",
      collection: this.collectionName,
      id: this.id,
      data: clone(data),
    });
    let collection = this.state.get(this.collectionName);
    if (!collection) {
      collection = new Map();
      this.state.set(this.collectionName, collection);
    }
    collection.set(this.id, clone(data));
    return { updated: 1 };
  }

  async update(data) {
    this.sdk.operations.push({
      type: "update",
      collection: this.collectionName,
      id: this.id,
      data: clone(data),
    });
    const collection = this.state.get(this.collectionName);
    const current = collection?.get(this.id);
    if (!collection || current === undefined) throw new Error("DOCUMENT_NOT_FOUND");
    const next = { ...clone(current) };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && value.removeField === true) delete next[key];
      else next[key] = clone(value);
    }
    collection.set(this.id, next);
    return { updated: 1 };
  }

  async remove() {
    this.sdk.operations.push({ type: "remove", collection: this.collectionName, id: this.id });
    this.state.get(this.collectionName)?.delete(this.id);
    return { deleted: 1 };
  }
}

class FakeCollection {
  constructor(sdk, state, name, transactional) {
    this.sdk = sdk;
    this.state = state;
    this.name = name;
    this.transactional = transactional;
  }

  doc(id) {
    return new FakeDocument(this.sdk, this.state, this.name, id);
  }

  where() {
    if (this.transactional) {
      this.sdk.whereCalls += 1;
      throw new Error("TRANSACTION_WHERE_FORBIDDEN");
    }
    throw new Error("FAKE_QUERY_NOT_IMPLEMENTED");
  }
}

class FakeCloudBaseDatabase {
  constructor(seed = {}) {
    this.state = new Map(
      Object.entries(seed).map(([collection, values]) => [
        collection,
        new Map(Object.entries(values).map(([id, value]) => [id, clone(value)])),
      ]),
    );
    this.readIds = [];
    this.operations = [];
    this.whereCalls = 0;
    this.retryAttempts = [];
    this.command = { removeValue: { removeField: true }, remove: () => this.command.removeValue };
  }

  collection(name) {
    return new FakeCollection(this, this.state, name, false);
  }

  async runTransaction(work, retries) {
    this.retryAttempts.push(retries);
    const transactionState = new Map(
      Array.from(this.state, ([collection, values]) => [
        collection,
        new Map(Array.from(values, ([id, value]) => [id, clone(value)])),
      ]),
    );
    const transaction = {
      collection: (name) => new FakeCollection(this, transactionState, name, true),
    };
    const result = await work(transaction);
    this.state = transactionState;
    return result;
  }

  value(collection, id) {
    return clone(this.state.get(collection)?.get(id));
  }
}

function bookingCommand(overrides = {}) {
  return {
    idempotencyKey: "request-001",
    sessionId,
    mode: "open",
    partySize: 2,
    name: "Ada Lovelace",
    phone: "13800138000",
    email: "ada@example.com",
    note: "Near the net",
    privacyConsent: true,
    ...overrides,
  };
}

function seededDatabase() {
  return new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
    ),
    sessions: {
      [sessionId]: {
        id: sessionId,
        date: "2026-08-10",
        templateId: "slot-1900",
        startAt: "2026-08-10T11:00:00.000Z",
        endAt: "2026-08-10T12:00:00.000Z",
        status: "open",
        enabledCourtIds: courtIds,
        version: 1,
      },
    },
  });
}

function serviceFor(database) {
  let event = 0;
  const clock = { now: () => new Date("2026-08-01T00:00:00.000Z") };
  return new BookingService(
    new CloudBaseBookingRepository(database, clock),
    clock,
    {
      bookingId: () => "booking-001",
      bookingCode: () => "ABCD2345",
      eventId: () => `event-${++event}`,
    },
  );
}

function pagedBookingDatabase(records, trace) {
  return {
    command: {},
    collection(name) {
      assert.equal(name, "bookings");
      let condition = {};
      const orders = [];
      let offset = 0;
      let pageSize = 100;
      return {
        where(value) { condition = value; return this; },
        orderBy(field, direction) { orders.push([field, direction]); return this; },
        skip(value) { offset = value; return this; },
        limit(value) { pageSize = value; return this; },
        async get() {
          trace.push({ condition: clone(condition), orders: clone(orders), offset, pageSize });
          const matches = records
            .filter((record) => Object.entries(condition).every(([key, value]) => record[key] === value))
            .sort((left, right) => {
              for (const [field, direction] of orders) {
                const compared = String(left[field]).localeCompare(String(right[field]));
                if (compared) return direction === "asc" ? compared : -compared;
              }
              return 0;
            });
          return { data: matches.slice(offset, offset + pageSize).map(clone) };
        },
      };
    },
  };
}

test("create reads every deterministic allocation document without a transaction query", async () => {
  // Catches replacing the deterministic eleven doc reads with a transaction where() query.
  const database = seededDatabase();
  const booking = await serviceFor(database).create(bookingCommand());

  assert.equal(booking.id, "booking-001");
  assert.deepEqual(
    database.readIds.filter((id) => id.includes("__court-")),
    Array.from(
      { length: 11 },
      (_, index) => `2026-08-10__slot-1900__court-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  assert.equal(database.whereCalls, 0);
  assert.deepEqual(database.retryAttempts, [3]);
  assert.deepEqual(database.value("court_allocations", `${sessionId}__court-01`), {
    id: `${sessionId}__court-01`,
    sessionId,
    courtId: "01",
    mode: "open",
    occupiedPlayers: 2,
    bookingIds: ["booking-001"],
    version: 1,
  });
  assert.deepEqual(
    ["event-2", "event-3"].map((id) => database.value("notification_outbox", id)),
    [
      {
        id: "event-2",
        bookingId: "booking-001",
        kind: "created",
        recipientType: "staff",
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "event-3",
        bookingId: "booking-001",
        kind: "created",
        recipientType: "customer",
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  );
});

test("code lookup follows the deterministic code index before reading the booking", async () => {
  // Catches a booking collection query or treating the hash document as the booking itself.
  const database = seededDatabase();
  const service = serviceFor(database);
  const created = await service.create(bookingCommand());
  database.readIds.length = 0;
  database.operations.length = 0;

  const found = await service.lookup(" abcd2345 ", "138 0013 8000");
  const codeHash = createHash("sha256").update("ABCD2345").digest("hex");

  assert.equal(found.id, created.id);
  assert.deepEqual(database.readIds, [codeHash, "booking-001"]);
  assert.deepEqual(
    database.operations.map(({ type, collection, id }) => ({ type, collection, id })),
    [
      { type: "get", collection: "booking_codes", id: codeHash },
      { type: "get", collection: "bookings", id: "booking-001" },
    ],
  );
  assert.equal(database.whereCalls, 0);
});

test("mailer booking reads use one deterministic document outside a transaction", async () => {
  // Catches replacing the mailer's ID read with an unindexed collection query.
  const booking = {
    id: "booking-mail-001",
    code: "NOT-EXPOSED",
    status: "confirmed",
  };
  const database = new FakeCloudBaseDatabase({
    bookings: { [booking.id]: booking },
  });
  const repository = new CloudBaseBookingRepository(database);

  const found = await repository.getBookingById(booking.id);

  assert.deepEqual(found, booking);
  assert.deepEqual(database.readIds, [booking.id]);
  assert.deepEqual(
    database.operations.map(({ type, collection, id }) => ({ type, collection, id })),
    [{ type: "get", collection: "bookings", id: booking.id }],
  );
  assert.deepEqual(database.retryAttempts, []);
  assert.equal(database.whereCalls, 0);
});

test("redaction atomically removes both lookup documents and personal fields", async () => {
  // Catches leaving either deterministic lookup or any personal field behind.
  const database = seededDatabase();
  const service = serviceFor(database);
  const created = await service.create(bookingCommand());
  database.operations.length = 0;

  await service.redactPersonalData(created.id, "retention-worker", created.version);

  const codeHash = createHash("sha256").update("ABCD2345").digest("hex");
  const idempotencyHash = createHash("sha256").update("request-001").digest("hex");
  const redacted = database.value("bookings", created.id);
  assert.equal(database.value("booking_codes", codeHash), undefined);
  assert.equal(database.value("idempotency", idempotencyHash), undefined);
  assert.deepEqual(
    ["name", "phone", "phoneHash", "email", "note", "idempotencyKeyHash"].filter(
      (field) => field in redacted,
    ),
    [],
  );
  assert.equal(redacted.version, 2);
  assert.equal(redacted.personalDataRedactedAt, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(database.value("audit_logs", "redact-booking-001-2"), {
    id: "redact-booking-001-2",
    bookingId: "booking-001",
    action: "personal_data_redacted",
    actorType: "system",
    actorId: "retention-worker",
    at: "2026-08-01T00:00:00.000Z",
    metadata: {},
  });
  assert.deepEqual(
    database.operations
      .filter(({ type }) => type === "remove")
      .map(({ collection, id }) => ({ collection, id })),
    [
      { collection: "booking_codes", id: codeHash },
      { collection: "idempotency", id: idempotencyHash },
    ],
  );
  assert.equal(database.whereCalls, 0);
});

test("CloudBase redaction persists an explicit non-PII staff audit", async () => {
  const database = seededDatabase();
  const service = serviceFor(database);
  const created = await service.create(bookingCommand());

  await service.redactPersonalData(created.id, "profile-staff-7", created.version, "staff");

  assert.deepEqual(database.value("audit_logs", "redact-booking-001-2"), {
    id: "redact-booking-001-2",
    bookingId: "booking-001",
    action: "personal_data_redacted",
    actorType: "staff",
    actorId: "profile-staff-7",
    at: "2026-08-01T00:00:00.000Z",
    metadata: {},
  });
});

test("CloudBase booking export pushes the inclusive date range down before its hard limit", async () => {
  const trace = { condition: undefined, orders: [], limit: undefined };
  const query = {
    where(condition) {
      trace.condition = condition;
      return this;
    },
    orderBy(field, direction) {
      trace.orders.push([field, direction]);
      return this;
    },
    limit(value) {
      trace.limit = value;
      return this;
    },
    async get() {
      return { data: [bookingCommand({ id: "in-range", date: "2026-08-10" })] };
    },
  };
  const range = (operator, value) => ({
    operator,
    value,
    and(other) {
      return {
        operator: "and",
        operands: [
          { operator: this.operator, value: this.value },
          { operator: other.operator, value: other.value },
        ],
      };
    },
  });
  const database = {
    command: {
      remove() {
        return { removeField: true };
      },
      gte(value) {
        return range("gte", value);
      },
      lte(value) {
        return range("lte", value);
      },
    },
    collection(name) {
      assert.equal(name, "bookings");
      return query;
    },
  };
  const repository = new CloudBaseBookingRepository(database);

  await repository.listBookings({
    fromDate: "2026-08-01",
    toDate: "2026-08-31",
    limit: 500,
  });

  assert.deepEqual(trace.condition, {
    date: {
      operator: "and",
      operands: [
        { operator: "gte", value: "2026-08-01" },
        { operator: "lte", value: "2026-08-31" },
      ],
    },
  });
  assert.deepEqual(trace.orders, [
    ["date", "asc"],
    ["createdAt", "asc"],
  ]);
  assert.equal(trace.limit, 500);
});

test("CloudBase audit history reads every ordered page for one booking", async () => {
  const all = Array.from({ length: 101 }, (_, index) => ({
    id: `audit-${String(index).padStart(3, "0")}`,
    bookingId: "booking-1",
    action: "changed",
    actorType: "staff",
    at: `2026-08-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    metadata: {},
  }));
  const trace = { condition: undefined, orders: [], skips: [] };
  let offset = 0;
  let pageSize = 100;
  const query = {
    where(condition) { trace.condition = condition; return this; },
    orderBy(field, direction) { trace.orders.push([field, direction]); return this; },
    skip(value) { offset = value; trace.skips.push(value); return this; },
    limit(value) { pageSize = value; return this; },
    async get() { return { data: all.slice(offset, offset + pageSize) }; },
  };
  const repository = new CloudBaseBookingRepository({
    command: {},
    collection(name) { assert.equal(name, "audit_logs"); return query; },
  });

  const result = await repository.listAuditLogs("booking-1");

  assert.equal(result.length, 101);
  assert.deepEqual(trace.condition, { bookingId: "booking-1" });
  assert.deepEqual(trace.orders.slice(0, 2), [["at", "asc"], ["id", "asc"]]);
  assert.deepEqual(trace.skips, [0, 100]);
});

test("CloudBase pending scheduling reads beyond the former 500-row cap", async () => {
  const records = Array.from({ length: 501 }, (_, index) => ({
    id: `pending-${String(index).padStart(3, "0")}`,
    date: "2026-08-10",
    status: "pending",
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const trace = [];
  const repository = new CloudBaseBookingRepository(pagedBookingDatabase(records, trace));

  const result = await repository.listPendingBookings("2026-08-10");

  assert.equal(result.length, 501);
  assert.deepEqual(trace.map(({ offset }) => offset), [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(trace[0].condition, { date: "2026-08-10", status: "pending" });
  assert.deepEqual(trace[0].orders, [["createdAt", "asc"], ["id", "asc"]]);
});

test("CloudBase matrix merges every current and cross-date proposal page without duplicates", async () => {
  const targetDate = "2026-08-10";
  const current = Array.from({ length: 101 }, (_, index) => ({
    id: `current-${String(index).padStart(3, "0")}`,
    date: targetDate,
    status: index === 0 ? "reschedule_proposed" : "confirmed",
    ...(index === 0 ? { proposedDate: targetDate } : {}),
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const proposed = Array.from({ length: 101 }, (_, index) => ({
    id: `proposed-${String(index).padStart(3, "0")}`,
    date: "2026-08-09",
    proposedDate: targetDate,
    status: "reschedule_proposed",
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const terminal = ["cancelled", "completed"].map((status) => ({
    id: `terminal-${status}`,
    date: targetDate,
    status,
    createdAt: "2026-08-01T00:00:00.000Z",
  }));
  const trace = [];
  const repository = new CloudBaseBookingRepository(
    pagedBookingDatabase([...current, ...proposed, ...terminal], trace),
  );

  const result = await repository.listMatrixBookings(targetDate);

  assert.equal(result.length, 202);
  assert.equal(new Set(result.map(({ id }) => id)).size, 202);
  assert.equal(result.some(({ status }) => status === "cancelled" || status === "completed"), false);
  assert.deepEqual(
    [...new Set(trace.map(({ condition }) => JSON.stringify(condition)))].map((value) => JSON.parse(value)),
    [
      { date: targetDate },
      { proposedDate: targetDate, status: "reschedule_proposed" },
    ],
  );
  assert.equal(trace.filter(({ offset }) => offset === 100).length, 2);
  assert.deepEqual(trace[0].orders, [["createdAt", "asc"], ["id", "asc"]]);
});

test("Task 10 provisions every stable scheduling and audit query index", async () => {
  const plan = await readFile(
    new URL("../docs/superpowers/plans/2026-08-04-booking-core.md", import.meta.url),
    "utf8",
  );
  for (const index of [
    "(date,createdAt,id)",
    "(date,status,createdAt,id)",
    "(proposedDate,status,createdAt,id)",
    "(bookingId,at,id)",
    "(status,terminalAt,personalDataRedactedAt,id)",
    "(status,nextAttemptAt,id)",
  ]) {
    assert.match(plan, new RegExp(index.replace(/[()]/g, "\\$&")), index);
  }
  assert.doesNotMatch(plan, /audit logs by `\(bookingId,createdAt\)`/);
});

test("court and template updates append deterministic staff audits in their transactions", async () => {
  // Catches dropping the authenticated actor or committing configuration without its audit.
  const database = new FakeCloudBaseDatabase({
    courts: { "01": { id: "01", enabled: true, version: 1 } },
    session_templates: {
      "slot-1900": {
        id: "slot-1900",
        startTime: "19:00",
        endTime: "20:00",
        enabled: true,
        version: 4,
      },
    },
  });
  const service = serviceFor(database);

  await service.setCourtEnabled("01", false, "profile-staff-7", 1);
  await service.setSessionTemplateEnabled("slot-1900", false, "profile-staff-7", 4);

  assert.deepEqual(database.value("audit_logs", "config-court-01-v2"), {
    id: "config-court-01-v2",
    bookingId: "court:01",
    action: "court_enabled_changed",
    actorType: "staff",
    actorId: "profile-staff-7",
    at: "2026-08-01T00:00:00.000Z",
    metadata: { entity: "court", id: "01", enabled: false, version: 2 },
  });
  assert.deepEqual(database.value("audit_logs", "config-session-template-slot-1900-v5"), {
    id: "config-session-template-slot-1900-v5",
    bookingId: "session-template:slot-1900",
    action: "session_template_enabled_changed",
    actorType: "staff",
    actorId: "profile-staff-7",
    at: "2026-08-01T00:00:00.000Z",
    metadata: {
      entity: "session-template",
      id: "slot-1900",
      enabled: false,
      version: 5,
    },
  });
  assert.equal(database.whereCalls, 0);
});

test("function target map exposes the three exact source and output pairs", () => {
  // Catches a target being wired to another function's entry or output directory.
  assert.deepEqual(functionTargets, {
    "booking-public-api": {
      entry: "cloudbase/src/functions/booking-public-api.ts",
      outfile: "cloudbase/functions/booking-public-api/index.js",
    },
    "booking-admin-api": {
      entry: "cloudbase/src/functions/booking-admin-api.ts",
      outfile: "cloudbase/functions/booking-admin-api/index.js",
    },
    "booking-mailer": {
      entry: "cloudbase/src/functions/booking-mailer.ts",
      outfile: "cloudbase/functions/booking-mailer/index.js",
    },
  });
  assert.deepEqual(parseTargets(["booking-public-api", "booking-mailer"]), [
    "booking-public-api",
    "booking-mailer",
  ]);
});

test("function bundler rejects an unknown target before checking future source entries", () => {
  // Catches silently accepting typos or trying to build all future functions on every invocation.
  const script = fileURLToPath(new URL("../scripts/build-cloudbase-functions.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "not-a-function"], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown CloudBase function target: not-a-function/);
  assert.doesNotMatch(result.stderr, /booking-public-api\.ts/);
});
