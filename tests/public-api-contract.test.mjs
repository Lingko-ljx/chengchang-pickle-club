import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BookingService, allocationId, courtIds } from "../lib/booking/booking-service.ts";
import { BookingError } from "../lib/booking/errors.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";
import { createPublicApiHandler } from "../cloudbase/src/public-api.ts";
import { createRateLimiter } from "../cloudbase/src/http/rate-limit.ts";

const DATE = "2099-01-01";
const MORNING = `${DATE}__slot-0700`;
const LATER = `${DATE}__slot-0800`;
const NOW = new Date("2098-12-01T02:35:00.000Z");
const ALLOWED_ORIGIN = "https://lingko-ljx.github.io";
const NOT_FOUND = {
  error: {
    code: "BOOKING_NOT_FOUND",
    message: "Booking not found",
    retryable: false,
  },
};

function ids() {
  let booking = 0;
  let code = 0;
  let event = 0;
  return {
    bookingId: () => `booking-${++booking}`,
    bookingCode: () => `PUBLIC${String(++code).padStart(26, "0")}`,
    eventId: () => `event-${++event}`,
  };
}

function serviceFixture(seed = {}) {
  const repository = new MemoryBookingRepository({
    courts: courtIds.map((id) => ({ id, enabled: true, version: 1 })),
    sessionTemplates: [
      { id: "slot-0700", startTime: "07:00", endTime: "08:00", enabled: true, version: 1 },
      { id: "slot-0800", startTime: "08:00", endTime: "09:00", enabled: true, version: 1 },
    ],
    ...seed,
  });
  const clock = { now: () => new Date(NOW) };
  return {
    repository,
    service: new BookingService(repository, clock, ids()),
  };
}

function handlerFor(service, overrides = {}) {
  return createPublicApiHandler({
    service,
    rateLimiter: overrides.rateLimiter ?? { consume: async () => true },
    now: overrides.now ?? (() => new Date(NOW)),
    allowedOrigins:
      overrides.allowedOrigins ?? `${ALLOWED_ORIGIN}, http://localhost:3001`,
    resultUrl: overrides.resultUrl ?? "https://example.test/booking/result",
    idempotencySalt: overrides.idempotencySalt ?? "test-idempotency-salt",
  });
}

function jsonEvent(method, path, body, overrides = {}) {
  return {
    httpMethod: method,
    path,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: ALLOWED_ORIGIN,
      ...(overrides.headers ?? {}),
    },
    queryStringParameters: overrides.queryStringParameters,
    requestContext: overrides.requestContext,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    ...overrides.event,
  };
}

function responseBody(response) {
  return response.body === "" ? null : JSON.parse(response.body);
}

function createPayload(overrides = {}) {
  return {
    idempotency_key: "request-001",
    session_id: MORNING,
    mode: "open",
    party_size: 2,
    name: "Ada Lovelace",
    phone: "138 0013-8000",
    email: "ada@example.com",
    note: "Near the net",
    privacy_consent: true,
    ...overrides,
  };
}

test("OPTIONS returns 204 and CORS only echoes an exact allowlisted origin", async () => {
  const service = { listAvailability: async () => [] };
  const handler = handlerFor(service);

  const allowed = await handler({
    httpMethod: "OPTIONS",
    path: "/v1/anything",
    headers: { origin: ALLOWED_ORIGIN },
  });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.body, "");
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], ALLOWED_ORIGIN);
  assert.equal(allowed.headers.Vary, "Origin");

  const lookalike = await handler({
    httpMethod: "OPTIONS",
    path: "/v1/bookings",
    headers: { origin: `${ALLOWED_ORIGIN}.evil.example` },
  });
  assert.equal(lookalike.statusCode, 204);
  assert.equal(lookalike.headers["Access-Control-Allow-Origin"], undefined);
  assert.notEqual(lookalike.headers["Access-Control-Allow-Origin"], "*");
});

test("availability advertises open party sizes that fit one court, not aggregate seats", async () => {
  const session = {
    id: MORNING,
    date: DATE,
    templateId: "slot-0700",
    startAt: "2098-12-31T23:00:00.000Z",
    endAt: "2099-01-01T00:00:00.000Z",
    status: "open",
    enabledCourtIds: ["01", "02"],
    version: 1,
  };
  const allocations = ["01", "02"].map((courtId) => ({
    id: allocationId(MORNING, courtId),
    sessionId: MORNING,
    courtId,
    mode: "open",
    occupiedPlayers: 2,
    bookingIds: [`seed-${courtId}`],
    version: 1,
  }));
  const { service } = serviceFixture({
    sessions: [session],
    allocations,
  });
  const response = await handlerFor(service)(
    jsonEvent("GET", "/v1/availability", undefined, {
      queryStringParameters: { date: DATE },
    }),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response), {
    data: [
      {
        sessionId: MORNING,
        date: DATE,
        startTime: "07:00",
        endTime: "08:00",
        openCapacity: 4,
        acceptsOpenPartySizes: [1, 2],
        privateCourtCount: 0,
        acceptsOpen: true,
        acceptsPrivate: false,
      },
    ],
  });
});

test("JSON creation returns a sanitized 201 envelope and requires client idempotency", async () => {
  const { service } = serviceFixture();
  const handler = handlerFor(service);
  const created = await handler(jsonEvent("POST", "/v1/bookings", createPayload()));

  assert.equal(created.statusCode, 201);
  assert.equal(created.headers["Access-Control-Allow-Origin"], ALLOWED_ORIGIN);
  assert.deepEqual(responseBody(created), {
    data: {
      code: "PUBLIC00000000000000000000000001",
      status: "pending",
      date: DATE,
      startTime: "07:00",
      endTime: "08:00",
      mode: "open",
      partySize: 2,
      name: "A** L*******",
      phone: "138****8000",
      version: 1,
      canCancel: true,
    },
  });
  assert.equal("id" in responseBody(created).data, false);
  assert.equal("phoneHash" in responseBody(created).data, false);

  const missingKey = await handler(
    jsonEvent("POST", "/v1/bookings", createPayload({ idempotency_key: "" })),
  );
  assert.equal(missingKey.statusCode, 400);
  assert.equal(responseBody(missingKey).error.code, "INVALID_INPUT");
});

test("a fifth player is rejected with INVALID_PARTY_SIZE", async () => {
  const { service } = serviceFixture();
  const response = await handlerFor(service)(
    jsonEvent("POST", "/v1/bookings", createPayload({ party_size: 5 })),
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(responseBody(response), {
    error: {
      code: "INVALID_PARTY_SIZE",
      message: "Party size must be between 1 and 4",
      retryable: false,
    },
  });
});

test("base64 native forms normalize date and start_time, derive an hourly key, and redirect safely", async () => {
  const captured = [];
  const service = {
    async create(command) {
      captured.push(command);
      return {
        code: "FORMCODE2345",
        status: "pending",
        date: DATE,
        startAt: "2098-12-31T23:00:00.000Z",
        endAt: "2099-01-01T00:00:00.000Z",
        mode: "private",
        partySize: 4,
        name: "Grace Hopper",
        phone: "13900139000",
        version: 1,
        canCancelUntil: "2098-12-31T23:00:00.000Z",
      };
    },
  };
  const handler = handlerFor(service);
  const params = new URLSearchParams({
    date: DATE,
    start_time: "07:00",
    mode: "private",
    party_size: "4",
    name: "  Grace Hopper  ",
    phone: "139 0013 9000",
    privacy_consent: "on",
    idempotency_key: "",
  });
  const event = {
    httpMethod: "POST",
    path: "/v1/bookings",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: Buffer.from(params.toString()).toString("base64"),
    isBase64Encoded: true,
  };

  const first = await handler(event);
  await handler(event);
  assert.equal(first.statusCode, 303);
  assert.deepEqual(first.headers, {
    Location: "https://example.test/booking/result?code=FORMCODE2345",
  });
  assert.equal(first.body, "");
  assert.equal(captured[0].sessionId, MORNING);
  assert.equal(captured[0].partySize, 4);
  assert.equal(captured[0].privacyConsent, true);
  assert.match(captured[0].idempotencyKey, /^[a-f0-9]{64}$/);
  assert.equal(captured[1].idempotencyKey, captured[0].idempotencyKey);
});

test("honeypot submissions receive a generic 202 without creating a booking", async () => {
  const service = {
    async create() {
      throw new Error("HONEYPOT_REACHED_BUSINESS_SERVICE");
    },
  };
  const response = await handlerFor(service)(
    jsonEvent("POST", "/v1/bookings", createPayload({ website: "https://spam.example" })),
  );

  assert.equal(response.statusCode, 202);
  assert.deepEqual(responseBody(response), { data: { accepted: true } });
});

test("an exhausted session is a sanitized 409 SESSION_FULL", async () => {
  const service = {
    async create() {
      throw new BookingError("SESSION_FULL");
    },
  };
  const response = await handlerFor(service)(
    jsonEvent("POST", "/v1/bookings", createPayload()),
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(responseBody(response), {
    error: {
      code: "SESSION_FULL",
      message: "This session is full",
      retryable: true,
    },
  });
});

test("lookup requires code plus the full normalized phone and sanitizes not-found cases identically", async () => {
  const { service } = serviceFixture();
  const booking = await service.create({
    idempotencyKey: "lookup-seed",
    sessionId: MORNING,
    mode: "open",
    partySize: 2,
    name: "Ada Lovelace",
    phone: "13800138000",
    privacyConsent: true,
  });
  const handler = handlerFor(service);
  const found = await handler(
    jsonEvent("POST", "/v1/bookings/lookup", {
      code: booking.code.toLowerCase(),
      phone: "138 0013-8000",
    }),
  );
  assert.equal(found.statusCode, 200);
  assert.equal(responseBody(found).data.code, booking.code);
  assert.equal(responseBody(found).data.phone, "138****8000");
  assert.equal(responseBody(found).data.name, "A** L*******");

  const wrongCode = await handler(
    jsonEvent("POST", "/v1/bookings/lookup", {
      code: "WRONGCODE",
      phone: "13800138000",
    }),
  );
  const wrongPhone = await handler(
    jsonEvent("POST", "/v1/bookings/lookup", {
      code: booking.code,
      phone: "13800138001",
    }),
  );
  const suffixOnly = await handler(
    jsonEvent("POST", "/v1/bookings/lookup", {
      code: booking.code,
      phone: "8000",
    }),
  );
  for (const response of [wrongCode, wrongPhone, suffixOnly]) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(responseBody(response), NOT_FOUND);
  }
});

test("customer cancellation authenticates by code and phone and requires expectedVersion", async () => {
  const { service } = serviceFixture();
  const booking = await service.create({
    idempotencyKey: "cancel-seed",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "Ada Lovelace",
    phone: "13800138000",
    privacyConsent: true,
  });
  const handler = handlerFor(service);

  const missingVersion = await handler(
    jsonEvent("POST", `/v1/bookings/${booking.code}/cancel`, {
      phone: "13800138000",
    }),
  );
  assert.equal(missingVersion.statusCode, 400);
  assert.equal(responseBody(missingVersion).error.code, "INVALID_INPUT");

  const wrongPhone = await handler(
    jsonEvent("POST", `/v1/bookings/${booking.code}/cancel`, {
      phone: "13800138001",
      expected_version: booking.version,
    }),
  );
  assert.equal(wrongPhone.statusCode, 404);
  assert.deepEqual(responseBody(wrongPhone), NOT_FOUND);

  const cancelled = await handler(
    jsonEvent("POST", `/v1/bookings/${booking.code}/cancel`, {
      phone: "138 0013-8000",
      expected_version: booking.version,
    }),
  );
  assert.equal(cancelled.statusCode, 200);
  assert.equal(responseBody(cancelled).data.status, "cancelled");
  assert.equal(responseBody(cancelled).data.version, 2);
});

test("customer reschedule response authenticates ownership and preserves conflict status", async () => {
  const { service } = serviceFixture();
  const booking = await service.create({
    idempotencyKey: "reschedule-seed",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "Ada Lovelace",
    phone: "13800138000",
    privacyConsent: true,
  });
  const proposal = await service.proposeReschedule({
    bookingId: booking.id,
    sessionId: LATER,
    expectedVersion: booking.version,
    actorId: "staff-1",
  });
  const handler = handlerFor(service);

  const stale = await handler(
    jsonEvent("POST", `/v1/bookings/${booking.code}/reschedule-response`, {
      phone: "13800138000",
      expected_version: booking.version,
      accept: true,
    }),
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(responseBody(stale).error.code, "CONFLICT");

  const accepted = await handler(
    jsonEvent("POST", `/v1/bookings/${booking.code}/reschedule-response`, {
      phone: "13800138000",
      expected_version: proposal.version,
      accept: true,
    }),
  );
  assert.equal(accepted.statusCode, 200);
  assert.equal(responseBody(accepted).data.status, "confirmed");
  assert.equal(responseBody(accepted).data.date, DATE);
  assert.equal(responseBody(accepted).data.startTime, "08:00");
});

test("rate limits run before booking transactions and ignore forwarding headers", async () => {
  const limiter = {
    async consume(request) {
      if (request.scope === "lookup-ip") {
        assert.equal(request.key, "anonymous");
        assert.equal(request.limit, 3);
        return false;
      }
      throw new Error("UNEXPECTED_RATE_LIMIT_BUCKET");
    },
  };
  const service = {
    async lookup() {
      throw new Error("RATE_LIMIT_RAN_AFTER_LOOKUP");
    },
  };
  const response = await handlerFor(service, { rateLimiter: limiter })(
    jsonEvent(
      "POST",
      "/v1/bookings/lookup",
      { code: "PUBLIC123", phone: "13800138000" },
      { headers: { "x-forwarded-for": "203.0.113.9" } },
    ),
  );

  assert.equal(response.statusCode, 429);
  assert.equal(responseBody(response).error.code, "RATE_LIMITED");
});

test("trusted gateway addresses receive the documented create bucket", async () => {
  const limiter = {
    async consume(request) {
      assert.deepEqual(request, {
        scope: "create-ip",
        key: "198.51.100.7",
        limit: 5,
        windowMs: 10 * 60 * 1000,
      });
      return false;
    },
  };
  const response = await handlerFor(
    { create: async () => { throw new Error("CREATE_SHOULD_NOT_RUN"); } },
    { rateLimiter: limiter },
  )(
    jsonEvent("POST", "/v1/bookings", createPayload(), {
      requestContext: { http: { sourceIp: "198.51.100.7" } },
    }),
  );
  assert.equal(response.statusCode, 429);
});

test("rate limiter hashes salted keys and exhausts the counter without exposing raw values", async () => {
  const counts = new Map();
  const store = {
    async increment(keyHash, windowStartedAt, expiresAt) {
      assert.match(keyHash, /^[a-f0-9]{64}$/);
      assert.notEqual(keyHash, createHash("sha256").update("198.51.100.7").digest("hex"));
      assert.equal(windowStartedAt, "2098-12-01T02:30:00.000Z");
      assert.equal(expiresAt, "2098-12-01T02:40:00.000Z");
      const count = (counts.get(keyHash) ?? 0) + 1;
      counts.set(keyHash, count);
      return count;
    },
  };
  const limiter = createRateLimiter({
    store,
    salt: "rate-limit-secret",
    now: () => new Date(NOW),
  });
  const request = {
    scope: "create-ip",
    key: "198.51.100.7",
    limit: 2,
    windowMs: 10 * 60 * 1000,
  };

  assert.equal(await limiter.consume(request), true);
  assert.equal(await limiter.consume(request), true);
  assert.equal(await limiter.consume(request), false);
  assert.equal(counts.size, 1);
});

test("unknown routes and malformed bodies use stable sanitized JSON errors", async () => {
  const handler = handlerFor({});
  const unknown = await handler(jsonEvent("GET", "/v1/admin", undefined));
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(responseBody(unknown), NOT_FOUND);

  const malformed = await handler({
    httpMethod: "POST",
    path: "/v1/bookings",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(responseBody(malformed).error.code, "INVALID_INPUT");
  assert.equal(responseBody(malformed).error.message.includes("not-json"), false);
});
