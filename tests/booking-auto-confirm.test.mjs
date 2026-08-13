import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BookingService, courtIds } from "../lib/booking/booking-service.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";

const DATE = "2099-01-01";

function identifiers() {
  let booking = 0;
  let code = 0;
  let event = 0;
  return {
    bookingId: () => `booking-${++booking}`,
    bookingCode: () => `AUTOCONFIRM${String(++code).padStart(5, "0")}`,
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
      hash: (phone) => createHmac("sha256", "auto-confirm-test").update(phone).digest("hex"),
    },
  );
  return { repository, service };
}

function command(overrides = {}) {
  return {
    idempotencyKey: "auto-confirm-request",
    date: DATE,
    startTime: "09:30",
    endTime: "10:30",
    mode: "private",
    partySize: 2,
    name: "刘栖睿",
    phone: "13800138000",
    privacyConsent: true,
    publicScheduleConsentVersion: 1,
    ...overrides,
  };
}

test("an inventory-backed customer booking is confirmed atomically and remains cancellable", async () => {
  const { repository, service } = setup();

  const created = await service.create(command());
  assert.equal(created.status, "confirmed");
  assert.equal(created.version, 1);
  assert.equal(created.publicScheduleConsentVersion, 1);
  assert.equal(created.publicScheduleConsentAt, created.privacyConsentAt);
  assert.deepEqual(
    (await repository.listAuditLogs(created.id)).map(
      ({ action, actorType, fromStatus, toStatus }) => ({ action, actorType, fromStatus, toStatus }),
    ),
    [{ action: "created", actorType: "system", fromStatus: undefined, toStatus: "confirmed" }],
  );

  const replayed = await service.create(command());
  assert.deepEqual(replayed, created);
  assert.equal((await repository.listBookings({ archive: "all" })).length, 1);

  const cancelled = await service.cancel({
    bookingId: created.id,
    expectedVersion: created.version,
    actorType: "customer",
  });
  assert.equal(cancelled.status, "cancelled");
  const [released] = await repository.runTransaction((transaction) =>
    transaction.getCourtDayInventories(DATE, [created.courtId]),
  );
  assert.deepEqual(released.cells, {});

  const replayedAfterCancellation = await service.create(command());
  assert.equal(replayedAfterCancellation.status, "cancelled");
  assert.equal(replayedAfterCancellation.id, created.id);
});

test("staff can still confirm a legacy pending booking after auto-confirm rollout", async () => {
  const legacy = {
    id: "legacy-pending",
    code: "LEGACYCODE",
    sessionId: `${DATE}__window-0930-1030`,
    date: DATE,
    startAt: "2099-01-01T01:30:00.000Z",
    endAt: "2099-01-01T02:30:00.000Z",
    courtId: "01",
    mode: "private",
    partySize: 2,
    status: "pending",
    name: "历史客人",
    phone: "13800138000",
    phoneHash: "legacy-phone-hash",
    privacyConsentAt: "2098-11-01T00:00:00.000Z",
    canCancelUntil: "2099-01-01T01:30:00.000Z",
    createdAt: "2098-11-01T00:00:00.000Z",
    updatedAt: "2098-11-01T00:00:00.000Z",
    version: 3,
  };
  const repository = new MemoryBookingRepository({ bookings: [legacy] });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    identifiers(),
    { hash: () => "legacy-phone-hash" },
  );

  const confirmed = await service.confirm({
    bookingId: legacy.id,
    expectedVersion: legacy.version,
    actorId: "staff-1",
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.version, 4);
});

test("a legacy client can book without retroactively consenting to public name display", async () => {
  const { service } = setup();
  const created = await service.create(command({
    idempotencyKey: "legacy-client-no-public-consent",
    publicScheduleConsentVersion: undefined,
  }));

  assert.equal(created.status, "confirmed");
  assert.equal(created.publicScheduleConsentVersion, undefined);
  assert.equal(created.publicScheduleConsentAt, undefined);
});

test("v2 name visibility choice is stored atomically and survives idempotency replay", async () => {
  const { service } = setup();
  const requested = command({
    idempotencyKey: "v2-hide-public-name",
    publicScheduleConsentVersion: 2,
    hidePublicName: true,
  });

  const created = await service.create(requested);
  assert.equal(created.publicScheduleConsentVersion, 2);
  assert.equal(created.hidePublicName, true);
  assert.equal(created.publicScheduleConsentAt, created.privacyConsentAt);
  assert.deepEqual(await service.create(requested), created);
});
