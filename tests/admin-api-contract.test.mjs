import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { BookingService, courtIds } from "../lib/booking/booking-service.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";
import { createAdminApiHandler } from "../cloudbase/src/admin-api.ts";

const DATE = "2099-01-01";
const MORNING = `${DATE}__slot-0700`;
const LATER = `${DATE}__slot-0800`;
const TOKEN = "Bearer admin-contract-secret-token";

function event(method, path, body, overrides = {}) {
  return {
    httpMethod: method,
    path,
    headers: {
      ...(overrides.authorization === false ? {} : { Authorization: TOKEN }),
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

function authFetch(groups = [{ id: "booking_staff" }], trace = []) {
  return async (url, init) => {
    trace.push({ type: "auth", url, authorization: init?.headers?.Authorization });
    return {
      ok: true,
      async json() {
        return { user_id: "profile-staff-7", groups, name: "Complete profile fixture" };
      },
    };
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
    confirm: invoke("confirm", booking({ status: "confirmed", version: 4 })),
    proposeReschedule: invoke(
      "proposeReschedule",
      booking({ status: "reschedule_proposed", version: 4 }),
    ),
    cancel: invoke("cancel", booking({ status: "cancelled", version: 4 })),
    complete: invoke("complete", booking({ status: "completed", version: 4 })),
    reassign: invoke("reassign", booking({ courtId: "02", version: 4 })),
    redactPersonalData: invoke("redactPersonalData", undefined),
    listAvailability: invoke("listAvailability", [{ sessionId: MORNING }]),
    listBookings: invoke("listBookings", [record]),
    listPendingBookings: invoke("listPendingBookings", [record]),
    listMatrixBookings: invoke("listMatrixBookings", [booking({
      id: "booking-proposal",
      proposedDate: DATE,
      proposedSessionId: MORNING,
      proposedCourtId: "02",
      status: "reschedule_proposed",
    })]),
    listCourts: invoke("listCourts", [{ id: "01", enabled: false, version: 7 }]),
    listSessionTemplates: invoke("listSessionTemplates", [{ id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 4 }]),
    listAuditLogs: invoke("listAuditLogs", [{ id: "audit-1", bookingId: record.id, action: "confirmed", actorType: "staff", actorId: "private-staff-id", at: "2098-12-02T00:00:00.000Z", metadata: { phone: "13800138000" } }]),
    setCourtEnabled: invoke("setCourtEnabled", undefined),
    setSessionTemplateEnabled: invoke("setSessionTemplateEnabled", undefined),
  };
}

function handlerFor(service, options = {}) {
  return createAdminApiHandler({
    service,
    fetch: options.fetch ?? authFetch(undefined, options.trace),
    envId: "booking-test-env",
  });
}

test("missing and rejected bearer tokens return sanitized 401 responses before service work", async () => {
  const trace = [];
  const service = fakeService(trace);
  const handler = handlerFor(service, {
    trace,
    fetch: async () => {
      throw new Error(`upstream exposed ${TOKEN}`);
    },
  });

  const missing = await handler(event("GET", "/v1/admin/bookings", undefined, { authorization: false }));
  const rejected = await handler(event("GET", "/v1/admin/bookings"));

  assert.equal(missing.statusCode, 401);
  assert.equal(rejected.statusCode, 401);
  assert.deepEqual(responseBody(rejected), {
    error: { code: "AUTH_REQUIRED", message: "Authentication required", retryable: false },
  });
  assert.equal(rejected.body.includes(TOKEN), false);
  assert.deepEqual(trace, []);
});

test("protected settings and booking audit routes expose versioned, non-PII DTOs", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace, fetch: authFetch(undefined, trace) });

  const settings = await handler(event("GET", "/v1/admin/settings"));
  const audits = await handler(event("GET", "/v1/admin/bookings/booking-1/audit-logs"));

  assert.equal(settings.statusCode, 200);
  assert.deepEqual(responseBody(settings).data, {
    courts: [{ id: "01", enabled: false, version: 7 }],
    sessionTemplates: [{ id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 4 }],
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

test("non-staff profiles return 403 and never enter the booking service", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), {
    trace,
    fetch: authFetch([{ id: "user" }], trace),
  });

  const response = await handler(
    event("POST", "/v1/admin/bookings/booking-1/confirm", { expectedVersion: 3 }),
  );

  assert.equal(response.statusCode, 403);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});

test("official profile resolution precedes transactions and is the only audit identity source", async () => {
  const trace = [];
  const service = fakeService(trace);
  const handler = handlerFor(service, { trace, fetch: authFetch(undefined, trace) });

  const response = await handler(
    event(
      "POST",
      "/v1/admin/bookings/booking-1/confirm",
      { expectedVersion: 3, actorId: "body-attacker", groups: [{ id: "booking_staff" }] },
      { identity: { user_id: "gateway-attacker", groups: ["booking_staff"] } },
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(trace, [
    {
      type: "auth",
      url: "https://booking-test-env.api.tcloudbasegateway.com/auth/v1/user/me",
      authorization: TOKEN,
    },
    {
      type: "service",
      name: "confirm",
      args: [{ bookingId: "booking-1", expectedVersion: 3, actorId: "profile-staff-7" }],
    },
  ]);
  assert.equal(response.body.includes("internal-phone-hash"), false);
  assert.equal(response.body.includes("internal-idempotency-hash"), false);
});

test("every booking lifecycle route requires a version and passes the authenticated actor", async () => {
  const cases = [
    ["confirm", "/confirm", { expectedVersion: 3 }, { bookingId: "booking-1", expectedVersion: 3, actorId: "profile-staff-7" }],
    ["proposeReschedule", "/reschedule", { expectedVersion: 3, sessionId: LATER }, { bookingId: "booking-1", expectedVersion: 3, sessionId: LATER, actorId: "profile-staff-7" }],
    ["cancel", "/cancel", { expectedVersion: 3 }, { bookingId: "booking-1", expectedVersion: 3, actorType: "staff", actorId: "profile-staff-7" }],
    ["complete", "/complete", { expectedVersion: 3 }, { bookingId: "booking-1", expectedVersion: 3, actorId: "profile-staff-7" }],
    ["reassign", "/reassign", { expectedVersion: 3, courtId: "02" }, { bookingId: "booking-1", expectedVersion: 3, courtId: "02", actorId: "profile-staff-7" }],
    [
      "redactPersonalData",
      "/redact",
      { expectedVersion: 3 },
      ["booking-1", "profile-staff-7", 3, "staff"],
    ],
  ];

  for (const [methodName, suffix, body, expected] of cases) {
    const trace = [];
    const handler = handlerFor(fakeService(trace), { trace, fetch: authFetch(undefined, trace) });
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

test("court and template writes require versions and carry the profile user id", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace, fetch: authFetch(undefined, trace) });

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
    args: ["01", false, "profile-staff-7", 5],
  });
  assert.deepEqual(calls[1], {
    type: "service",
    name: "setSessionTemplateEnabled",
    args: ["slot-0700", true, "profile-staff-7", 6],
  });
});

test("dashboard, matrix and booking-list routes use their exact scheduling reads", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace, fetch: authFetch(undefined, trace) });

  const dashboard = await handler(event("GET", "/v1/admin/dashboard", undefined, { query: { date: DATE } }));
  const matrix = await handler(event("GET", "/v1/admin/matrix", undefined, { query: { date: DATE } }));
  const listing = await handler(event("GET", "/v1/admin/bookings", undefined, {
    query: { date: DATE, status: "pending", mode: "private", q: "Ada" },
  }));

  assert.equal(dashboard.statusCode, 200);
  assert.deepEqual(responseBody(dashboard).data.date, DATE);
  assert.equal(matrix.statusCode, 200);
  assert.equal(responseBody(matrix).data[0].proposedDate, DATE);
  assert.equal(listing.statusCode, 200);
  const calls = trace.filter((entry) => entry.type === "service");
  assert.deepEqual(calls.map((entry) => [entry.name, entry.args]), [
    ["listPendingBookings", [DATE]],
    ["listAvailability", [DATE]],
    ["listMatrixBookings", [DATE]],
    ["listBookings", [{ date: DATE, status: "pending", mode: "private", query: "Ada", limit: 100 }]],
  ]);
  assert.equal(listing.body.includes("internal-phone-hash"), false);
  assert.equal(listing.body.includes("internal-idempotency-hash"), false);
});

test("CSV export uses a strict column allowlist, neutralizes formulas, and escapes RFC-style fields", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace, fetch: authFetch(undefined, trace) });
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
      args: [{ fromDate: DATE, toDate: DATE, limit: 500 }],
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
  return { repository, service, handler: handlerFor(service, { trace, fetch: authFetch(undefined, trace) }) };
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

test("redaction through the handler removes both lookup paths and all personal fields", async () => {
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

  assert.equal(response.statusCode, 200);
  assert.equal(await service.lookup(created.code, created.phone), null);
  assert.equal(stored.name, undefined);
  assert.equal(stored.phone, undefined);
  assert.equal(stored.phoneHash, undefined);
  assert.equal(stored.email, undefined);
  assert.equal(stored.note, undefined);
  assert.equal(stored.idempotencyKeyHash, undefined);
  assert.equal(stored.code, created.code);
  assert.equal(stored.courtId, created.courtId);
  assert.equal(stored.status, "cancelled");
  const audit = (await repository.listAuditLogs()).find(
    (entry) => entry.action === "personal_data_redacted",
  );
  assert.equal(audit.actorId, "profile-staff-7");
  assert.equal(audit.actorType, "staff");
  assert.deepEqual(audit.metadata, {});
});

test("stale handler redaction changes neither booking nor audit history", async () => {
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

  assert.equal(response.statusCode, 409);
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
  assert.equal(audit.actorId, "profile-staff-7");
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
  assert.equal(templateAudit.actorId, "profile-staff-7");
  assert.equal(templateAudit.actorType, "staff");
});

test("only the documented route shapes are accepted", async () => {
  const trace = [];
  const handler = handlerFor(fakeService(trace), { trace, fetch: authFetch(undefined, trace) });
  const response = await handler(
    event("POST", "/v1/admin/bookings/booking-1/confirm/extra", { expectedVersion: 3 }),
  );
  assert.equal(response.statusCode, 404);
  assert.equal(trace.filter((entry) => entry.type === "service").length, 0);
});
