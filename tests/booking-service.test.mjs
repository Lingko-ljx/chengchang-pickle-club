import assert from "node:assert/strict";
import test from "node:test";
import {
  BookingService,
  allocationId,
  bookingCodeId,
  courtIds,
} from "../lib/booking/booking-service.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";

const FUTURE_DATE = "2099-01-01";
const MORNING = `${FUTURE_DATE}__slot-0700`;
const LATER = `${FUTURE_DATE}__slot-0800`;

function command(overrides = {}) {
  return {
    idempotencyKey: "request-001",
    sessionId: MORNING,
    mode: "open",
    partySize: 2,
    name: "Ada Lovelace",
    phone: "13800138000",
    email: "ada@example.com",
    note: "Window side if available",
    privacyConsent: true,
    ...overrides,
  };
}

function testIds() {
  let booking = 0;
  let code = 0;
  let event = 0;
  return {
    bookingId: () => `booking-${++booking}`,
    bookingCode: () => `TESTCODE${String(++code).padStart(24, "0")}`,
    eventId: () => `event-${++event}`,
  };
}

function setup(options = {}) {
  let now = options.now ?? new Date("2098-12-01T00:00:00.000Z");
  const clock = {
    now: () => new Date(now),
    set: (value) => {
      now = new Date(value);
    },
  };
  const repository = new MemoryBookingRepository({
    courts: courtIds.map((id) => ({ id, enabled: id !== options.disabledCourtId, version: 1 })),
    sessionTemplates:
      options.sessionTemplates ??
      [
        { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
        { id: "slot-0800", startTime: "08:00", endTime: "09:00", enabled: true, version: 1 },
      ],
    fault: options.fault,
  });
  return {
    clock,
    repository,
    service: new BookingService(repository, clock, testIds()),
  };
}

async function getBooking(repository, id) {
  return repository.runTransaction((transaction) => transaction.getBooking(id));
}

async function getAllocation(repository, sessionId, courtId) {
  return repository.runTransaction(async (transaction) =>
    (await transaction.getAllocations(sessionId, [courtId]))[0] ?? null,
  );
}

test("eleven private bookings fill eleven courts and the twelfth fails", async () => {
  const { service } = setup();
  for (let index = 0; index < 11; index += 1) {
    await service.create(command({ mode: "private", idempotencyKey: `private-${index}` }));
  }
  await assert.rejects(
    () => service.create(command({ mode: "private", idempotencyKey: "private-12" })),
    /SESSION_FULL/,
  );
});

test("forty-four single open bookings fill all courts", async () => {
  const { service } = setup();
  await Promise.all(
    Array.from({ length: 44 }, (_, index) =>
      service.create(command({ mode: "open", partySize: 1, idempotencyKey: `open-${index}` })),
    ),
  );
  await assert.rejects(
    () => service.create(command({ mode: "open", partySize: 1, idempotencyKey: "open-45" })),
    /SESSION_FULL/,
  );
});

test("repeating an idempotency key returns the original booking", async () => {
  const { service } = setup();
  const first = await service.create(command({ idempotencyKey: "same-request" }));
  const second = await service.create(command({ idempotencyKey: "same-request" }));
  assert.equal(second.id, first.id);
});

test("disabled courts are never assigned", async () => {
  const { service } = setup({ disabledCourtId: "01" });
  const bookings = [];
  for (let index = 0; index < 10; index += 1) {
    bookings.push(
      await service.create(command({ mode: "private", idempotencyKey: `enabled-${index}` })),
    );
  }
  assert.equal(bookings[0].courtId, "02");
  await assert.rejects(
    () => service.create(command({ mode: "private", idempotencyKey: "no-enabled-court" })),
    /SESSION_FULL/,
  );
});

test("first use snapshots a session and later template changes do not rewrite it", async () => {
  const { repository, service } = setup();
  const first = await service.create(command({ idempotencyKey: "snapshot-1" }));
  await service.setSessionTemplateEnabled("slot-0700", false, "staff-1", 1);
  const second = await service.create(command({ idempotencyKey: "snapshot-2" }));
  const snapshot = await repository.runTransaction((transaction) => transaction.getSession(MORNING));

  assert.equal(first.startAt, "2098-12-31T23:00:00.000Z");
  assert.equal(second.sessionId, MORNING);
  assert.equal(snapshot.templateId, "slot-0700");
  assert.equal(snapshot.startAt, "2098-12-31T23:00:00.000Z");
  await assert.rejects(
    () =>
      service.create(
        command({ sessionId: "2099-01-02__slot-0700", idempotencyKey: "disabled-new-date" }),
      ),
    /SESSION_CLOSED/,
  );
});

test("customer cancellation releases inventory and stamps terminalAt", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const cancelled = await service.cancel({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorType: "customer",
  });
  const replacement = await service.create(
    command({ mode: "private", idempotencyKey: "replacement" }),
  );

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.terminalAt, "2098-12-01T00:00:00.000Z");
  assert.equal(replacement.courtId, booking.courtId);
  const allocation = await getAllocation(repository, MORNING, booking.courtId);
  assert.deepEqual(allocation.bookingIds, [replacement.id]);
});

test("customer cancellation is refused once the session starts", async () => {
  const { clock, service } = setup();
  const booking = await service.create(command());
  clock.set(booking.startAt);
  await assert.rejects(
    () =>
      service.cancel({
        bookingId: booking.id,
        expectedVersion: booking.version,
        actorType: "customer",
      }),
    /SESSION_CLOSED/,
  );
});

test("reschedule acceptance retains both allocations until it releases the old one", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: LATER,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });

  assert.equal(proposal.status, "reschedule_proposed");
  assert.equal(proposal.proposalPreviousStatus, "pending");
  assert.deepEqual((await getAllocation(repository, MORNING, booking.courtId)).bookingIds, [booking.id]);
  assert.deepEqual(
    (await getAllocation(repository, LATER, proposal.proposedCourtId)).bookingIds,
    [booking.id],
  );

  const accepted = await service.respondToReschedule({
    bookingId: booking.id,
    accept: true,
    expectedVersion: proposal.version,
    actorType: "customer",
  });
  assert.equal(accepted.status, "confirmed");
  assert.equal(accepted.sessionId, LATER);
  assert.equal(accepted.proposedSessionId, undefined);
  assert.equal(accepted.proposalPreviousStatus, undefined);
  assert.deepEqual((await getAllocation(repository, MORNING, booking.courtId)).bookingIds, []);
  assert.deepEqual((await getAllocation(repository, LATER, accepted.courtId)).bookingIds, [booking.id]);
});

test("reschedule rejection releases the proposal and restores exactly the previous status", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const confirmed = await service.confirm({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: LATER,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });
  const rejected = await service.respondToReschedule({
    bookingId: booking.id,
    accept: false,
    expectedVersion: proposal.version,
    actorType: "customer",
  });

  assert.equal(rejected.status, "confirmed");
  assert.equal(rejected.sessionId, MORNING);
  assert.equal(rejected.proposedCourtId, undefined);
  assert.equal(rejected.proposalPreviousStatus, undefined);
  assert.deepEqual(
    (await getAllocation(repository, LATER, proposal.proposedCourtId)).bookingIds,
    [],
  );
});

test("completion stamps terminalAt once and terminal records cannot mutate", async () => {
  const { clock, repository, service } = setup();
  const booking = await service.create(command());
  const confirmed = await service.confirm({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  clock.set("2099-01-02T00:00:00.000Z");
  const completed = await service.complete({
    bookingId: booking.id,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });
  await assert.rejects(
    () =>
      service.complete({
        bookingId: booking.id,
        expectedVersion: completed.version,
        actorId: "staff-1",
      }),
    /INVALID_TRANSITION/,
  );
  assert.equal(
    (await getBooking(repository, booking.id)).terminalAt,
    "2099-01-02T00:00:00.000Z",
  );
  const allocation = await getAllocation(repository, MORNING, booking.courtId);
  assert.deepEqual(allocation.bookingIds, []);
  assert.equal(allocation.occupiedPlayers, 0);
  assert.equal(allocation.mode, "empty");
});

test("stale lifecycle versions fail before changing the booking", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command());
  await assert.rejects(
    () => service.confirm({ bookingId: booking.id, expectedVersion: 0, actorId: "staff-1" }),
    /CONFLICT/,
  );
  assert.deepEqual(await getBooking(repository, booking.id), booking);
});

test("lookup requires the normalized reserved phone", async () => {
  const { service } = setup();
  const booking = await service.create(command({ phone: "138 0013-8000" }));

  assert.equal(
    (await service.lookup(`  ${booking.code.toLowerCase()} `, "13800138000")).id,
    booking.id,
  );
  assert.equal(await service.lookup(booking.code, "13900139000"), null);
  assert.equal(await service.lookup(booking.code), null);
});

test("redaction removes personal lookup data at the expected version", async () => {
  const { service } = setup();
  const booking = await service.create(command());
  const cancelled = await service.cancel({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorType: "staff",
    actorId: "staff-1",
  });
  await service.redactPersonalData(cancelled.id, "retention-worker", cancelled.version);
  assert.equal(await service.lookup(booking.code, booking.phone), null);
  const redacted = (await service.listBookings({ query: booking.id }))[0];
  assert.equal(redacted.name, undefined);
  assert.equal(redacted.phone, undefined);
  assert.equal(redacted.email, undefined);
  assert.ok(redacted.personalDataRedactedAt);
});

test("stale redaction versions fail before deleting personal lookup data", async () => {
  const { service } = setup();
  const booking = await service.create(command());
  const cancelled = await service.cancel({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorType: "staff",
    actorId: "staff-1",
  });

  await assert.rejects(
    () => service.redactPersonalData(cancelled.id, "retention-worker", booking.version),
    /CONFLICT/,
  );
  assert.equal((await service.lookup(booking.code, booking.phone)).id, booking.id);
});

test("stale court-management versions fail before changing availability", async () => {
  const { repository, service } = setup();
  await assert.rejects(
    () => service.setCourtEnabled("01", false, "staff-1", 0),
    /CONFLICT/,
  );
  assert.deepEqual(
    await repository.runTransaction((transaction) => transaction.getCourts(["01"])),
    [{ id: "01", enabled: true, version: 1 }],
  );
  await service.setCourtEnabled("01", false, "staff-1", 1);
  assert.deepEqual(
    await repository.runTransaction((transaction) => transaction.getCourts(["01"])),
    [{ id: "01", enabled: false, version: 2 }],
  );
});

test("stale template-management versions fail before disabling a template", async () => {
  const { repository, service } = setup();
  await assert.rejects(
    () => service.setSessionTemplateEnabled("slot-0700", false, "staff-1", 0),
    /CONFLICT/,
  );
  assert.deepEqual(
    await repository.runTransaction((transaction) => transaction.getSessionTemplate("slot-0700")),
    { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
  );
  await service.setSessionTemplateEnabled("slot-0700", false, "staff-1", 1);
  assert.deepEqual(
    await repository.runTransaction((transaction) => transaction.getSessionTemplate("slot-0700")),
    { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: false, version: 2 },
  );
});

test("configuration writes roll back when their required audit cannot be appended", async () => {
  // Catches memory configuration updates being committed separately from staff audit records.
  const courtSetup = setup({ fault: { operation: "appendAudit", times: 1 } });
  await assert.rejects(
    () => courtSetup.service.setCourtEnabled("01", false, "profile-staff-7", 1),
    /INJECTED_FAILURE:appendAudit/,
  );
  assert.deepEqual(
    await courtSetup.repository.runTransaction((transaction) => transaction.getCourts(["01"])),
    [{ id: "01", enabled: true, version: 1 }],
  );

  const templateSetup = setup({ fault: { operation: "appendAudit", times: 1 } });
  await assert.rejects(
    () =>
      templateSetup.service.setSessionTemplateEnabled(
        "slot-0700",
        false,
        "profile-staff-7",
        1,
      ),
    /INJECTED_FAILURE:appendAudit/,
  );
  assert.deepEqual(
    await templateSetup.repository.runTransaction((transaction) =>
      transaction.getSessionTemplate("slot-0700"),
    ),
    { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
  );
});

test("session snapshots reject every template that is not exactly sixty minutes", async () => {
  const malformedTemplates = [
    { id: "slot-0700", startTime: "07:00", endTime: "07:30", enabled: true, version: 1 },
    { id: "slot-0700", startTime: "07:00", endTime: "08:30", enabled: true, version: 1 },
    { id: "slot-0700", startTime: "08:00", endTime: "07:00", enabled: true, version: 1 },
  ];
  for (const [index, template] of malformedTemplates.entries()) {
    const { service } = setup({ sessionTemplates: [template] });
    await assert.rejects(
      () => service.create(command({ idempotencyKey: `malformed-${index}` })),
      /SESSION_CLOSED/,
    );
  }
});

test("a late Outbox failure rolls back every transactional create write", async () => {
  const { repository, service } = setup({
    fault: { operation: "enqueueNotification", times: 1 },
  });

  await assert.rejects(() => service.create(command()), /INJECTED_FAILURE/);
  assert.equal(await service.lookup("TESTCODE000000000000000000000001", "13800138000"), null);
  assert.deepEqual(await service.listBookings({}), []);
  assert.equal(
    await repository.runTransaction((transaction) => transaction.getSession(MORNING)),
    null,
  );
  assert.equal(await getAllocation(repository, MORNING, "01"), null);

  const retried = await service.create(command());
  assert.equal(retried.id, "booking-2");
  assert.equal(retried.courtId, "01");
  assert.deepEqual((await getAllocation(repository, MORNING, "01")).bookingIds, ["booking-2"]);
});

test("reassign moves a booking to a specifically enabled empty court", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const reassigned = await service.reassign({
    bookingId: booking.id,
    courtId: "02",
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  assert.equal(reassigned.courtId, "02");
  assert.deepEqual((await getAllocation(repository, MORNING, "01")).bookingIds, []);
  assert.deepEqual((await getAllocation(repository, MORNING, "02")).bookingIds, [booking.id]);
});

test("availability and admin listing reflect repository state", async () => {
  const { service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const slots = await service.listAvailability(FUTURE_DATE);
  const bookings = await service.listBookings({ date: FUTURE_DATE, status: "pending" });
  assert.equal(slots[0].startTime, "07:00");
  assert.equal(slots[0].endTime, "08:00");
  assert.equal(slots[0].privateCourtCount, 10);
  assert.equal(slots[0].openCapacity, 40);
  assert.deepEqual(bookings.map((item) => item.id), [booking.id]);
});

test("identifier helpers use canonical deterministic document keys", () => {
  assert.equal(allocationId(MORNING, "01"), `${MORNING}__court-01`);
  assert.equal(
    bookingCodeId(" ab-cd "),
    "07d0e0e2c86f9e99c2a4c12144acc4fcbe7cf38e92f9d43c01219bf2a8d52da6",
  );
  assert.deepEqual(courtIds, ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]);
});
