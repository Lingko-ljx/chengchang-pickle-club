import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BookingService } from "../lib/booking/booking-service.ts";
import { cloudbaseApp } from "../cloudbase/src/cloudbase-app.ts";
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
  constructor(sdk, state, collectionName, id, transactional) {
    this.sdk = sdk;
    this.state = state;
    this.collectionName = collectionName;
    this.id = id;
    this.transactional = transactional;
  }

  async get() {
    this.sdk.readIds.push(this.id);
    const operation = { type: "get", collection: this.collectionName, id: this.id };
    this.sdk.operations.push(operation);
    return this.run(async () => {
      const value = this.state.get(this.collectionName)?.get(this.id);
      if (value === undefined) return { data: [] };
      const document = { ...clone(value), _id: this.id };
      return { data: this.transactional ? document : [document] };
    });
  }

  async set(data) {
    const value = clone(data);
    const operation = {
      type: "set",
      collection: this.collectionName,
      id: this.id,
      data: value,
    };
    this.sdk.operations.push(operation);
    return this.run(async () => {
      if (Object.hasOwn(value, "_id")) throw new Error("INVALID_PARAM");
      let collection = this.state.get(this.collectionName);
      if (!collection) {
        collection = new Map();
        this.state.set(this.collectionName, collection);
      }
      collection.set(this.id, value);
      return { updated: 1 };
    });
  }

  async update(data) {
    this.sdk.operations.push({
      type: "update",
      collection: this.collectionName,
      id: this.id,
      data: clone(data),
    });
    return this.run(async () => {
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
    });
  }

  async remove() {
    this.sdk.operations.push({ type: "remove", collection: this.collectionName, id: this.id });
    return this.run(async () => {
      this.state.get(this.collectionName)?.delete(this.id);
      return { deleted: 1 };
    });
  }

  run(operation) {
    return this.transactional ? this.sdk.runTransactionOperation(operation) : operation();
  }
}

class FakeCollection {
  constructor(sdk, state, name, transactional) {
    this.sdk = sdk;
    this.state = state;
    this.name = name;
    this.transactional = transactional;
    this.condition = {};
    this.orders = [];
    this.offset = 0;
    this.pageSize = 100;
  }

  doc(id) {
    return new FakeDocument(
      this.sdk,
      this.state,
      this.name,
      id,
      this.transactional,
    );
  }

  where(condition) {
    if (this.transactional) {
      this.sdk.whereCalls += 1;
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
    if (!this.transactional) {
      this.sdk.nonTransactionQueryInFlight += 1;
      this.sdk.maxNonTransactionQueryInFlight = Math.max(
        this.sdk.maxNonTransactionQueryInFlight,
        this.sdk.nonTransactionQueryInFlight,
      );
      await Promise.resolve();
    }
    this.sdk.queries.push({
      collection: this.name,
      condition: clone(this.condition),
      orders: clone(this.orders),
      offset: this.offset,
      pageSize: this.pageSize,
    });
    const values = Array.from(this.state.get(this.name)?.entries() ?? [])
      .map(([id, record]) => ({ ...clone(record), _id: id }))
      .filter((record) =>
        Object.entries(this.condition).every(([key, value]) => record[key] === value),
      )
      .sort((left, right) => {
        for (const [field, direction] of this.orders) {
          const compared = String(left[field]).localeCompare(String(right[field]));
          if (compared) return direction === "asc" ? compared : -compared;
        }
        return 0;
      });
    const response = { data: values.slice(this.offset, this.offset + this.pageSize).map(clone) };
    if (!this.transactional) this.sdk.nonTransactionQueryInFlight -= 1;
    return response;
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
    this.queries = [];
    this.whereCalls = 0;
    this.retryAttempts = [];
    this.transactionInFlight = 0;
    this.transactionOperationCount = 0;
    this.nonTransactionQueryInFlight = 0;
    this.maxNonTransactionQueryInFlight = 0;
    this.maxTransactionInFlight = 0;
    this.transactionBusyErrors = 0;
    this.beforeNextTransaction = undefined;
    this.command = { removeValue: { removeField: true }, remove: () => this.command.removeValue };
  }

  collection(name) {
    return new FakeCollection(this, this.state, name, false);
  }

  async runTransactionOperation(operation) {
    if (this.transactionInFlight !== 0) {
      this.transactionBusyErrors += 1;
      throw new Error("ResourceUnavailable.TransactionBusy");
    }
    this.transactionInFlight += 1;
    this.transactionOperationCount += 1;
    this.maxTransactionInFlight = Math.max(
      this.maxTransactionInFlight,
      this.transactionInFlight,
    );
    try {
      await Promise.resolve();
      return await operation();
    } finally {
      this.transactionInFlight -= 1;
    }
  }

  async runTransaction(work, retries) {
    this.retryAttempts.push(retries);
    const beforeTransaction = this.beforeNextTransaction;
    this.beforeNextTransaction = undefined;
    if (beforeTransaction) beforeTransaction(this.state);
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

function seededDatabase(extraSeed = {}) {
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
    ...extraSeed,
  });
}

function provisionedTemplates() {
  return Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => {
      const startHour = index + 7;
      const endHour = startHour + 1;
      const id = `slot-${String(startHour).padStart(2, "0")}00`;
      return [
        id,
        {
          id,
          startTime: `${String(startHour).padStart(2, "0")}:00`,
          endTime: `${String(endHour).padStart(2, "0")}:00`,
          enabled: true,
          version: 1,
        },
      ];
    }).reverse(),
  );
}

function serviceFor(database, now = "2026-08-01T00:00:00.000Z") {
  let event = 0;
  const clock = { now: () => new Date(now) };
  return new BookingService(
    new CloudBaseBookingRepository(database, clock),
    clock,
    {
      bookingId: () => "booking-001",
      bookingCode: () => "ABCD2345",
      eventId: () => `event-${++event}`,
    },
    {
      hash: (phone) =>
        createHmac("sha256", "repository-contract-phone-salt")
          .update(phone)
          .digest("hex"),
    },
  );
}

test("fresh CloudBase provision synthesizes sixteen slots then materializes the first booking", async () => {
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(courtIds.map((id) => [id, { id, enabled: true, version: 1 }])),
    session_templates: provisionedTemplates(),
  });
  const service = serviceFor(database);

  const fresh = await service.listAvailability("2026-08-10");

  assert.equal(fresh.length, 16);
  assert.deepEqual(fresh.map(({ startTime }) => startTime), [
    "07:00", "08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00",
    "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00",
  ]);
  assert.equal(fresh[0].openCapacity, 44);
  assert.equal(fresh[0].privateCourtCount, 11);
  assert.equal(database.value("sessions", "2026-08-10__slot-0700"), undefined);
  assert.deepEqual(database.retryAttempts, []);
  assert.equal(database.operations.some(({ type }) => type === "set"), false);
  assert.equal(database.queries.every(({ pageSize }) => pageSize <= 100), true);
  assert.deepEqual(
    database.queries.find(({ collection }) => collection === "sessions"),
    {
      collection: "sessions",
      condition: { date: "2026-08-10", status: "open" },
      orders: [["startAt", "asc"]],
      offset: 0,
      pageSize: 100,
    },
  );

  await service.create(bookingCommand());
  const afterCreate = await service.listAvailability("2026-08-10");
  const bookedSlot = afterCreate.find(({ sessionId: id }) => id === sessionId);
  assert.equal(afterCreate.length, 16);
  assert.equal(bookedSlot.openCapacity, 42);
  assert.equal(bookedSlot.privateCourtCount, 10);
  assert.equal(database.value("sessions", sessionId).enabledCourtIds.length, 11);
});

test("CloudBase availability omits disabled and past templates and excludes disabled courts", async () => {
  const templates = provisionedTemplates();
  templates["slot-0900"].enabled = false;
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: id !== "11", version: 1 }]),
    ),
    session_templates: templates,
    sessions: {
      "2026-08-01__slot-1000": {
        id: "2026-08-01__slot-1000",
        date: "2026-08-01",
        templateId: "slot-1000",
        startAt: "2026-08-01T02:00:00.000Z",
        endAt: "2026-08-01T03:00:00.000Z",
        status: "closed",
        enabledCourtIds: courtIds,
        version: 2,
      },
    },
  });
  const service = serviceFor(database, "2026-07-31T23:30:00.000Z");

  const slots = await service.listAvailability("2026-08-01");

  assert.equal(slots.length, 13);
  assert.equal(slots[0].startTime, "08:00");
  assert.equal(slots.some(({ startTime }) => startTime === "09:00"), false);
  assert.equal(slots.some(({ startTime }) => startTime === "10:00"), false);
  assert.equal(slots.every(({ openCapacity }) => openCapacity === 40), true);
  assert.equal(slots.every(({ privateCourtCount }) => privateCourtCount === 10), true);
});

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

test("production CloudBase app explicitly enables the SDK keepalive contract", () => {
  assert.equal(cloudbaseApp.config.keepalive, true);
});

test("CloudBase booking create keeps one SDK operation in flight per transaction", async () => {
  const database = seededDatabase();

  const booking = await serviceFor(database).create(bookingCommand());

  assert.equal(booking.id, "booking-001");
  assert.equal(database.maxTransactionInFlight, 1);
  assert.equal(database.transactionBusyErrors, 0);
});

test("v2 create stays within a stable twelve-operation transaction budget", async () => {
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
    ),
    system_state: {
      "booking-inventory-v2-migration": {
        id: "booking-inventory-v2-migration",
        status: "ready",
        schemaVersion: 2,
      },
    },
  });
  const service = serviceFor(database);
  const booking = await service.create(bookingCommand({
    sessionId: undefined,
    date: "2026-08-10",
    startTime: "09:30",
    endTime: "11:30",
  }));

  assert.equal(booking.sessionId, "2026-08-10__window-v2-0930-1130");
  assert.equal(booking.courtId, "01");
  assert.equal(database.maxTransactionInFlight, 1);
  assert.equal(database.transactionBusyErrors, 0);
  assert.equal(database.transactionOperationCount, 12);
  assert.equal(database.whereCalls, 0);
  assert.deepEqual(
    database.readIds.filter((id) => /^2026-08-10__court-\d{2}$/.test(id)),
    ["2026-08-10__court-01"],
  );
  assert.deepEqual(
    database.queries.find(({ collection }) => collection === "court_day_allocations"),
    {
      collection: "court_day_allocations",
      condition: { date: "2026-08-10" },
      orders: [],
      offset: 0,
      pageSize: 100,
    },
  );
  assert.deepEqual(database.value("court_day_allocations", "2026-08-10__court-01"), {
    id: "2026-08-10__court-01",
    date: "2026-08-10",
    courtId: "01",
    cells: {
      "0930": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-001"] },
      "1000": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-001"] },
      "1030": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-001"] },
      "1100": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-001"] },
    },
    version: 1,
  });

  database.transactionOperationCount = 0;
  const cancelled = await service.cancel({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorType: "customer",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(database.transactionOperationCount, 6);
  assert.equal(database.maxTransactionInFlight, 1);
  assert.equal(database.transactionBusyErrors, 0);
  assert.deepEqual(
    database.value("court_day_allocations", "2026-08-10__court-01").cells,
    {},
  );
});

test("v2 create rechecks a stale preflight candidate inside the transaction", async () => {
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
    ),
    system_state: {
      "booking-inventory-v2-migration": {
        id: "booking-inventory-v2-migration",
        status: "ready",
        schemaVersion: 2,
      },
    },
  });
  database.beforeNextTransaction = (state) => {
    state.set("court_day_allocations", new Map([
      ["2026-08-10__court-01", {
        id: "2026-08-10__court-01",
        date: "2026-08-10",
        courtId: "01",
        cells: {
          "0930": {
            mode: "private",
            occupiedPlayers: 4,
            bookingIds: ["booking-racing"],
          },
        },
        version: 1,
      }],
    ]));
  };

  const booking = await serviceFor(database).create(bookingCommand({
    sessionId: undefined,
    date: "2026-08-10",
    startTime: "09:30",
    endTime: "10:30",
  }));

  assert.equal(booking.courtId, "02");
  assert.deepEqual(
    database.value("court_day_allocations", "2026-08-10__court-01").cells["0930"],
    {
      mode: "private",
      occupiedPlayers: 4,
      bookingIds: ["booking-racing"],
    },
  );
  assert.equal(database.transactionOperationCount, 13);
  assert.equal(database.maxTransactionInFlight, 1);
  assert.equal(database.transactionBusyErrors, 0);
});

test("v2 availability uses one non-transaction inventory query", async () => {
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
    ),
    system_state: {
      "booking-inventory-v2-migration": {
        id: "booking-inventory-v2-migration",
        status: "ready",
        schemaVersion: 2,
      },
    },
  });

  const availability = await serviceFor(database).listWindowAvailability("2026-08-10");

  assert.equal(availability.windows.length > 0, true);
  assert.equal(database.transactionOperationCount, 0);
  assert.equal(database.maxNonTransactionQueryInFlight, 2);
  assert.deepEqual(database.retryAttempts, []);
  assert.deepEqual(
    database.queries.filter(({ collection }) => collection === "court_day_allocations"),
    [{
      collection: "court_day_allocations",
      condition: { date: "2026-08-10" },
      orders: [],
      offset: 0,
      pageSize: 100,
    }],
  );
});

test("v2 reschedule proposal stays within a stable eight-operation transaction budget", async () => {
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
    ),
    system_state: {
      "booking-inventory-v2-migration": {
        id: "booking-inventory-v2-migration",
        status: "ready",
        schemaVersion: 2,
      },
    },
  });
  const service = serviceFor(database);
  const created = await service.create(bookingCommand({
    sessionId: undefined,
    date: "2026-08-10",
    startTime: "09:30",
    endTime: "10:30",
  }));
  database.transactionOperationCount = 0;

  const proposed = await service.proposeReschedule({
    bookingId: created.id,
    expectedVersion: created.version,
    actorId: "profile-staff-7",
    date: "2026-08-10",
    startTime: "11:00",
    endTime: "12:00",
  });

  assert.equal(proposed.status, "reschedule_proposed");
  assert.equal(proposed.proposedCourtId, "01");
  assert.equal(database.transactionOperationCount, 8);
  assert.equal(database.maxTransactionInFlight, 1);
  assert.equal(database.transactionBusyErrors, 0);
});

test("v2 reschedule proposal rechecks a stale preflight candidate", async () => {
  const database = new FakeCloudBaseDatabase({
    courts: Object.fromEntries(
      courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
    ),
    system_state: {
      "booking-inventory-v2-migration": {
        id: "booking-inventory-v2-migration",
        status: "ready",
        schemaVersion: 2,
      },
    },
  });
  const service = serviceFor(database);
  const created = await service.create(bookingCommand({
    sessionId: undefined,
    date: "2026-08-10",
    startTime: "09:30",
    endTime: "10:30",
  }));
  database.transactionOperationCount = 0;
  database.beforeNextTransaction = (state) => {
    const inventories = state.get("court_day_allocations");
    const inventory = inventories.get("2026-08-10__court-01");
    inventories.set("2026-08-10__court-01", {
      ...inventory,
      cells: {
        ...inventory.cells,
        "1200": {
          mode: "private",
          occupiedPlayers: 4,
          bookingIds: ["booking-racing"],
        },
        "1230": {
          mode: "private",
          occupiedPlayers: 4,
          bookingIds: ["booking-racing"],
        },
      },
      version: inventory.version + 1,
    });
  };

  const proposed = await service.proposeReschedule({
    bookingId: created.id,
    expectedVersion: created.version,
    actorId: "profile-staff-7",
    date: "2026-08-10",
    startTime: "12:00",
    endTime: "13:00",
  });

  assert.equal(proposed.proposedCourtId, "02");
  assert.equal(database.transactionOperationCount, 9);
  assert.equal(database.maxTransactionInFlight, 1);
  assert.equal(database.transactionBusyErrors, 0);
  assert.deepEqual(
    database.value("court_day_allocations", "2026-08-10__court-01").cells["1200"],
    {
      mode: "private",
      occupiedPlayers: 4,
      bookingIds: ["booking-racing"],
    },
  );
});

test("v2 reschedule fails before inventory work for every unverified migration state", async () => {
  for (const marker of [
    undefined,
    { status: "running", schemaVersion: 2 },
    { status: "failed", schemaVersion: 2 },
  ]) {
    const database = new FakeCloudBaseDatabase({
      courts: Object.fromEntries(
        courtIds.map((id) => [id, { id, enabled: true, version: 1 }]),
      ),
      system_state: {
        "booking-inventory-v2-migration": {
          id: "booking-inventory-v2-migration",
          status: "ready",
          schemaVersion: 2,
        },
      },
    });
    const service = serviceFor(database);
    const created = await service.create(bookingCommand({
      sessionId: undefined,
      date: "2026-08-10",
      startTime: "09:30",
      endTime: "10:30",
    }));
    if (marker) {
      database.state.get("system_state").set("booking-inventory-v2-migration", {
        id: "booking-inventory-v2-migration",
        ...marker,
      });
    } else {
      database.state.get("system_state").delete("booking-inventory-v2-migration");
    }
    database.operations.length = 0;
    database.transactionOperationCount = 0;

    await assert.rejects(
      () => service.proposeReschedule({
        bookingId: created.id,
        expectedVersion: created.version,
        actorId: "profile-staff-7",
        date: "2026-08-10",
        startTime: "11:00",
        endTime: "12:00",
      }),
      /SESSION_CLOSED/,
    );

    assert.equal(database.transactionOperationCount, 1);
    assert.deepEqual(
      database.operations.filter(({ type }) => type === "set"),
      [],
    );
    assert.equal(database.maxTransactionInFlight, 1);
    assert.equal(database.transactionBusyErrors, 0);
  }
});

test("legacy staff reschedule rejects targets outside 09:00-22:00 before writes", async () => {
  for (const [startTime, startAt, endAt] of [
    ["07:00", "2026-08-09T23:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    ["08:00", "2026-08-10T00:00:00.000Z", "2026-08-10T01:00:00.000Z"],
    ["22:00", "2026-08-10T14:00:00.000Z", "2026-08-10T15:00:00.000Z"],
  ]) {
    const database = seededDatabase();
    const targetSessionId = `2026-08-10__slot-${startTime.replace(":", "")}`;
    database.state.get("sessions").set(targetSessionId, {
      id: targetSessionId,
      date: "2026-08-10",
      templateId: `slot-${startTime.replace(":", "")}`,
      startAt,
      endAt,
      status: "open",
      enabledCourtIds: courtIds,
      version: 1,
    });
    const service = serviceFor(database);
    const created = await service.create(bookingCommand());
    database.operations.length = 0;

    await assert.rejects(
      () => service.proposeReschedule({
        bookingId: created.id,
        expectedVersion: created.version,
        actorId: "profile-staff-7",
        sessionId: targetSessionId,
      }),
      /SESSION_CLOSED/,
    );

    assert.deepEqual(
      database.operations.filter(({ type }) => type === "set"),
      [],
      startTime,
    );
  }
});

test("legacy staff reschedule keeps legal 09:00 and 21:00 targets", async () => {
  for (const [startTime, startAt, endAt] of [
    ["09:00", "2026-08-10T01:00:00.000Z", "2026-08-10T02:00:00.000Z"],
    ["21:00", "2026-08-10T13:00:00.000Z", "2026-08-10T14:00:00.000Z"],
  ]) {
    const database = seededDatabase();
    const targetSessionId = `2026-08-10__slot-${startTime.replace(":", "")}`;
    database.state.get("sessions").set(targetSessionId, {
      id: targetSessionId,
      date: "2026-08-10",
      templateId: `slot-${startTime.replace(":", "")}`,
      startAt,
      endAt,
      status: "open",
      enabledCourtIds: courtIds,
      version: 1,
    });
    const service = serviceFor(database);
    const created = await service.create(bookingCommand());

    const proposed = await service.proposeReschedule({
      bookingId: created.id,
      expectedVersion: created.version,
      actorId: "profile-staff-7",
      sessionId: targetSessionId,
    });

    assert.equal(proposed.proposedSessionId, targetSessionId);
    assert.equal(proposed.status, "reschedule_proposed");
  }
});

test("CloudBase v2 readiness requires the exact verified migration marker", async () => {
  for (const [marker, expected] of [
    [undefined, false],
    [{ id: "booking-inventory-v2-migration", status: "running", schemaVersion: 2 }, false],
    [{ id: "booking-inventory-v2-migration", status: "ready", schemaVersion: 1 }, false],
    [{ id: "booking-inventory-v2-migration", status: "ready", schemaVersion: 2 }, true],
  ]) {
    const database = new FakeCloudBaseDatabase({
      ...(marker ? { system_state: { "booking-inventory-v2-migration": marker } } : {}),
    });
    const repository = new CloudBaseBookingRepository(database);
    assert.equal(await repository.isBookingInventoryV2Ready(), expected);
    assert.equal(database.whereCalls, 0);
  }
});

test("create reads every deterministic allocation document without a transaction query", async () => {
  // Catches replacing the deterministic eleven doc reads with a transaction where() query.
  const database = seededDatabase();
  const booking = await serviceFor(database).create(bookingCommand());

  assert.equal(booking.id, "booking-001");
  assert.deepEqual(
    database.readIds.filter((id) => /__slot-\d{4}__court-/.test(id)),
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
        bookingVersion: 1,
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
        bookingVersion: 1,
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

test("create reuses an existing partially occupied allocation without persisting CloudBase _id", async () => {
  const allocation = {
    id: `${sessionId}__court-01`,
    sessionId,
    courtId: "01",
    mode: "open",
    occupiedPlayers: 1,
    bookingIds: ["booking-existing"],
    version: 1,
  };
  const database = seededDatabase({
    court_allocations: { [allocation.id]: allocation },
  });

  const created = await serviceFor(database).create(bookingCommand());

  assert.equal(created.courtId, "01");
  assert.deepEqual(database.value("court_allocations", allocation.id), {
    ...allocation,
    occupiedPlayers: 3,
    bookingIds: ["booking-existing", "booking-001"],
    version: 2,
  });
  assert.equal(
    database.operations
      .filter(({ type }) => type === "set")
      .some(({ data }) => Object.hasOwn(data, "_id")),
    false,
  );
});

test("booking lifecycle read-modify-write never persists CloudBase _id", async () => {
  const database = seededDatabase();
  const service = serviceFor(database);
  const created = await service.create(bookingCommand());
  database.operations.length = 0;

  const confirmed = await service.confirm({
    bookingId: created.id,
    expectedVersion: created.version,
    actorId: "profile-staff-7",
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.version, 2);
  assert.equal(Object.hasOwn(confirmed, "_id"), false);
  assert.equal(Object.hasOwn(database.value("bookings", created.id), "_id"), false);
  assert.equal(
    database.operations
      .filter(({ type }) => type === "set")
      .some(({ data }) => Object.hasOwn(data, "_id")),
    false,
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
