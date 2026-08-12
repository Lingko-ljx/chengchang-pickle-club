import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BookingService, courtIds } from "../lib/booking/booking-service.ts";
import {
  inventoryCellKeys,
  validateCourtTimeBlockWindow,
} from "../lib/booking/booking-window.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";

const DATE = "2099-01-01";

function identifiers() {
  let booking = 0;
  let code = 0;
  let event = 0;
  return {
    bookingId: () => `booking-${++booking}`,
    bookingCode: () => `CODE${++code}`,
    eventId: () => `event-${++event}`,
  };
}

function setup() {
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    identifiers(),
    {
      hash: (phone) => createHmac("sha256", "time-block-test").update(phone).digest("hex"),
    },
  );
  return { repository, service };
}

function booking(overrides = {}) {
  return {
    idempotencyKey: "customer-booking-1",
    date: DATE,
    startTime: "09:30",
    endTime: "10:30",
    mode: "private",
    partySize: 2,
    name: "预约客人",
    phone: "13800138000",
    privacyConsent: true,
    ...overrides,
  };
}

test("court time blocks accept 30-minute Beijing boundaries independently of booking duration", () => {
  assert.deepEqual(validateCourtTimeBlockWindow(DATE, "09:30", "10:00"), {
    date: DATE,
    startTime: "09:30",
    endTime: "10:00",
    cellKeys: ["0930"],
  });
  for (const [startTime, endTime] of [
    ["08:30", "09:30"],
    ["21:30", "22:30"],
    ["09:15", "10:00"],
    ["09:30", "09:30"],
  ]) {
    assert.throws(
      () => validateCourtTimeBlockWindow(DATE, startTime, endTime),
      /INVALID_INPUT/,
    );
  }
});

test("closing multiple courts writes one atomic inventory change and removes those cells from availability", async () => {
  const { repository, service } = setup();
  const blocks = await service.createCourtTimeBlocks({
    date: DATE,
    startTime: "09:30",
    endTime: "10:30",
    courtIds: ["01", "02"],
    reason: "场地维护",
    expectedVersions: { "01": 0, "02": 0 },
    actorId: "staff-1",
  });

  assert.deepEqual(blocks.map(({ courtId, reason, version }) => ({ courtId, reason, version })), [
    { courtId: "01", reason: "场地维护", version: 1 },
    { courtId: "02", reason: "场地维护", version: 1 },
  ]);
  assert.equal((await service.listCourtTimeBlocks(DATE)).length, 2);
  const inventories = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, ["01", "02"]),
  );
  for (const inventory of inventories) {
    assert.deepEqual(Object.keys(inventory.blockedCells).sort(), ["0930", "1000"]);
    assert.equal(Object.keys(inventory.timeBlocks).length, 1);
  }
  const window = (await service.listWindowAvailability(DATE)).windows.find(
    ({ startTime, endTime }) => startTime === "09:30" && endTime === "10:30",
  );
  assert.equal(window.privateCourtCount, 9);
  assert.equal(window.openCapacity, 36);

  const created = await service.create(booking());
  assert.equal(created.courtId, "03");
});

test("closure day read exposes current inventory versions for safe admin edits", async () => {
  const { service } = setup();
  const [first] = await service.createCourtTimeBlocks({
    date: DATE,
    startTime: "09:00",
    endTime: "09:30",
    courtIds: ["01"],
    expectedVersions: { "01": 0 },
    actorId: "staff-1",
  });
  await service.createCourtTimeBlocks({
    date: DATE,
    startTime: "10:00",
    endTime: "10:30",
    courtIds: ["01"],
    expectedVersions: { "01": 1 },
    actorId: "staff-1",
  });

  const day = await service.listCourtTimeBlockDay(DATE);
  assert.equal(day.inventoryVersions["01"], 2);
  assert.equal(day.inventoryVersions["02"], 0);
  assert.equal(day.items.find(({ id }) => id === first.id).version, 2);
});

test("closures require verified inventory and bound a multi-court transaction to two courts", async () => {
  const notReady = new BookingService(new MemoryBookingRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
  }));
  const command = {
    date: DATE,
    startTime: "09:00",
    endTime: "09:30",
    courtIds: ["01"],
    expectedVersions: { "01": 0 },
    actorId: "staff-1",
  };
  await assert.rejects(() => notReady.createCourtTimeBlocks(command), /SESSION_CLOSED/);

  const { service } = setup();
  await assert.rejects(() => service.createCourtTimeBlocks({
    ...command,
    courtIds: ["01", "02", "03"],
    expectedVersions: { "01": 0, "02": 0, "03": 0 },
  }), /INVALID_INPUT/);
});

test("creating or editing a closure at an already-started Beijing time fails, while restore remains allowed", async () => {
  let now = new Date("2099-01-01T00:00:00.000Z");
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
  });
  const service = new BookingService(repository, { now: () => now }, identifiers(), {
    hash: (phone) => createHmac("sha256", "time-block-test").update(phone).digest("hex"),
  });
  const [created] = await service.createCourtTimeBlocks({
    date: DATE, courtIds: ["01"], startTime: "09:30", endTime: "10:00",
    expectedVersions: { "01": 0 }, actorId: "staff-1",
  });
  now = new Date("2099-01-01T01:45:00.000Z");

  await assert.rejects(() => service.createCourtTimeBlocks({
    date: DATE, courtIds: ["02"], startTime: "09:30", endTime: "10:00",
    expectedVersions: { "02": 0 }, actorId: "staff-1",
  }), /SESSION_CLOSED/);
  await assert.rejects(() => service.updateCourtTimeBlock({
    blockId: created.id, date: DATE, courtId: "01", startTime: "09:30", endTime: "10:30",
    expectedVersion: 1, actorId: "staff-1",
  }), /SESSION_CLOSED/);
  await service.restoreCourtTimeBlock({
    blockId: created.id, date: DATE, courtId: "01", expectedVersion: 1, actorId: "staff-1",
  });
  assert.deepEqual(await service.listCourtTimeBlocks(DATE), []);
});

test("a block overlapping any existing booking rejects a multi-court write without partial changes", async () => {
  const { repository, service } = setup();
  const created = await service.create(booking());
  assert.equal(created.courtId, "01");

  await assert.rejects(
    () => service.createCourtTimeBlocks({
      date: DATE,
      startTime: "10:00",
      endTime: "11:00",
      courtIds: ["01", "02"],
      expectedVersions: { "01": 1, "02": 0 },
      actorId: "staff-1",
    }),
    /CONFLICT/,
  );
  assert.deepEqual(await service.listCourtTimeBlocks(DATE), []);
  assert.deepEqual(
    await repository.runTransaction((transaction) =>
      transaction.getCourtDayInventories(DATE, ["02"]),
    ),
    [],
  );
});

test("staff can edit a block range and reason, then restore it with optimistic versions", async () => {
  const { service } = setup();
  const [created] = await service.createCourtTimeBlocks({
    date: DATE,
    startTime: "09:00",
    endTime: "09:30",
    courtIds: ["01"],
    reason: "清洁",
    expectedVersions: { "01": 0 },
    actorId: "staff-1",
  });
  const updated = await service.updateCourtTimeBlock({
    blockId: created.id,
    date: DATE,
    courtId: "01",
    startTime: "10:30",
    endTime: "11:30",
    reason: "设备检修",
    expectedVersion: created.version,
    actorId: "staff-2",
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.reason, "设备检修");
  assert.deepEqual(updated.cellKeys, inventoryCellKeys("10:30", "11:30"));
  await assert.rejects(
    () => service.restoreCourtTimeBlock({
      blockId: created.id,
      date: DATE,
      courtId: "01",
      expectedVersion: created.version,
      actorId: "staff-2",
    }),
    /CONFLICT/,
  );
  await service.restoreCourtTimeBlock({
    blockId: created.id,
    date: DATE,
    courtId: "01",
    expectedVersion: updated.version,
    actorId: "staff-2",
  });
  assert.deepEqual(await service.listCourtTimeBlocks(DATE), []);
});

test("editing a block away from its original range never aliases a newly closed old range", async () => {
  const { service } = setup();
  const [first] = await service.createCourtTimeBlocks({
    date: DATE, courtIds: ["01"], startTime: "09:00", endTime: "09:30",
    expectedVersions: { "01": 0 }, actorId: "staff-1",
  });
  const moved = await service.updateCourtTimeBlock({
    blockId: first.id, date: DATE, courtId: "01", startTime: "10:00", endTime: "10:30",
    expectedVersion: 1, actorId: "staff-1",
  });
  const [replacement] = await service.createCourtTimeBlocks({
    date: DATE, courtIds: ["01"], startTime: "09:00", endTime: "09:30",
    expectedVersions: { "01": 2 }, actorId: "staff-1",
  });

  assert.notEqual(replacement.id, moved.id);
  assert.equal((await service.listCourtTimeBlocks(DATE)).length, 2);
  await service.restoreCourtTimeBlock({
    blockId: replacement.id, date: DATE, courtId: "01", expectedVersion: 3, actorId: "staff-1",
  });
  const remaining = await service.listCourtTimeBlocks(DATE);
  assert.deepEqual(remaining.map(({ id, startTime }) => ({ id, startTime })), [
    { id: moved.id, startTime: "10:00" },
  ]);
});

test("time block validation rejects duplicate courts, unknown courts and sensitive-looking free text", async () => {
  const { service } = setup();
  for (const input of [
    { courtIds: ["01", "01"], reason: "维护" },
    { courtIds: ["99"], reason: "维护" },
    { courtIds: ["01"], reason: "13800138000" },
    { courtIds: ["01"], reason: "A".repeat(101) },
  ]) {
    await assert.rejects(
      () => service.createCourtTimeBlocks({
        date: DATE,
        startTime: "09:00",
        endTime: "09:30",
        expectedVersions: Object.fromEntries(input.courtIds.map((id) => [id, 0])),
        actorId: "staff-1",
        ...input,
      }),
      /INVALID_INPUT|SESSION_NOT_FOUND/,
    );
  }
});
