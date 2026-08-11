import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  BookingService,
  courtIds,
} from "../lib/booking/booking-service.ts";
import {
  bookingWindowSessionId,
  defaultBookingPolicy,
  inventoryCellKeys,
  validateBookingWindow,
} from "../lib/booking/booking-window.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";

const DATE = "2099-01-01";

function ids() {
  let booking = 0;
  let code = 0;
  let event = 0;
  return {
    bookingId: () => `window-booking-${++booking}`,
    bookingCode: () => `WINCODE${++code}`,
    eventId: () => `window-event-${++event}`,
  };
}

function phoneHasher() {
  return {
    hash: (phone) => createHmac("sha256", "window-test-salt").update(phone).digest("hex"),
  };
}

function setup() {
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
  });
  return {
    repository,
    service: new BookingService(
      repository,
      { now: () => new Date("2098-12-01T00:00:00.000Z") },
      ids(),
      phoneHasher(),
    ),
  };
}

function command(overrides = {}) {
  return {
    idempotencyKey: "window-request-1",
    date: DATE,
    startTime: "09:30",
    endTime: "11:30",
    mode: "private",
    partySize: 2,
    name: "预约人",
    phone: "13800138000",
    privacyConsent: true,
    ...overrides,
  };
}

function seededBooking(overrides = {}) {
  return {
    id: "seed-booking",
    code: "SEEDCODE",
    sessionId: `${DATE}__slot-0900`,
    date: DATE,
    startAt: "2099-01-01T01:00:00.000Z",
    endAt: "2099-01-01T02:00:00.000Z",
    courtId: "01",
    mode: "private",
    partySize: 2,
    status: "pending",
    name: "旧预约",
    phone: "13800138000",
    phoneHash: phoneHasher().hash("13800138000"),
    privacyConsentAt: "2098-12-01T00:00:00.000Z",
    canCancelUntil: "2099-01-01T01:00:00.000Z",
    createdAt: "2098-12-01T00:00:00.000Z",
    updatedAt: "2098-12-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

test("booking policy uses Beijing 09:00–22:00 with half-hour starts and whole-hour duration", () => {
  assert.deepEqual(defaultBookingPolicy, {
    timezone: "Asia/Shanghai",
    openingTime: "09:00",
    closingTime: "22:00",
    startIntervalMinutes: 30,
    minimumDurationMinutes: 60,
    durationStepMinutes: 60,
    maximumDurationMinutes: 240,
    version: 1,
  });

  assert.deepEqual(validateBookingWindow(DATE, "09:30", "11:30"), {
    date: DATE,
    startTime: "09:30",
    endTime: "11:30",
    durationMinutes: 120,
    cellKeys: ["0930", "1000", "1030", "1100"],
  });
  assert.equal(
    bookingWindowSessionId(DATE, "09:30", "11:30"),
    `${DATE}__window-v2-0930-1130`,
  );
});

test("booking windows reject outside hours, off-grid starts and non-whole-hour durations", () => {
  for (const [startTime, endTime] of [
    ["08:30", "09:30"],
    ["21:30", "22:30"],
    ["09:15", "10:15"],
    ["09:00", "09:30"],
    ["09:00", "10:30"],
    ["09:00", "14:00"],
  ]) {
    assert.throws(() => validateBookingWindow(DATE, startTime, endTime), /INVALID_INPUT/);
  }
});

test("availability exposes half-hour starts and only windows allowed by the duration policy", async () => {
  const { service } = setup();
  const result = await service.listWindowAvailability(DATE);

  assert.deepEqual(result.policy, defaultBookingPolicy);
  assert.equal(result.windows[0].startTime, "09:00");
  assert.equal(result.windows[0].endTime, "10:00");
  assert.ok(result.windows.some((window) => window.startTime === "09:30" && window.endTime === "13:30"));
  assert.ok(result.windows.some((window) => window.startTime === "21:00" && window.endTime === "22:00"));
  assert.equal(result.windows.some((window) => window.startTime === "21:30"), false);
  assert.equal(result.windows.some((window) => window.endTime > "22:00"), false);
});

test("multi-hour private bookings atomically reserve every half-hour cell on one court", async () => {
  const { repository, service } = setup();
  const first = await service.create(command());
  const second = await service.create(
    command({
      idempotencyKey: "window-request-2",
      startTime: "10:30",
      endTime: "12:30",
    }),
  );

  assert.equal(first.courtId, "01");
  assert.equal(second.courtId, "02", "an overlapping window must not reuse part of court 01");
  assert.equal(first.sessionId, `${DATE}__window-v2-0930-1130`);
  assert.equal(first.startAt, "2099-01-01T01:30:00.000Z");
  assert.equal(first.endAt, "2099-01-01T03:30:00.000Z");

  const inventory = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, ["01", "02"]),
  );
  assert.deepEqual(
    inventory.find((item) => item.courtId === "01").cells,
    Object.fromEntries(
      inventoryCellKeys("09:30", "11:30").map((key) => [
        key,
        { mode: "private", occupiedPlayers: 2, bookingIds: [first.id] },
      ]),
    ),
  );
});

test("open booking capacity is checked across the complete window without splitting courts", async () => {
  const { service } = setup();
  const first = await service.create(command({ mode: "open", partySize: 3 }));
  const second = await service.create(
    command({
      idempotencyKey: "window-open-2",
      mode: "open",
      partySize: 2,
      startTime: "10:30",
      endTime: "12:30",
    }),
  );

  assert.equal(first.courtId, "01");
  assert.equal(second.courtId, "02");
  const target = (await service.listWindowAvailability(DATE)).windows.find(
    (window) => window.startTime === "10:30" && window.endTime === "11:30",
  );
  assert.equal(target.privateCourtCount, 9);
  assert.deepEqual(target.acceptsOpenPartySizes, [1, 2, 3, 4]);
});

test("cancelling a window booking releases all reserved cells for reuse", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command());
  await service.cancel({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorType: "staff",
    actorId: "staff-1",
  });

  const [inventory] = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, [booking.courtId]),
  );
  assert.deepEqual(inventory.cells, {});
  const replacement = await service.create(command({ idempotencyKey: "replacement-window" }));
  assert.equal(replacement.courtId, booking.courtId);
});

test("legacy one-hour clients and v2 windows share the same daily inventory", async () => {
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0900", startTime: "09:00", endTime: "10:00", enabled: true, version: 1 },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    ids(),
    phoneHasher(),
  );
  const legacy = await service.create({
    ...command(),
    idempotencyKey: "legacy-window-bridge",
    sessionId: `${DATE}__slot-0900`,
    date: undefined,
    startTime: undefined,
    endTime: undefined,
  });
  const window = await service.create(
    command({
      idempotencyKey: "v2-after-legacy",
      startTime: "09:30",
      endTime: "10:30",
    }),
  );

  assert.equal(legacy.courtId, "01");
  assert.equal(window.courtId, "02");
});

test("reassign and complete preserve v2 inventory lifecycle semantics", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command());
  const reassigned = await service.reassign({
    bookingId: booking.id,
    courtId: "02",
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  assert.equal(reassigned.courtId, "02");
  let inventories = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, ["01", "02"]),
  );
  assert.deepEqual(inventories.find((item) => item.courtId === "01").cells, {});
  assert.equal(Object.keys(inventories.find((item) => item.courtId === "02").cells).length, 4);

  const confirmed = await service.confirm({
    bookingId: booking.id,
    expectedVersion: reassigned.version,
    actorId: "staff-1",
  });
  await service.complete({
    bookingId: booking.id,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });
  inventories = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, ["02"]),
  );
  assert.deepEqual(inventories[0].cells, {});
});

test("v2 reschedule acceptance moves the complete multi-hour inventory window", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command());
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorId: "staff-1",
    date: DATE,
    startTime: "12:30",
    endTime: "14:30",
  });
  assert.equal(proposal.proposedSessionId, `${DATE}__window-v2-1230-1430`);

  const accepted = await service.respondToReschedule({
    bookingId: booking.id,
    expectedVersion: proposal.version,
    actorType: "customer",
    accept: true,
  });
  assert.equal(accepted.sessionId, `${DATE}__window-v2-1230-1430`);
  assert.equal(accepted.startAt, "2099-01-01T04:30:00.000Z");
  const [inventory] = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, [accepted.courtId]),
  );
  for (const key of ["0930", "1000", "1030", "1100"]) {
    assert.equal(inventory.cells[key], undefined);
  }
  for (const key of ["1230", "1300", "1330", "1400"]) {
    assert.deepEqual(inventory.cells[key].bookingIds, [booking.id]);
  }
});

test("an overlapping open reschedule never aliases one booking id in the same court cells", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "open", partySize: 2 }));
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorId: "staff-1",
    date: DATE,
    startTime: "10:30",
    endTime: "12:30",
  });

  assert.equal(booking.courtId, "01");
  assert.equal(proposal.proposedCourtId, "02");
  const accepted = await service.respondToReschedule({
    bookingId: booking.id,
    expectedVersion: proposal.version,
    actorType: "customer",
    accept: true,
  });
  const inventories = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, ["01", "02"]),
  );
  assert.deepEqual(inventories.find((item) => item.courtId === "01").cells, {});
  assert.deepEqual(
    Object.keys(inventories.find((item) => item.courtId === "02").cells).sort(),
    ["1030", "1100", "1130", "1200"],
  );
  assert.equal(accepted.courtId, "02");
});

test("v2 create rejects a window whose Beijing start time has arrived", async () => {
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2099-01-01T01:30:00.000Z") },
    ids(),
    phoneHasher(),
  );
  await assert.rejects(() => service.create(command()), /SESSION_CLOSED/);
});

test("cancelling an unmigrated legacy booking releases legacy allocation without inventing cells", async () => {
  const booking = seededBooking();
  const repository = new MemoryBookingRepository({
    bookings: [booking],
    allocations: [
      {
        id: `${booking.sessionId}__court-01`,
        sessionId: booking.sessionId,
        courtId: "01",
        mode: "private",
        occupiedPlayers: 2,
        bookingIds: [booking.id],
        version: 1,
      },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    ids(),
    phoneHasher(),
  );
  await service.cancel({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorType: "staff",
    actorId: "staff-1",
  });

  assert.deepEqual(
    await repository.runTransaction((transaction) =>
      transaction.getCourtDayInventories(DATE, ["01"]),
    ),
    [],
  );
  const [allocation] = await repository.runTransaction((transaction) =>
    transaction.getAllocations(booking.sessionId, ["01"]),
  );
  assert.deepEqual(allocation.bookingIds, []);
});

test("a v2 lifecycle mutation fails closed when required inventory ownership is missing", async () => {
  const booking = seededBooking({
    sessionId: `${DATE}__window-v2-0930-1130`,
    startAt: "2099-01-01T01:30:00.000Z",
    endAt: "2099-01-01T03:30:00.000Z",
  });
  const repository = new MemoryBookingRepository({ bookings: [booking] });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    ids(),
    phoneHasher(),
  );

  await assert.rejects(
    () =>
      service.cancel({
        bookingId: booking.id,
        expectedVersion: booking.version,
        actorType: "staff",
        actorId: "staff-1",
      }),
    /CONFLICT/,
  );
  assert.equal((await repository.getBookingById(booking.id)).status, "pending");
});

test("concurrent overlapping v2 private bookings never share a court", async () => {
  const { service } = setup();
  const bookings = await Promise.all(
    Array.from({ length: 11 }, (_, index) =>
      service.create(command({ idempotencyKey: `concurrent-window-${index}` })),
    ),
  );
  assert.deepEqual(
    bookings.map((booking) => booking.courtId),
    courtIds,
  );
  await assert.rejects(
    () => service.create(command({ idempotencyKey: "concurrent-window-full" })),
    /SESSION_FULL/,
  );
});

test("a late v2 create failure rolls back booking and every daily cell", async () => {
  const repository = new MemoryBookingRepository({
    bookingInventoryV2Ready: true,
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    fault: { operation: "enqueueNotification", times: 1 },
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    ids(),
    phoneHasher(),
  );
  await assert.rejects(() => service.create(command()), /INJECTED_FAILURE/);
  assert.deepEqual(await repository.listBookings({}), []);
  assert.deepEqual(
    await repository.runTransaction((transaction) =>
      transaction.getCourtDayInventories(DATE, courtIds),
    ),
    [],
  );
});

test("v2 availability and create fail closed until migration readiness is verified", async () => {
  const repository = new MemoryBookingRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0900", startTime: "09:00", endTime: "10:00", enabled: true, version: 1 },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    ids(),
    phoneHasher(),
  );

  assert.deepEqual((await service.listWindowAvailability(DATE)).windows, []);
  await assert.rejects(() => service.create(command()), /SESSION_CLOSED/);
  const legacy = await service.create({
    ...command(),
    idempotencyKey: "legacy-before-ready",
    sessionId: `${DATE}__slot-0900`,
    date: undefined,
    startTime: undefined,
    endTime: undefined,
  });
  assert.equal(legacy.courtId, "01");
  const [inventory] = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, ["01"]),
  );
  assert.deepEqual(Object.keys(inventory.cells).sort(), ["0900", "0930"]);
});
