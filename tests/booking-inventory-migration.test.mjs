import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBookingInventoryMigration,
  planBookingInventoryMigration,
  readMigrationConfiguration,
  verifyBookingInventoryMigration,
} from "../scripts/migrate-booking-inventory-v2.mjs";
import { hasReadyMigrationMarker } from "../scripts/verify-booking-inventory-v2.mjs";

function activeBooking(overrides = {}) {
  return {
    id: "booking-1",
    date: "2026-08-12",
    startAt: "2026-08-12T01:30:00.000Z",
    endAt: "2026-08-12T03:30:00.000Z",
    courtId: "01",
    mode: "open",
    partySize: 2,
    status: "confirmed",
    ...overrides,
  };
}

test("migration dry-run backfills current and proposed half-hour cells without mutating inputs", () => {
  const bookings = [
    activeBooking(),
    activeBooking({
      id: "booking-2",
      status: "reschedule_proposed",
      date: "2026-08-13",
      startAt: "2026-08-13T04:00:00.000Z",
      endAt: "2026-08-13T05:00:00.000Z",
      courtId: "02",
      proposedStartAt: "2026-08-14T05:30:00.000Z",
      proposedEndAt: "2026-08-14T06:30:00.000Z",
      proposedCourtId: "03",
    }),
  ];
  const original = structuredClone(bookings);

  const plan = planBookingInventoryMigration(bookings, []);

  assert.deepEqual(bookings, original);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.summary.activeBookings, 2);
  assert.equal(plan.summary.reservations, 3);
  assert.equal(plan.changedInventories.length, 3);
  assert.deepEqual(
    plan.allInventories.find(({ id }) => id === "2026-08-12__court-01")?.cells,
    {
      "0930": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-1"] },
      "1000": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-1"] },
      "1030": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-1"] },
      "1100": { mode: "open", occupiedPlayers: 2, bookingIds: ["booking-1"] },
    },
  );
  assert.ok(plan.allInventories.some(({ id }) => id === "2026-08-14__court-03"));
});

test("migration is idempotent after its planned inventories have been written", () => {
  const bookings = [activeBooking()];
  const first = planBookingInventoryMigration(bookings, []);
  const second = planBookingInventoryMigration(bookings, first.allInventories);

  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(second.changedInventories, []);
  assert.deepEqual(verifyBookingInventoryMigration(bookings, first.allInventories), {
    valid: true,
    activeBookings: 1,
    reservations: 1,
    inventories: 1,
  });
});

test("migration fails closed on mixed private/open use or over-capacity", () => {
  const inventory = {
    id: "2026-08-12__court-01",
    date: "2026-08-12",
    courtId: "01",
    cells: {
      "0930": { mode: "private", occupiedPlayers: 1, bookingIds: ["existing-private"] },
    },
    version: 4,
  };
  const plan = planBookingInventoryMigration([activeBooking()], [inventory]);

  assert.equal(plan.changedInventories.length, 0);
  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0], /2026-08-12__court-01\/0930/);
  assert.deepEqual(verifyBookingInventoryMigration([activeBooking()], [inventory]), {
    valid: false,
    conflicts: plan.conflicts,
    missingInventories: 1,
  });
});

test("migration rejects bookings that cannot map exactly to Beijing half-hour cells", () => {
  assert.throws(
    () => planBookingInventoryMigration([
      activeBooking({ startAt: "2026-08-12T01:15:00.000Z" }),
    ], []),
    /INVALID_BOOKING_WINDOW/,
  );
});

test("verification rejects inventory cells owned by cancelled or otherwise inactive bookings", () => {
  const stale = {
    id: "2026-08-12__court-01",
    date: "2026-08-12",
    courtId: "01",
    cells: {
      "0930": { mode: "open", occupiedPlayers: 2, bookingIds: ["cancelled-booking"] },
    },
    version: 2,
  };
  assert.deepEqual(verifyBookingInventoryMigration([], [stale]), {
    valid: false,
    conflicts: ["INVENTORY_OWNERSHIP_MISMATCH:2026-08-12__court-01/0930"],
    missingInventories: 1,
  });
});

test("apply invalidates an existing ready marker before a failed rerun", async () => {
  const startedAt = new Date("2026-08-12T12:00:00.000Z");
  const state = new Map([[
    "booking-inventory-v2-migration",
    {
      id: "booking-inventory-v2-migration",
      status: "ready",
      schemaVersion: 2,
      verifiedAt: "2026-08-11T12:00:00.000Z",
      activeBookings: 1,
      reservations: 1,
      inventories: 1,
      inventoryChecksum: "a".repeat(64),
    },
  ]]);
  const database = {
    collection(name) {
      assert.equal(name, "system_state");
      return {
        doc(id) {
          return {
            async set(value) {
              state.set(id, structuredClone(value));
            },
          };
        },
      };
    },
  };

  await assert.rejects(
    applyBookingInventoryMigration(
      database,
      [activeBooking({ startAt: "2026-08-12T01:15:00.000Z" })],
      [],
      startedAt,
    ),
    /INVALID_BOOKING_WINDOW/,
  );

  const marker = state.get("booking-inventory-v2-migration");
  assert.deepEqual(marker, {
    id: "booking-inventory-v2-migration",
    status: "running",
    schemaVersion: 2,
    startedAt: startedAt.toISOString(),
  });
  assert.equal(hasReadyMigrationMarker(marker), false);
});

test("apply rereads booking documents and repairs stale ownership after a concurrent cancellation", async () => {
  const staleBooking = activeBooking();
  const cancelledBooking = { ...staleBooking, status: "cancelled" };
  const staleInventory = {
    id: "2026-08-12__court-01",
    date: "2026-08-12",
    courtId: "01",
    cells: {
      "0930": { mode: "open", occupiedPlayers: 2, bookingIds: [staleBooking.id] },
      "1000": { mode: "open", occupiedPlayers: 2, bookingIds: [staleBooking.id] },
      "1030": { mode: "open", occupiedPlayers: 2, bookingIds: [staleBooking.id] },
      "1100": { mode: "open", occupiedPlayers: 2, bookingIds: [staleBooking.id] },
    },
    version: 2,
  };
  const state = {
    bookings: new Map([[cancelledBooking.id, structuredClone(cancelledBooking)]]),
    court_day_allocations: new Map([[staleInventory.id, structuredClone(staleInventory)]]),
    system_state: new Map(),
  };
  const database = {
    collection(name) {
      const values = state[name];
      return {
        skip(offset) {
          return {
            limit(limit) {
              return {
                async get() {
                  return { data: Array.from(values.values()).slice(offset, offset + limit) };
                },
              };
            },
          };
        },
        doc(id) {
          return {
            async set(value) {
              values.set(id, structuredClone(value));
            },
          };
        },
      };
    },
    async runTransaction(work) {
      return work({
        collection(name) {
          const values = state[name];
          return {
            doc(id) {
              return {
                async get() {
                  return { data: values.has(id) ? structuredClone(values.get(id)) : null };
                },
                async set(value) {
                  values.set(id, structuredClone(value));
                },
              };
            },
          };
        },
      });
    },
  };

  const result = await applyBookingInventoryMigration(
    database,
    [staleBooking],
    [staleInventory],
    new Date("2026-08-12T12:00:00.000Z"),
  );

  assert.deepEqual(result, {
    valid: true,
    activeBookings: 0,
    reservations: 0,
    inventories: 1,
  });
  assert.deepEqual(state.court_day_allocations.get(staleInventory.id).cells, {});
  assert.equal(state.system_state.get("booking-inventory-v2-migration").status, "ready");
});

test("migration fails closed when one historical reschedule reserves the same cell twice", () => {
  const duplicate = activeBooking({
    status: "reschedule_proposed",
    proposedStartAt: "2026-08-12T02:30:00.000Z",
    proposedEndAt: "2026-08-12T03:30:00.000Z",
    proposedCourtId: "01",
  });
  const plan = planBookingInventoryMigration([duplicate], []);
  assert.ok(plan.conflicts.some((value) =>
    value === "DUPLICATE_BOOKING_RESERVATION:2026-08-12__court-01/1030:booking-1",
  ));
  assert.ok(plan.conflicts.some((value) =>
    value === "DUPLICATE_BOOKING_RESERVATION:2026-08-12__court-01/1100:booking-1",
  ));
});

test("migration CLI configuration requires the explicit staging gate and exact credentials", () => {
  assert.deepEqual(readMigrationConfiguration({
    CLOUDBASE_DEPLOYMENT_STAGE: "staging",
    CLOUDBASE_ENV_ID: "booking-test-000001",
    TENCENTCLOUD_SECRETID: "id",
    TENCENTCLOUD_SECRETKEY: "key",
  }), {
    stage: "staging",
    envId: "booking-test-000001",
    secretId: "id",
    secretKey: "key",
  });
  assert.throws(() => readMigrationConfiguration({
    CLOUDBASE_DEPLOYMENT_STAGE: "production",
    CLOUDBASE_ENV_ID: "booking-test-000001",
    TENCENTCLOUD_SECRETID: "id",
    TENCENTCLOUD_SECRETKEY: "key",
  }));
});

test("cutover verifier requires an exact ready marker with historical audit metrics", () => {
  const marker = {
    id: "booking-inventory-v2-migration",
    status: "ready",
    schemaVersion: 2,
    verifiedAt: "2026-08-12T00:00:00.000Z",
    activeBookings: 2,
    reservations: 3,
    inventories: 3,
    inventoryChecksum: "a".repeat(64),
  };
  assert.equal(hasReadyMigrationMarker(marker), true);
  assert.equal(hasReadyMigrationMarker({ ...marker, status: "running" }), false);
  assert.equal(hasReadyMigrationMarker({ ...marker, reservations: 2 }), true);
});
