import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  BookingService,
  allocationId,
  bookingCodeId,
  courtIds,
} from "../lib/booking/booking-service.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";

const FUTURE_DATE = "2099-01-01";
const NEXT_DATE = "2099-01-02";
const MORNING = `${FUTURE_DATE}__slot-0700`;
const LATER = `${FUTURE_DATE}__slot-0800`;
const NEXT_LATER = `${NEXT_DATE}__slot-0800`;

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

function bookingRecord(overrides = {}) {
  return {
    id: "seed-booking",
    code: "SEEDCODE",
    sessionId: MORNING,
    date: FUTURE_DATE,
    startAt: "2098-12-31T23:00:00.000Z",
    endAt: "2099-01-01T00:00:00.000Z",
    courtId: "01",
    mode: "private",
    partySize: 2,
    status: "pending",
    name: "Seed Player",
    phone: "13800138000",
    phoneHash: "seed-phone-hash",
    privacyConsentAt: "2098-12-01T00:00:00.000Z",
    canCancelUntil: "2098-12-31T23:00:00.000Z",
    createdAt: "2098-12-01T00:00:00.000Z",
    updatedAt: "2098-12-01T00:00:00.000Z",
    version: 1,
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

function phoneHasher(salt = "test-phone-salt") {
  return {
    hash: (phone) => createHmac("sha256", salt).update(phone).digest("hex"),
  };
}

function provisionedSessionTemplates() {
  return Array.from({ length: 16 }, (_, index) => {
    const startHour = index + 7;
    const endHour = startHour + 1;
    return {
      id: `slot-${String(startHour).padStart(2, "0")}00`,
      startTime: `${String(startHour).padStart(2, "0")}:00`,
      endTime: `${String(endHour).padStart(2, "0")}:00`,
      enabled: true,
      version: 1,
    };
  });
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
    service: new BookingService(repository, clock, testIds(), phoneHasher(options.phoneSalt)),
  };
}

test("fresh provision seeds expose every slot before the first booking", async () => {
  const { repository, service } = setup({
    sessionTemplates: provisionedSessionTemplates(),
  });

  const fresh = await service.listAvailability(FUTURE_DATE);

  assert.equal(fresh.length, 16);
  assert.deepEqual(fresh[0], {
    sessionId: MORNING,
    date: FUTURE_DATE,
    startTime: "07:00",
    endTime: "08:00",
    openCapacity: 44,
    acceptsOpenPartySizes: [1, 2, 3, 4],
    privateCourtCount: 11,
    acceptsOpen: true,
    acceptsPrivate: true,
  });
  assert.equal(fresh.at(-1).sessionId, `${FUTURE_DATE}__slot-2200`);

  const booking = await service.create(command({ mode: "private" }));
  assert.equal(booking.sessionId, MORNING);
  assert.equal(booking.courtId, "01");
  assert.equal((await service.listAvailability(FUTURE_DATE))[0].privateCourtCount, 10);
  assert.equal((await repository.listBookings({})).length, 1);
});

test("availability racing first create prefers the stored capacity without duplicates", async () => {
  let releaseAvailability;
  let reportSessionsRead;
  const availabilityReleased = new Promise((resolve) => {
    releaseAvailability = resolve;
  });
  const sessionsRead = new Promise((resolve) => {
    reportSessionsRead = resolve;
  });
  class RacingRepository extends MemoryBookingRepository {
    async listSessions(date) {
      const snapshot = await super.listSessions(date);
      reportSessionsRead();
      return snapshot;
    }

    async listAvailability(date) {
      await availabilityReleased;
      return super.listAvailability(date);
    }
  }
  const repository = new RacingRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    testIds(),
    phoneHasher(),
  );

  const availability = service.listAvailability(FUTURE_DATE);
  await sessionsRead;
  await service.create(command({ mode: "private" }));
  releaseAvailability();

  const slots = await availability;
  assert.equal(slots.length, 1);
  assert.equal(slots[0].sessionId, MORNING);
  assert.equal(slots[0].openCapacity, 40);
  assert.equal(slots[0].privateCourtCount, 10);
});

test("session dates reject normalized invalid days and accept a real leap day", async () => {
  const { service } = setup({ now: new Date("2026-01-01T00:00:00.000Z") });

  for (const date of ["2026-02-29", "2026-02-31"]) {
    await assert.rejects(
      () =>
        service.create(
          command({
            idempotencyKey: `invalid-${date}`,
            sessionId: `${date}__slot-0700`,
          }),
        ),
      /INVALID_INPUT/,
    );
  }

  const leapDay = await service.create(
    command({
      idempotencyKey: "valid-leap-day",
      sessionId: "2028-02-29__slot-0700",
    }),
  );
  assert.equal(leapDay.date, "2028-02-29");
  assert.equal(leapDay.startAt, "2028-02-28T23:00:00.000Z");
});

async function getBooking(repository, id) {
  return repository.runTransaction((transaction) => transaction.getBooking(id));
}

async function getAllocation(repository, sessionId, courtId) {
  return repository.runTransaction(async (transaction) =>
    (await transaction.getAllocations(sessionId, [courtId]))[0] ?? null,
  );
}

test("create and lookup fail closed when no phone hasher is configured", async () => {
  const repository = new MemoryBookingRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    testIds(),
  );

  await assert.rejects(() => service.create(command()), /PHONE_HASHER_NOT_CONFIGURED/);
  await assert.rejects(() => service.lookup("TESTCODE", "13800138000"), /PHONE_HASHER_NOT_CONFIGURED/);
});

test("create fails closed before an idempotency replay when no phone hasher is configured", async () => {
  const configured = setup();
  await configured.service.create(command({ idempotencyKey: "existing-request" }));
  const unconfigured = new BookingService(
    configured.repository,
    configured.clock,
    testIds(),
  );

  await assert.rejects(
    () => unconfigured.create(command({ idempotencyKey: "existing-request" })),
    /PHONE_HASHER_NOT_CONFIGURED/,
  );
});

test("create stores a salted phone HMAC rather than a bare SHA-256 digest", async () => {
  const salt = "deployment-phone-salt";
  const { repository, service } = setup({ phoneSalt: salt });
  const created = await service.create(command());
  const stored = await getBooking(repository, created.id);
  const expected = createHmac("sha256", salt).update("13800138000").digest("hex");
  const bareDigest = createHash("sha256").update("13800138000").digest("hex");

  assert.equal(stored.phoneHash, expected);
  assert.notEqual(stored.phoneHash, bareDigest);
});

test("phone lookup succeeds only with the same HMAC salt", async () => {
  const { clock, repository, service } = setup({ phoneSalt: "salt-a" });
  const created = await service.create(command());
  const differentSalt = new BookingService(
    repository,
    clock,
    testIds(),
    phoneHasher("salt-b"),
  );

  assert.equal((await service.lookup(created.code, "138 0013 8000"))?.id, created.id);
  assert.equal(await differentSalt.lookup(created.code, "13800138000"), null);
});

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

test("staff reads versioned configuration and booking-scoped audit history", async () => {
  const { service } = setup();
  const created = await service.create(command());

  const [courts, templates, audits] = await Promise.all([
    service.listCourts(),
    service.listSessionTemplates(),
    service.listAuditLogs(created.id),
  ]);

  assert.equal(courts.length, 11);
  assert.deepEqual(templates.map(({ id, startTime, enabled, version }) => ({ id, startTime, enabled, version })), [
    { id: "slot-0700", startTime: "07:00", enabled: true, version: 1 },
    { id: "slot-0800", startTime: "08:00", enabled: true, version: 1 },
  ]);
  assert.deepEqual(audits.map((audit) => audit.bookingId), [created.id]);
});

test("staff scheduling reads all 704 pending bookings and cross-date proposals", async () => {
  const pending = Array.from({ length: 704 }, (_, index) => bookingRecord({
    id: `pending-${String(index).padStart(3, "0")}`,
    code: `PENDING${String(index).padStart(4, "0")}`,
  }));
  const proposal = bookingRecord({
    id: "cross-date-proposal",
    code: "CROSSDATE",
    status: "reschedule_proposed",
    proposedDate: NEXT_DATE,
    proposedSessionId: NEXT_LATER,
    proposedCourtId: "02",
  });
  const terminal = bookingRecord({
    id: "terminal-on-target-date",
    code: "TERMINAL",
    date: NEXT_DATE,
    sessionId: NEXT_LATER,
    status: "cancelled",
  });
  const service = new BookingService(new MemoryBookingRepository({
    bookings: [...pending, proposal, terminal],
  }));

  assert.equal((await service.listPendingBookings(FUTURE_DATE)).length, 704);
  assert.deepEqual(
    (await service.listMatrixBookings(NEXT_DATE)).map((booking) => booking.id),
    ["cross-date-proposal"],
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

test("a new booking enqueues independent staff and optional customer events", async () => {
  // Catches a single customer-addressed event replacing the mandatory staff notification.
  const withEmail = setup();
  const booking = await withEmail.service.create(command());
  const events = await withEmail.repository.listNotifications();

  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map(({ bookingId, kind, recipientType, status, attemptCount }) => ({
      bookingId,
      kind,
      recipientType,
      status,
      attemptCount,
    })),
    [
      {
        bookingId: booking.id,
        kind: "created",
        recipientType: "staff",
        status: "pending",
        attemptCount: 0,
      },
      {
        bookingId: booking.id,
        kind: "created",
        recipientType: "customer",
        status: "pending",
        attemptCount: 0,
      },
    ],
  );
  assert.notEqual(events[0].id, events[1].id);

  const withoutEmail = setup();
  const noEmailBooking = await withoutEmail.service.create(
    command({ email: undefined, idempotencyKey: "without-email" }),
  );
  assert.deepEqual(
    (await withoutEmail.repository.listNotifications()).map(
      ({ bookingId, kind, recipientType }) => ({ bookingId, kind, recipientType }),
    ),
    [{ bookingId: noEmailBooking.id, kind: "created", recipientType: "staff" }],
  );

  const whitespaceEmail = setup();
  const whitespaceBooking = await whitespaceEmail.service.create(
    command({ email: "   ", idempotencyKey: "whitespace-email" }),
  );
  assert.equal(whitespaceBooking.email, undefined);
  assert.deepEqual(
    (await whitespaceEmail.repository.listNotifications()).map(({ recipientType }) => recipientType),
    ["staff"],
  );
});

test("email-bearing lifecycle changes enqueue one customer event per communicable transition", async () => {
  // Catches lifecycle mail being addressed to staff or silently omitted.
  const { repository, service } = setup();
  const booking = await service.create(command());
  const confirmed = await service.confirm({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  const rejectedProposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });
  const rejected = await service.respondToReschedule({
    bookingId: booking.id,
    expectedVersion: rejectedProposal.version,
    accept: false,
    actorType: "customer",
  });
  const acceptedProposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: rejected.version,
    actorId: "staff-1",
  });
  const accepted = await service.respondToReschedule({
    bookingId: booking.id,
    expectedVersion: acceptedProposal.version,
    accept: true,
    actorType: "customer",
  });
  await service.cancel({
    bookingId: booking.id,
    expectedVersion: accepted.version,
    actorType: "customer",
  });

  assert.deepEqual(
    (await repository.listNotifications())
      .map(({ kind, recipientType }) => `${kind}:${recipientType}`)
      .sort(),
    [
      "cancelled:customer",
      "confirmed:customer",
      "created:customer",
      "created:staff",
      "reschedule_accepted:customer",
      "reschedule_proposed:customer",
      "reschedule_proposed:customer",
      "reschedule_rejected:customer",
    ],
  );
});

test("notification events carry only the version produced by their booking mutation", async () => {
  // Catches stale delivery ambiguity and accidental PII snapshots in the Outbox.
  const { repository, service } = setup();
  const created = await service.create(command());
  const confirmed = await service.confirm({
    bookingId: created.id,
    expectedVersion: created.version,
    actorId: "staff-1",
  });
  const proposal = await service.proposeReschedule({
    bookingId: created.id,
    sessionId: NEXT_LATER,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });
  const rejected = await service.respondToReschedule({
    bookingId: created.id,
    expectedVersion: proposal.version,
    accept: false,
    actorType: "customer",
  });

  const events = await repository.listNotifications();
  assert.deepEqual(
    events.map(({ kind, recipientType, bookingVersion }) => ({
      kind,
      recipientType,
      bookingVersion,
    })),
    [
      { kind: "created", recipientType: "staff", bookingVersion: created.version },
      { kind: "created", recipientType: "customer", bookingVersion: created.version },
      { kind: "confirmed", recipientType: "customer", bookingVersion: confirmed.version },
      {
        kind: "reschedule_proposed",
        recipientType: "customer",
        bookingVersion: proposal.version,
      },
      {
        kind: "reschedule_rejected",
        recipientType: "customer",
        bookingVersion: rejected.version,
      },
    ],
  );
  for (const event of events) {
    for (const forbidden of [
      "name",
      "email",
      "phone",
      "note",
      "code",
      "date",
      "startAt",
      "endAt",
      "courtId",
      "proposedDate",
    ]) {
      assert.equal(forbidden in event, false);
    }
  }
});

test("bookings without email never enqueue customer lifecycle events", async () => {
  // Catches attempts to deliver lifecycle mail without a customer recipient.
  const { repository, service } = setup();
  const booking = await service.create(command({ email: undefined }));
  const confirmed = await service.confirm({
    bookingId: booking.id,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });
  const restored = await service.respondToReschedule({
    bookingId: booking.id,
    expectedVersion: proposal.version,
    accept: false,
    actorType: "customer",
  });
  await service.cancel({
    bookingId: booking.id,
    expectedVersion: restored.version,
    actorType: "customer",
  });

  assert.deepEqual(
    (await repository.listNotifications()).map(({ kind, recipientType }) => ({
      kind,
      recipientType,
    })),
    [{ kind: "created", recipientType: "staff" }],
  );
});

test("completion and reassignment never enqueue notification events", async () => {
  // Catches internal-only transitions leaking into the customer mail channel.
  const { clock, repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const reassigned = await service.reassign({
    bookingId: booking.id,
    courtId: "02",
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  const confirmed = await service.confirm({
    bookingId: booking.id,
    expectedVersion: reassigned.version,
    actorId: "staff-1",
  });
  clock.set("2099-01-02T00:00:00.000Z");
  await service.complete({
    bookingId: booking.id,
    expectedVersion: confirmed.version,
    actorId: "staff-1",
  });

  assert.deepEqual(
    (await repository.listNotifications()).map(({ kind, recipientType }) => ({
      kind,
      recipientType,
    })),
    [
      { kind: "created", recipientType: "staff" },
      { kind: "created", recipientType: "customer" },
      { kind: "confirmed", recipientType: "customer" },
    ],
  );
});

test("failure of the second new-booking Outbox write rolls back every create write", async () => {
  // Catches staff and customer events being persisted in separate transactions.
  class FailSecondNotificationRepository extends MemoryBookingRepository {
    hasFailed = false;

    runTransaction(work) {
      return super.runTransaction((transaction) => {
        let notificationWrites = 0;
        const wrapped = new Proxy(transaction, {
          get: (target, property) => {
            if (property === "enqueueNotification") {
              return async (value) => {
                notificationWrites += 1;
                if (!this.hasFailed && notificationWrites === 2) {
                  this.hasFailed = true;
                  throw new Error("SECOND_NOTIFICATION_FAILURE");
                }
                return target.enqueueNotification(value);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return work(wrapped);
      });
    }
  }

  const repository = new FailSecondNotificationRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    testIds(),
    phoneHasher(),
  );

  await assert.rejects(() => service.create(command()), /SECOND_NOTIFICATION_FAILURE/);
  assert.deepEqual(await service.listBookings({}), []);
  assert.deepEqual(await repository.listNotifications(), []);
  assert.equal(
    await repository.runTransaction((transaction) => transaction.getSession(MORNING)),
    null,
  );
  assert.equal((await service.listAvailability(FUTURE_DATE))[0].openCapacity, 44);

  const retried = await service.create(command());
  assert.equal(retried.id, "booking-2");
  assert.deepEqual(
    (await repository.listNotifications()).map((event) => event.id),
    ["event-5", "event-6"],
  );
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

test("cross-date reschedule acceptance records and then clears the proposed date", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });

  assert.equal(proposal.status, "reschedule_proposed");
  assert.equal(proposal.proposalPreviousStatus, "pending");
  assert.equal(proposal.proposedDate, NEXT_DATE);
  assert.deepEqual((await getAllocation(repository, MORNING, booking.courtId)).bookingIds, [booking.id]);
  assert.deepEqual(
    (await getAllocation(repository, NEXT_LATER, proposal.proposedCourtId)).bookingIds,
    [booking.id],
  );

  const accepted = await service.respondToReschedule({
    bookingId: booking.id,
    accept: true,
    expectedVersion: proposal.version,
    actorType: "customer",
  });
  assert.equal(accepted.status, "confirmed");
  assert.equal(accepted.sessionId, NEXT_LATER);
  assert.equal(accepted.date, NEXT_DATE);
  assert.equal(accepted.proposedSessionId, undefined);
  assert.equal(accepted.proposedDate, undefined);
  assert.equal(accepted.proposalPreviousStatus, undefined);
  assert.deepEqual((await getAllocation(repository, MORNING, booking.courtId)).bookingIds, []);
  assert.deepEqual((await getAllocation(repository, NEXT_LATER, accepted.courtId)).bookingIds, [booking.id]);
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
  assert.equal(rejected.proposedDate, undefined);
  assert.equal(rejected.proposalPreviousStatus, undefined);
  assert.deepEqual(
    (await getAllocation(repository, LATER, proposal.proposedCourtId)).bookingIds,
    [],
  );
});

test("cancelling a proposed reschedule clears the proposed date", async () => {
  const { service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });

  const cancelled = await service.cancel({
    bookingId: booking.id,
    expectedVersion: proposal.version,
    actorType: "staff",
    actorId: "staff-1",
  });

  assert.equal(cancelled.proposedDate, undefined);
  assert.equal(cancelled.proposedSessionId, undefined);
});

test("accepting an in-flight legacy proposal derives its missing proposed date", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  await repository.runTransaction(async (transaction) => {
    const legacy = await transaction.getBooking(booking.id);
    delete legacy.proposedDate;
    await transaction.putBooking(legacy);
  });

  const accepted = await service.respondToReschedule({
    bookingId: booking.id,
    accept: true,
    expectedVersion: proposal.version,
    actorType: "customer",
  });

  assert.equal(accepted.date, NEXT_DATE);
  assert.equal(accepted.proposedDate, undefined);
});

test("staff confirm rejects a reschedule proposal without changing inventory or events", async () => {
  const { repository, service } = setup();
  const booking = await service.create(command({ mode: "private" }));
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: NEXT_LATER,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  const before = {
    booking: await getBooking(repository, booking.id),
    current: await getAllocation(repository, MORNING, booking.courtId),
    proposed: await getAllocation(repository, NEXT_LATER, proposal.proposedCourtId),
    audits: await repository.listAuditLogs(),
    notifications: await repository.listNotifications(),
  };

  await assert.rejects(
    () => service.confirm({
      bookingId: booking.id,
      expectedVersion: proposal.version,
      actorId: "staff-1",
    }),
    /INVALID_TRANSITION/,
  );

  assert.deepEqual(await getBooking(repository, booking.id), before.booking);
  assert.deepEqual(await getAllocation(repository, MORNING, booking.courtId), before.current);
  assert.deepEqual(
    await getAllocation(repository, NEXT_LATER, proposal.proposedCourtId),
    before.proposed,
  );
  assert.deepEqual(await repository.listAuditLogs(), before.audits);
  assert.deepEqual(await repository.listNotifications(), before.notifications);
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
  const { repository, service } = setup();
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
  const audit = (await repository.listAuditLogs()).find(
    (entry) => entry.action === "personal_data_redacted",
  );
  assert.equal(audit.actorId, "retention-worker");
  assert.equal(audit.actorType, "system");
  assert.deepEqual(audit.metadata, {});
});

test("memory admin redaction records an explicit staff audit without PII", async () => {
  const { repository, service } = setup();
  const created = await service.create(command());
  await service.redactPersonalData(created.id, "profile-staff-7", created.version, "staff");

  const audit = (await repository.listAuditLogs()).find(
    (entry) => entry.action === "personal_data_redacted",
  );
  assert.deepEqual(audit, {
    id: `redact-${created.id}-2`,
    bookingId: created.id,
    action: "personal_data_redacted",
    actorType: "staff",
    actorId: "profile-staff-7",
    at: audit.at,
    metadata: {},
  });
  assert.equal(JSON.stringify(audit).includes(created.phone), false);
  assert.equal(JSON.stringify(audit).includes(created.name), false);
});

test("memory booking listing applies inclusive export date ranges before the limit", async () => {
  const records = [
    bookingRecord({ id: "before", date: "2098-12-31", createdAt: "2098-12-01T00:00:00.000Z" }),
    bookingRecord({ id: "from", date: "2099-01-01", createdAt: "2098-12-03T00:00:00.000Z" }),
    bookingRecord({ id: "to", date: "2099-01-03", createdAt: "2098-12-02T00:00:00.000Z" }),
    bookingRecord({ id: "after", date: "2099-01-04", createdAt: "2098-12-04T00:00:00.000Z" }),
  ];
  const repository = new MemoryBookingRepository({ bookings: records });

  assert.deepEqual(
    (await repository.listBookings({ fromDate: "2099-01-01", toDate: "2099-01-03", limit: 2 }))
      .map((entry) => entry.id),
    ["from", "to"],
  );
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
