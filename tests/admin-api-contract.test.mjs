import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BookingService, courtIds, decodeBookingCursor } from "../lib/booking/booking-service.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";
import { createAdminApiHandler } from "../cloudbase/src/admin-api.ts";

const DATE = "2099-01-01";
const MORNING = `${DATE}__slot-0700`;
const LATER = `${DATE}__slot-0800`;
const TRUSTED_UID = "2086466604197666817";

function event(method, path, body, overrides = {}) {
  return {
    httpMethod: method,
    path,
    headers: {
      ...(overrides.authorization === false ? {} : { Authorization: "Bearer forged-contract-canary" }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(overrides.query ? { queryStringParameters: overrides.query } : {}),
    ...(overrides.identity ? { requestContext: { authorizer: overrides.identity } } : {}),
  };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

function runtimeUid(uid, trace = []) {
  return async (context) => {
    trace.push({ type: "auth", context });
    return uid;
  };
}

function booking(overrides = {}) {
  return {
    id: "booking-1",
    code: "ADMINCODE1",
    idempotencyKeyHash: "internal-idempotency-hash",
    sessionId: MORNING,
    date: DATE,
    startAt: "2098-12-31T23:00:00.000Z",
    endAt: "2099-01-01T00:00:00.000Z",
    courtId: "01",
    mode: "private",
    partySize: 2,
    status: "pending",
    name: "Ada, \"Ace\"\r\nLovelace",
    phone: "13800138000",
    phoneHash: "internal-phone-hash",
    email: "=send@example.com",
    note: "  +formula\nsecond line",
    privacyConsentAt: "2098-12-01T00:00:00.000Z",
    canCancelUntil: "2098-12-31T23:00:00.000Z",
    createdAt: "2098-12-01T00:00:00.000Z",
    updatedAt: "2098-12-01T00:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

function fakeService(trace = []) {
  const record = booking();
  const invoke = (name, result = record) => async (...args) => {
    trace.push({ type: "service", name, args });
    return result;
  };
  return {
    createStaffReservation: invoke("createStaffReservation", booking({
      bookingKind: "staff_reservation",
      staffReservationTitle: "单位包场",
      status: "confirmed",
    })),
    updateStaffReservation: invoke("updateStaffReservation", booking({
      bookingKind: "staff_reservation",
      staffReservationTitle: "单位包场（已改）",
      status: "confirmed",
      version: 4,
    })),
    confirm: invoke("confirm", booking({ status: "confirmed", version: 4 })),
    proposeReschedule: invoke(
      "proposeReschedule",
      booking({ status: "reschedule_proposed", version: 4 }),
    ),
    cancel: invoke("cancel", booking({ status: "cancelled", version: 4 })),
    complete: invoke("complete", booking({ status: "completed", version: 4 })),
    reassign: invoke("reassign", booking({ courtId: "02", version: 4 })),
    redactPersonalData: invoke("redactPersonalData", undefined),
    archiveBooking: invoke("archiveBooking", booking({ status: "cancelled", archivedAt: "2098-12-02T00:00:00.000Z", version: 4 })),
    restoreBooking: invoke("restoreBooking", booking({ status: "cancelled", version: 5 })),
    listAvailability: invoke("listAvailability", [{ sessionId: MORNING }]),
    listBookings: invoke("listBookings", [record]),
    listBookingPage: undefined,
    listCustomerHistory: invoke("listCustomerHistory", [record]),
    listPendingBookings: invoke("listPendingBookings", [record]),
    listMatrixBookings: invoke("listMatrixBookings", [booking({
      id: "booking-proposal",
      proposedDate: DATE,
      proposedSessionId: MORNING,
      proposedCourtId: "02",
      status: "reschedule_proposed",
    })]),
    listCourtTimeBlockDay: invoke("listCourtTimeBlockDay", {
      items: [], inventoryVersions: { "01": 0 },
    }),
    createCourtTimeBlocks: invoke("createCourtTimeBlocks", [{
      id: "block-1", date: DATE, courtId: "01", startTime: "09:00", endTime: "09:30",
      cellKeys: ["0900"], reason: "维护", createdAt: "2098-12-01T00:00:00.000Z",
      createdBy: TRUSTED_UID, updatedAt: "2098-12-01T00:00:00.000Z", updatedBy: TRUSTED_UID,
      version: 1,
    }]),
    updateCourtTimeBlock: invoke("updateCourtTimeBlock", {
      id: "block-1", date: DATE, courtId: "01", startTime: "09:30", endTime: "10:00",
      cellKeys: ["0930"], createdAt: "2098-12-01T00:00:00.000Z", createdBy: TRUSTED_UID,
      updatedAt: "2098-12-02T00:00:00.000Z", updatedBy: TRUSTED_UID, version: 2,
    }),
    restoreCourtTimeBlock: invoke("restoreCourtTimeBlock", undefined),
    listCourts: invoke("listCourts", [{ id: "01", enabled: false, version: 7 }]),
    listSessionTemplates: invoke("listSessionTemplates", [{ id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 4 }]),
    listAuditLogs: invoke("listAuditLogs", [{ id: "audit-1", bookingId: record.id, action: "confirmed", actorType: "staff", actorId: "private-staff-id", at: "2098-12-02T00:00:00.000Z", metadata: { phone: "13800138000" } }]),
    setCourtEnabled: invoke("setCourtEnabled", undefined),
    setSessionTemplateEnabled: invoke("setSessionTemplateEnabled", undefined),
  };
}

function handlerFor(service, options = {}) {
  const uid = Object.hasOwn(options, "uid") ? options.uid : TRUSTED_UID;
  return createAdminApiHandler({
    service,
    resolveTrustedUid: options.resolveTrustedUid ?? runtimeUid(uid, options.trace),
    allowedUserIds: options.allowedUserIds ?? [TRUSTED_UID],
    ...(options.mediaService ? { mediaService: options.mediaService } : {}),
  });
}

test("missing and malformed trusted runtime UIDs return sanitized 401 responses before service work", async () => {
  const trace = [];
  const service = fakeService(trace);
  const missing = await handlerFor(service, { trace, uid: undefined })(
    event("GET", "/v1/admin/bookings"),
  );
  const rejected = await handlerFor(service, { trace, uid: "not-a-runtime-uid" })(
    event("GET", "/v1/admin/bookings"),
  );

  assert.equal(missing.statusCode, 401);
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(responseBody(rejected), {
    error: { code: "AUTH_REQUIRED", message: "Authentication required", retryable: false },
  });
  assert.equal(rejected.body.includes("not-a-runtime-uid"), false);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});

test("homepage media admin routes require the trusted UID and keep private response headers", async () => {
  const calls = [];
  const mediaService = {
    async listAdmin() {
      calls.push("listAdmin");
      return { version: 3, items: [] };
    },
  };
  const allowed = await handlerFor(fakeService(), { mediaService })(
    event("GET", "/v1/admin/homepage-media"),
  );
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers["Cache-Control"], "no-store, private");
  assert.deepEqual(responseBody(allowed).data, { version: 3, items: [] });
  assert.deepEqual(calls, ["listAdmin"]);

  const forbidden = await handlerFor(fakeService(), {
    mediaService,
    uid: "2086466604197666818",
    allowedUserIds: [TRUSTED_UID],
  })(event("GET", "/v1/admin/homepage-media"));
  assert.equal(forbidden.statusCode, 403);
  assert.deepEqual(calls, ["listAdmin"]);
});

test("protected settings and booking audit routes expose versioned, non-PII DTOs", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });

  const settings = await handler(event("GET", "/v1/admin/settings"));
  const audits = await handler(event("GET", "/v1/admin/bookings/booking-1/audit-logs"));

  assert.equal(settings.statusCode, 200);
  assert.deepEqual(responseBody(settings).data, {
    courts: [{ id: "01", enabled: false, version: 7 }],
    sessionTemplates: [{ id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 4 }],
    bookingPolicy: {
      timezone: "Asia/Shanghai",
      openingTime: "09:00",
      closingTime: "22:00",
      startIntervalMinutes: 30,
      minimumDurationMinutes: 60,
      durationStepMinutes: 60,
      maximumDurationMinutes: 240,
      version: 1,
    },
  });
  assert.deepEqual(responseBody(audits).data, [{
    id: "audit-1",
    action: "confirmed",
    actorType: "staff",
    at: "2098-12-02T00:00:00.000Z",
  }]);
  assert.equal(audits.body.includes("private-staff-id"), false);
  assert.equal(audits.body.includes("13800138000"), false);
});

test("non-allowlisted runtime UIDs return 403 and never enter the booking service", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), {
    trace,
    uid: "2086466604197666818",
  });

  const response = await handler(
    event("POST", "/v1/admin/bookings/booking-1/confirm", { expectedVersion: 3 }),
  );

  assert.equal(response.statusCode, 403);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});

test("an exact free-tier allowlisted runtime UID enters service", async () => {
  const trace = [];
  const userId = TRUSTED_UID;
  const handler = handlerFor(fakeService(trace), {
    trace,
    uid: userId,
    allowedUserIds: [userId],
  });

  const response = await handler(event("GET", "/v1/admin/bookings"));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    trace.map(({ type, name }) => ({ type, ...(name ? { name } : {}) })),
    [{ type: "auth" }, { type: "service", name: "listBookings" }],
  );
});

test("an empty or merely similar free-tier allowlist fails before service", async () => {
  for (const allowedUserIds of [[], ["20864666041976668170"]]) {
    const trace = [];
    const handler = handlerFor(fakeService(trace), {
      trace,
      uid: TRUSTED_UID,
      allowedUserIds,
    });

    const response = await handler(event("GET", "/v1/admin/bookings"));
    assert.equal(response.statusCode, 403);
    assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
  }
});

test("role-like forged event data cannot replace the exact runtime UID allowlist", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), {
    trace,
    uid: "2086466604197666818",
    allowedUserIds: [],
  });

  const response = await handler(event("GET", "/v1/admin/bookings", undefined, {
    identity: { uid: TRUSTED_UID, groups: ["booking_staff"] },
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});

test("every admin success, error, and CSV response disables shared caching", async () => {
  const successHandler = handlerFor(fakeService());
  const forbiddenHandler = handlerFor(fakeService(), {
    uid: "2086466604197666818",
    allowedUserIds: ["999999999999999999"],
  });
  const responses = [
    await successHandler(event("GET", "/v1/admin/bookings")),
    await forbiddenHandler(event("GET", "/v1/admin/bookings")),
    await successHandler(
      event("GET", "/v1/admin/export.csv", undefined, {
        query: { from: DATE, to: DATE },
      }),
    ),
  ];

  assert.deepEqual(
    responses.map(({ statusCode }) => statusCode),
    [200, 403, 200],
  );
  for (const response of responses) {
    assert.equal(response.headers["Cache-Control"], "no-store, private");
    assert.equal(response.headers.Pragma, "no-cache");
  }
  assert.match(responses[2].headers["Content-Type"], /^text\/csv/);
});

test("trusted runtime UID resolution rejects body identity spoofing before service work", async () => {
  const trace = [];
  const service = fakeService(trace);
  const handler = handlerFor(service, { trace });
  const context = { request_id: "runtime-context-canary" };

  const response = await handler(
    event(
      "POST",
      "/v1/admin/bookings/booking-1/confirm",
      { expectedVersion: 3, actorId: "body-attacker", groups: [{ id: "booking_staff" }] },
      { identity: { user_id: "gateway-attacker", groups: ["booking_staff"] } },
    ),
    context,
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(trace, [
    {
      type: "auth",
      context,
    },
  ]);
  assert.equal(response.body.includes("internal-phone-hash"), false);
  assert.equal(response.body.includes("internal-idempotency-hash"), false);
});

test("every booking lifecycle route requires a version and passes the authenticated actor", async () => {
  const cases = [
    ["confirm", "/confirm", { expectedVersion: 3 }, { bookingId: "booking-1", expectedVersion: 3, actorId: TRUSTED_UID }],
    ["proposeReschedule", "/reschedule", { expectedVersion: 3, sessionId: LATER }, { bookingId: "booking-1", expectedVersion: 3, sessionId: LATER, actorId: TRUSTED_UID }],
    ["cancel", "/cancel", { expectedVersion: 3 }, { bookingId: "booking-1", expectedVersion: 3, actorType: "staff", actorId: TRUSTED_UID }],
    ["complete", "/complete", { expectedVersion: 3 }, { bookingId: "booking-1", expectedVersion: 3, actorId: TRUSTED_UID }],
    ["reassign", "/reassign", { expectedVersion: 3, courtId: "02" }, { bookingId: "booking-1", expectedVersion: 3, courtId: "02", actorId: TRUSTED_UID }],
  ];

  for (const [methodName, suffix, body, expected] of cases) {
    const trace = [];
    const handler = handlerFor(fakeService(trace), { trace });
    const response = await handler(event("POST", `/v1/admin/bookings/booking-1${suffix}`, body));
    assert.equal(response.statusCode, 200, methodName);
    const call = trace.find((entry) => entry.type === "service");
    assert.equal(call.name, methodName);
    assert.deepEqual(call.args, Array.isArray(expected) ? expected : [expected]);

    const missingVersion = await handler(
      event("POST", `/v1/admin/bookings/booking-1${suffix}`, { ...body, expectedVersion: undefined }),
    );
    assert.equal(missingVersion.statusCode, 400, `${methodName} version guard`);
  }
});

test("court and template writes require versions and carry the trusted runtime UID", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });

  assert.equal(
    (await handler(event("PUT", "/v1/admin/courts/01", { enabled: false, expectedVersion: 5 }))).statusCode,
    200,
  );
  assert.equal(
    (await handler(event("PUT", "/v1/admin/session-templates/slot-0700", { enabled: true, expectedVersion: 6 }))).statusCode,
    200,
  );

  const calls = trace.filter((entry) => entry.type === "service");
  assert.deepEqual(calls[0], {
    type: "service",
    name: "setCourtEnabled",
    args: ["01", false, TRUSTED_UID, 5],
  });
  assert.deepEqual(calls[1], {
    type: "service",
    name: "setSessionTemplateEnabled",
    args: ["slot-0700", true, TRUSTED_UID, 6],
  });
});

test("dashboard, matrix and booking-list routes use their exact scheduling reads", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });

  const dashboard = await handler(event("GET", "/v1/admin/dashboard", undefined, { query: { date: DATE } }));
  const matrix = await handler(event("GET", "/v1/admin/matrix", undefined, { query: { date: DATE } }));
  const listing = await handler(event("GET", "/v1/admin/bookings", undefined, {
    query: { date: DATE, status: "pending", mode: "private", q: "Ada" },
  }));

  assert.equal(dashboard.statusCode, 200);
  assert.deepEqual(responseBody(dashboard).data.date, DATE);
  assert.equal(matrix.statusCode, 200);
  assert.equal(responseBody(matrix).data.bookings[0].proposedDate, DATE);
  assert.deepEqual(responseBody(matrix).data.inventoryVersions, { "01": 0 });
  assert.equal(listing.statusCode, 200);
  const calls = trace.filter((entry) => entry.type === "service");
  assert.deepEqual(calls.map((entry) => [entry.name, entry.args]), [
    ["listPendingBookings", [DATE]],
    ["listAvailability", [DATE]],
    ["listMatrixBookings", [DATE]],
    ["listCourtTimeBlockDay", [DATE]],
    ["listBookings", [{ date: DATE, status: "pending", mode: "private", query: "Ada", archive: "active", limit: 51 }]],
  ]);
  assert.equal(listing.body.includes("internal-phone-hash"), false);
  assert.equal(listing.body.includes("internal-idempotency-hash"), false);
});

test("booking records expose bounded range pagination and recoverable archive mutations", async () => {
  const trace = [];
  const service = fakeService(trace);
  const rows = Array.from({ length: 3 }, (_, index) => booking({ id: `booking-${index + 1}` }));
  service.listBookings = async (filter) => {
    trace.push({ type: "service", name: "listBookings", args: [filter] });
    return rows;
  };
  const handler = handlerFor(service, { trace });

  const listing = await handler(event("GET", "/v1/admin/bookings", undefined, {
    query: {
      from: "2098-12-01",
      to: DATE,
      archive: "archived",
      cursor: Buffer.from(JSON.stringify(["2098-12-01", "2098-12-01T00:00:00.000Z", "booking-0"])).toString("base64url"),
      limit: "2",
      q: "Ada",
    },
  }));
  assert.equal(listing.statusCode, 200);
  assert.deepEqual(responseBody(listing).data, {
    items: rows.slice(0, 2).map((item) => {
      const projected = structuredClone(item);
      delete projected.phoneHash;
      delete projected.idempotencyKeyHash;
      projected.displayCode = item.phone.slice(-4);
      return projected;
    }),
    nextCursor: responseBody(listing).data.nextCursor,
    hasMore: true,
  });
  assert.deepEqual(decodeBookingCursor(responseBody(listing).data.nextCursor), {
    date: rows[1].date,
    createdAt: rows[1].createdAt,
    id: rows[1].id,
  });
  assert.deepEqual(trace.find(({ name }) => name === "listBookings").args, [{
    fromDate: "2098-12-01",
    toDate: DATE,
    query: "Ada",
    archive: "archived",
    cursor: Buffer.from(JSON.stringify(["2098-12-01", "2098-12-01T00:00:00.000Z", "booking-0"])).toString("base64url"),
    limit: 3,
  }]);

  const archived = await handler(event("POST", "/v1/admin/bookings/booking-1/archive", { expectedVersion: 3 }));
  const restored = await handler(event("POST", "/v1/admin/bookings/booking-1/restore", { expectedVersion: 4 }));
  assert.equal(archived.statusCode, 200);
  assert.equal(responseBody(archived).data.archivedAt, "2098-12-02T00:00:00.000Z");
  assert.equal(restored.statusCode, 200);
  assert.equal(responseBody(restored).data.archivedAt, undefined);
  assert.deepEqual(
    trace.filter(({ name }) => name === "archiveBooking" || name === "restoreBooking").map(({ name, args }) => [name, args]),
    [
      ["archiveBooking", ["booking-1", TRUSTED_UID, 3]],
      ["restoreBooking", ["booking-1", TRUSTED_UID, 4]],
    ],
  );
});

test("customer history is booking-scoped so no phone number enters the URL", async () => {
  const trace = [];
  const response = await handlerFor(fakeService(trace), { trace })(
    event("GET", "/v1/admin/bookings/booking-1/customer-history", undefined, { query: { limit: "25" } }),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(responseBody(response).data.items[0].name, 'Ada, "Ace"\r\nLovelace');
  assert.deepEqual(
    trace.find(({ name }) => name === "listCustomerHistory").args,
    ["booking-1", 25],
  );
});

test("booking pagination rejects unsafe or ambiguous filters before service work", async () => {
  for (const query of [
    { date: DATE, from: DATE },
    { from: DATE, to: "2098-12-01" },
    { archive: "deleted" },
    { archive: "archived" },
    { q: "Ada" },
    { limit: "0" },
    { limit: "101" },
    { limit: 50 },
    { q: " " },
    { cursor: "bad\u0000cursor" },
  ]) {
    const trace = [];
    const response = await handlerFor(fakeService(trace), { trace })(
      event("GET", "/v1/admin/bookings", undefined, { query }),
    );
    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.equal(trace.some(({ type }) => type === "service"), false);
  }
});

test("booking mutations reject unknown fields and duplicate aliases before service work", async () => {
  for (const [path, body] of [
    ["/confirm", { expectedVersion: 3, extra: true }],
    ["/confirm", { expectedVersion: 3, expected_version: 3 }],
    ["/reschedule", { expectedVersion: 3, sessionId: LATER, session_id: LATER }],
    ["/reassign", { expectedVersion: 3, courtId: "02", court_id: "02" }],
  ]) {
    const trace = [];
    const response = await handlerFor(fakeService(trace), { trace })(
      event("POST", `/v1/admin/bookings/booking-1${path}`, body),
    );
    assert.equal(response.statusCode, 400, path);
    assert.equal(trace.some(({ type }) => type === "service"), false);
  }
});

test("court time block API lists, creates, edits and restores strict non-PII closures", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });
  const listed = await handler(event("GET", "/v1/admin/court-time-blocks", undefined, {
    query: { date: DATE },
  }));
  const created = await handler(event("POST", "/v1/admin/court-time-blocks", {
    date: DATE,
    courtIds: ["01"],
    startTime: "09:00",
    endTime: "09:30",
    reason: "维护",
    expectedVersions: { "01": 0 },
  }));
  const updated = await handler(event("PUT", "/v1/admin/court-time-blocks/block-1", {
    date: DATE,
    courtId: "01",
    startTime: "09:30",
    endTime: "10:00",
    expectedVersion: 1,
  }));
  const restored = await handler(event("DELETE", "/v1/admin/court-time-blocks/block-1", {
    date: DATE,
    courtId: "01",
    expectedVersion: 2,
  }));
  assert.equal(listed.statusCode, 200);
  assert.equal(created.statusCode, 201);
  assert.equal(updated.statusCode, 200);
  assert.equal(restored.statusCode, 200);
  assert.deepEqual(
    trace.filter(({ name }) => /CourtTimeBlock/.test(name)).map(({ name, args }) => [name, args]),
    [
      ["listCourtTimeBlockDay", [DATE]],
      ["createCourtTimeBlocks", [{
        date: DATE, courtIds: ["01"], startTime: "09:00", endTime: "09:30", reason: "维护",
        expectedVersions: { "01": 0 }, actorId: TRUSTED_UID,
      }]],
      ["updateCourtTimeBlock", [{
        blockId: "block-1", date: DATE, courtId: "01", startTime: "09:30", endTime: "10:00",
        expectedVersion: 1, actorId: TRUSTED_UID,
      }]],
      ["restoreCourtTimeBlock", [{
        blockId: "block-1", date: DATE, courtId: "01", expectedVersion: 2, actorId: TRUSTED_UID,
      }]],
    ],
  );
  assert.equal(created.body.includes(TRUSTED_UID), false);
});

test("court time block API rejects unknown, forged and malformed fields before service work", async () => {
  for (const [method, path, body, query] of [
    ["GET", "/v1/admin/court-time-blocks", undefined, { date: DATE, extra: "x" }],
    ["POST", "/v1/admin/court-time-blocks", {
      date: DATE, courtIds: ["01"], startTime: "09:00", endTime: "09:30",
      expectedVersions: { "01": 0 }, actorId: "attacker",
    }],
    ["POST", "/v1/admin/court-time-blocks", {
      date: DATE, courtIds: ["01"], startTime: "09:00", endTime: "09:30",
      expectedVersions: { "01": "0" },
    }],
    ["PUT", "/v1/admin/court-time-blocks/block-1", {
      date: DATE, courtId: "01", startTime: "09:00", endTime: "09:30",
      expectedVersion: 1, expected_version: 1,
    }],
  ]) {
    const trace = [];
    const response = await handlerFor(fakeService(trace), { trace })(
      event(method, path, body, query ? { query } : {}),
    );
    assert.equal(response.statusCode, 400, `${method} ${path}`);
    assert.equal(trace.some(({ type }) => type === "service"), false);
  }
});

test("bootstrap authenticates once, runs all same-day reads concurrently, and reuses the dashboard", async () => {
  const trace = [];
  const service = fakeService(trace);
  const serviceMethods = [
    "listPendingBookings",
    "listAvailability",
    "listBookings",
    "listMatrixBookings",
    "listCourtTimeBlockDay",
    "listCourts",
    "listSessionTemplates",
  ];
  let started = 0;
  for (const name of serviceMethods) {
    const original = service[name];
    service[name] = (...args) => {
      const result = original(...args);
      started += 1;
      return Promise.resolve().then(async () => {
        assert.equal(started, serviceMethods.length, "bootstrap reads must start together");
        return result;
      });
    };
  }
  const handler = handlerFor(service, { trace });

  const response = await handler(event("GET", "/v1/admin/bootstrap", undefined, {
    query: { today: DATE, date: DATE, status: "pending", mode: "private", q: "Ada" },
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(trace.filter((entry) => entry.type === "auth").length, 1);
  assert.deepEqual(
    trace.filter((entry) => entry.type === "service").map((entry) => [entry.name, entry.args]),
    [
      ["listPendingBookings", [DATE]],
      ["listAvailability", [DATE]],
      ["listBookings", [{ date: DATE, status: "pending", mode: "private", query: "Ada", limit: 100 }]],
      ["listMatrixBookings", [DATE]],
      ["listCourtTimeBlockDay", [DATE]],
      ["listCourts", []],
      ["listSessionTemplates", []],
    ],
  );
  const data = responseBody(response).data;
  assert.equal(data.todayDashboard.date, DATE);
  assert.deepEqual(data.selectedDashboard, data.todayDashboard);
  assert.equal(data.bookings[0].code, "ADMINCODE1");
  assert.equal(data.bookings[0].displayCode, "8000");
  assert.equal(data.matrixBookings.bookings[0].proposedDate, DATE);
  assert.deepEqual(data.matrixBookings.inventoryVersions, { "01": 0 });
  assert.deepEqual(data.settings, {
    courts: [{ id: "01", enabled: false, version: 7 }],
    sessionTemplates: [{ id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 4 }],
    bookingPolicy: {
      timezone: "Asia/Shanghai",
      openingTime: "09:00",
      closingTime: "22:00",
      startIntervalMinutes: 30,
      minimumDurationMinutes: 60,
      durationStepMinutes: 60,
      maximumDurationMinutes: 240,
      version: 1,
    },
  });
  assert.equal(response.headers["Cache-Control"], "no-store, private");
  assert.equal(response.body.includes("internal-phone-hash"), false);
  assert.equal(response.body.includes("internal-idempotency-hash"), false);
});

test("bootstrap rejects a missing trusted runtime UID before any service read", async () => {
  const trace = [];
  const response = await handlerFor(fakeService(trace), {
    trace,
    uid: undefined,
  })(event("GET", "/v1/admin/bootstrap", undefined, {
    query: { today: DATE, date: DATE },
  }));

  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["Cache-Control"], "no-store, private");
  assert.equal(trace.filter((entry) => entry.type === "auth").length, 1);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});

test("bootstrap preserves distinct today and selected-date semantics", async () => {
  const selectedDate = "2099-01-02";
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });

  const response = await handler(event("GET", "/v1/admin/bootstrap", undefined, {
    query: { today: DATE, date: selectedDate },
  }));

  assert.equal(response.statusCode, 200);
  const data = responseBody(response).data;
  assert.equal(data.todayDashboard.date, DATE);
  assert.equal(data.selectedDashboard.date, selectedDate);
  assert.deepEqual(
    trace.filter((entry) => entry.type === "service").map((entry) => [entry.name, entry.args]),
    [
      ["listPendingBookings", [DATE]],
      ["listAvailability", [DATE]],
      ["listPendingBookings", [selectedDate]],
      ["listAvailability", [selectedDate]],
      ["listBookings", [{ date: selectedDate, limit: 100 }]],
      ["listMatrixBookings", [selectedDate]],
      ["listCourtTimeBlockDay", [selectedDate]],
      ["listCourts", []],
      ["listSessionTemplates", []],
    ],
  );
});

test("bootstrap strictly validates today, date, status, mode and q before service reads", async () => {
  const invalidQueries = [
    { date: DATE },
    { today: DATE },
    { today: "2099-02-29", date: DATE },
    { today: DATE, date: "2099-02-29" },
    { today: DATE, date: DATE, status: "unknown" },
    { today: DATE, date: DATE, status: " " },
    { today: DATE, date: DATE, mode: "group" },
    { today: DATE, date: DATE, q: " " },
    { today: DATE, date: DATE, q: "A".repeat(101) },
    { today: DATE, date: DATE, q: "Ada\u0000Lovelace" },
    { today: DATE, date: DATE, q: 42 },
    { today: DATE, date: DATE, extra: "unexpected" },
  ];
  for (const query of invalidQueries) {
    const trace = [];
    const response = await handlerFor(fakeService(trace), {
      trace,
    })(event("GET", "/v1/admin/bootstrap", undefined, { query }));
    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.deepEqual(responseBody(response), {
      error: { code: "INVALID_INPUT", message: "Invalid request", retryable: false },
    });
    assert.equal(trace.filter((entry) => entry.type === "auth").length, 1);
    assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
  }
});

test("CSV export uses a strict column allowlist, neutralizes formulas, and escapes RFC-style fields", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });
  const response = await handler(event("GET", "/v1/admin/export.csv", undefined, {
    query: { from: DATE, to: DATE },
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/csv; charset=utf-8");
  assert.match(response.headers["Content-Disposition"], /^attachment;/);
  assert.match(response.body, /"Ada, ""Ace""\r\nLovelace"/);
  assert.match(response.body, /"  '\+formula\nsecond line"/);
  assert.match(response.body, /'=send@example\.com/);
  assert.deepEqual(
    trace.find((entry) => entry.type === "service"),
    {
      type: "service",
      name: "listBookings",
      args: [{ fromDate: DATE, toDate: DATE, archive: "all", limit: 500 }],
    },
  );
  for (const forbidden of [
    "internal-phone-hash",
    "internal-idempotency-hash",
    "token",
    "idempotency",
    "phone_hash",
  ]) {
    assert.equal(response.body.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("CSV export returns a detectable hard-cap error at 500 rows and completely emits 499", async () => {
  const rows = Array.from({ length: 500 }, (_, index) =>
    booking({ id: `booking-${index}`, code: `CODE${index}`, name: `Player ${index}` }),
  );
  const cappedService = fakeService();
  cappedService.listBookings = async () => rows;
  const capped = await handlerFor(cappedService)(
    event("GET", "/v1/admin/export.csv", undefined, { query: { from: DATE, to: DATE } }),
  );
  assert.equal(capped.statusCode, 409);
  assert.deepEqual(responseBody(capped), {
    error: {
      code: "EXPORT_TOO_LARGE",
      message: "Export too large; narrow the date range",
      retryable: false,
    },
  });
  assert.equal(capped.headers["Content-Type"], "application/json; charset=utf-8");

  const completeService = fakeService();
  completeService.listBookings = async () => rows.slice(0, 499);
  const complete = await handlerFor(completeService)(
    event("GET", "/v1/admin/export.csv", undefined, { query: { from: DATE, to: DATE } }),
  );
  assert.equal(complete.statusCode, 200);
  assert.equal(complete.body.split("\r\n").filter(Boolean).length, 500);
  assert.match(complete.body, /CODE498/);
});

function realSetup(trace) {
  let eventId = 0;
  const repository = new MemoryBookingRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
      { id: "slot-0800", startTime: "08:00", endTime: "09:00", enabled: true, version: 1 },
    ],
  });
  const service = new BookingService(
    repository,
    { now: () => new Date("2098-12-01T00:00:00.000Z") },
    {
      bookingId: () => "booking-real",
      bookingCode: () => "REALADMINCODE",
      eventId: () => `event-${++eventId}`,
    },
    {
      hash: (phone) =>
        createHmac("sha256", "admin-contract-phone-salt")
          .update(phone)
          .digest("hex"),
    },
  );
  return { repository, service, handler: handlerFor(service, { trace }) };
}

test("stale admin mutation returns 409 without changing repository state", async () => {
  const trace = [];
  const { repository, service, handler } = realSetup(trace);
  const created = await service.create({
    idempotencyKey: "admin-real-create",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "Grace Hopper",
    phone: "13800138000",
    email: "grace@example.com",
    note: "retain me",
    privacyConsent: true,
  });

  const response = await handler(
    event("POST", `/v1/admin/bookings/${created.id}/confirm`, { expectedVersion: 0 }),
  );
  const stored = await repository.runTransaction((transaction) => transaction.getBooking(created.id));

  assert.equal(response.statusCode, 409);
  assert.deepEqual(stored, created);
  assert.equal(trace[0].type, "auth");
});

test("manual admin redaction is not exposed and leaves personal data untouched", async () => {
  const trace = [];
  const { repository, service, handler } = realSetup(trace);
  const created = await service.create({
    idempotencyKey: "admin-redact-create",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "Personal Name",
    phone: "13800138000",
    email: "person@example.com",
    note: "private note",
    privacyConsent: true,
  });
  const cancelled = await service.cancel({
    bookingId: created.id,
    expectedVersion: created.version,
    actorType: "staff",
    actorId: "setup-staff",
  });

  const response = await handler(
    event("POST", `/v1/admin/bookings/${created.id}/redact`, { expectedVersion: cancelled.version }),
  );
  const stored = await repository.runTransaction((transaction) => transaction.getBooking(created.id));

  assert.equal(response.statusCode, 404);
  assert.notEqual(await service.lookup(created.code, created.phone), null);
  assert.equal(stored.name, cancelled.name);
  assert.equal(stored.phone, cancelled.phone);
  assert.equal(stored.phoneHash, cancelled.phoneHash);
  assert.equal(stored.email, cancelled.email);
  assert.equal(stored.note, cancelled.note);
  assert.equal(stored.idempotencyKeyHash, cancelled.idempotencyKeyHash);
  assert.equal(stored.code, created.code);
  assert.equal(stored.courtId, created.courtId);
  assert.equal(stored.status, "cancelled");
  assert.equal(
    (await repository.listAuditLogs()).some((entry) => entry.action === "personal_data_redacted"),
    false,
  );
});

test("CSV describes staff reservations as full-court occupancy with an unknown headcount", async () => {
  const service = fakeService();
  service.listBookings = async () => [booking({
    bookingKind: "staff_reservation",
    staffReservationTitle: "周三企业活动",
    partySize: 4,
    name: undefined,
    phone: undefined,
    email: undefined,
    privacyConsentAt: undefined,
  })];
  const response = await handlerFor(service)(event(
    "GET",
    "/v1/admin/export.csv",
    undefined,
    { query: { from: DATE, to: DATE } },
  ));

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"booking_kind"/);
  assert.match(response.body, /"staff_reservation"/);
  assert.match(response.body, /"整场占用"/);
  assert.match(response.body, /"人数未登记"/);
  assert.match(response.body, /"周三企业活动"/);
  assert.doesNotMatch(response.body, /,"4",/);
});

test("manual admin redaction remains unavailable regardless of supplied version", async () => {
  const trace = [];
  const { repository, service, handler } = realSetup(trace);
  const created = await service.create({
    idempotencyKey: "admin-stale-redact",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "Keep Personal",
    phone: "13800138000",
    privacyConsent: true,
  });
  const before = await repository.runTransaction((transaction) =>
    transaction.getBooking(created.id),
  );
  const auditsBefore = await repository.listAuditLogs();

  const response = await handler(
    event("POST", `/v1/admin/bookings/${created.id}/redact`, { expectedVersion: 0 }),
  );

  assert.equal(response.statusCode, 404);
  assert.deepEqual(
    await repository.runTransaction((transaction) => transaction.getBooking(created.id)),
    before,
  );
  assert.deepEqual(await repository.listAuditLogs(), auditsBefore);
});

test("stale court and template handler writes preserve records and audits", async () => {
  const trace = [];
  const { repository, handler } = realSetup(trace);
  const beforeAudits = await repository.listAuditLogs();

  const staleCourt = await handler(
    event("PUT", "/v1/admin/courts/01", { enabled: false, expectedVersion: 0 }),
  );
  const staleTemplate = await handler(
    event("PUT", "/v1/admin/session-templates/slot-0700", {
      enabled: false,
      expectedVersion: 0,
    }),
  );
  assert.equal(staleCourt.statusCode, 409);
  assert.equal(staleTemplate.statusCode, 409);
  assert.deepEqual(
    await repository.runTransaction((transaction) => transaction.getCourts(["01"])),
    [{ id: "01", enabled: true, version: 1 }],
  );
  assert.deepEqual(
    await repository.runTransaction((transaction) =>
      transaction.getSessionTemplate("slot-0700"),
    ),
    { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
  );
  assert.deepEqual(await repository.listAuditLogs(), beforeAudits);

  assert.equal(
    (await handler(event("PUT", "/v1/admin/courts/01", { enabled: false, expectedVersion: 1 })))
      .statusCode,
    200,
  );
  const audit = (await repository.listAuditLogs()).find(
    (entry) => entry.action === "court_enabled_changed",
  );
  assert.equal(audit.actorId, TRUSTED_UID);
  assert.equal(audit.actorType, "staff");
  assert.deepEqual(audit.metadata, {
    entity: "court",
    id: "01",
    enabled: false,
    version: 2,
  });
  assert.equal(
    (
      await handler(
        event("PUT", "/v1/admin/session-templates/slot-0700", {
          enabled: false,
          expectedVersion: 1,
        }),
      )
    ).statusCode,
    200,
  );
  const templateAudit = (await repository.listAuditLogs()).find(
    (entry) => entry.action === "session_template_enabled_changed",
  );
  assert.equal(templateAudit.actorId, TRUSTED_UID);
  assert.equal(templateAudit.actorType, "staff");
});

test("only the documented route shapes are accepted", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace });
  const response = await handler(
    event("POST", "/v1/admin/bookings/booking-1/confirm/extra", { expectedVersion: 3 }),
  );
  assert.equal(response.statusCode, 404);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});
