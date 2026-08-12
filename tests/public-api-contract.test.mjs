import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { BookingService, allocationId, courtIds } from "../lib/booking/booking-service.ts";
import { BookingError } from "../lib/booking/errors.ts";
import { MemoryBookingRepository } from "../lib/booking/testing/memory-repository.ts";
import { createPublicApiHandler } from "../cloudbase/src/public-api.ts";
import { createRateLimiter } from "../cloudbase/src/http/rate-limit.ts";

const DATE = "2099-01-01";
const MORNING = `${DATE}__slot-0900`;
const LATER = `${DATE}__slot-1000`;
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
      { id: "slot-0900", startTime: "09:00", endTime: "10:00", enabled: true, version: 1 },
      { id: "slot-1000", startTime: "10:00", endTime: "11:00", enabled: true, version: 1 },
    ],
    ...seed,
  });
  const clock = { now: () => new Date(NOW) };
  return {
    repository,
    service: new BookingService(repository, clock, ids(), {
      hash: (phone) =>
        createHmac("sha256", "public-contract-phone-salt")
          .update(phone)
          .digest("hex"),
    }),
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
    ...(overrides.mediaService ? { mediaService: overrides.mediaService } : {}),
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
    public_schedule_consent_version: 1,
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

test("availability rejects normalized invalid dates and accepts a real leap day", async () => {
  const requestedDates = [];
  const handler = handlerFor({
    async listAvailability(date) {
      requestedDates.push(date);
      return [];
    },
  });

  for (const date of ["2026-02-29", "2026-02-31"]) {
    const response = await handler(
      jsonEvent("GET", "/v1/availability", undefined, {
        queryStringParameters: { date },
      }),
    );
    assert.equal(response.statusCode, 400);
    assert.equal(responseBody(response).error.code, "INVALID_INPUT");
  }

  const leapDay = await handler(
    jsonEvent("GET", "/v1/availability", undefined, {
      queryStringParameters: { date: "2028-02-29" },
    }),
  );
  assert.equal(leapDay.statusCode, 200);
  assert.equal(leapDay.headers["Cache-Control"], undefined);
  assert.equal(leapDay.headers.Pragma, undefined);
  assert.deepEqual(requestedDates, ["2028-02-29"]);
});

test("public homepage media is served through the same exact-origin CORS policy", async () => {
  const calls = [];
  const mediaService = {
    async listPublished() {
      calls.push("listPublished");
      return [{ id: "media-1", kind: "image", url: "https://example.test/media.jpg" }];
    },
  };
  const response = await handlerFor({}, { mediaService })(
    jsonEvent("GET", "/v1/homepage-media"),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], ALLOWED_ORIGIN);
  assert.deepEqual(responseBody(response).data, {
    items: [{ id: "media-1", kind: "image", url: "https://example.test/media.jpg" }],
  });
  assert.deepEqual(calls, ["listPublished"]);
});

test("public media URL signing is protected by lightweight IP rate limits", async () => {
  const consumed = [];
  const rateLimiter = { consume: async (request) => { consumed.push(request); return true; } };
  const mediaService = {
    async listPublished() { return []; },
    async listPublicArchive() { return { items: [], availableDates: [], selectedDate: null, isToday: false }; },
  };
  const honorMediaService = { async listPublished() { return []; } };
  const handler = createPublicApiHandler({
    service: {}, rateLimiter, now: () => new Date(NOW), allowedOrigins: ALLOWED_ORIGIN,
    resultUrl: "https://example.test/booking/result", idempotencySalt: "salt",
    mediaService, honorMediaService,
  });
  const trusted = { requestContext: { http: { sourceIp: "203.0.113.7" } } };
  await handler(jsonEvent("GET", "/v1/homepage-media", undefined, trusted));
  await handler(jsonEvent("GET", "/v1/honor-media", undefined, trusted));
  assert.deepEqual(consumed.map(({ scope, key, limit }) => [scope, key, limit]), [
    ["homepage-media-ip", "203.0.113.7", 60],
    ["honor-media-ip", "203.0.113.7", 60],
  ]);
});

test("homepage media archive accepts only one canonical date query", async () => {
  const mediaService = {
    async listPublished() { return []; },
    async listPublicArchive() { return { items: [], availableDates: [], selectedDate: null, isToday: false }; },
  };
  const handler = handlerFor({}, { mediaService });
  assert.equal((await handler(jsonEvent("GET", "/v1/homepage-media", undefined, { queryStringParameters: { date: "2026-02-30" } }))).statusCode, 400);
  assert.equal((await handler(jsonEvent("GET", "/v1/homepage-media", undefined, { queryStringParameters: { date: "2026-08-12", extra: "x" } }))).statusCode, 400);
});

test("window availability stays under the deployed v1 gateway and delegates the 30-minute query", async () => {
  const queries = [];
  const windows = {
    policy: {
      timezone: "Asia/Shanghai",
      openingTime: "09:00",
      closingTime: "22:00",
      startIntervalMinutes: 30,
      minimumDurationMinutes: 60,
      durationStepMinutes: 60,
      maximumDurationMinutes: 240,
      version: 1,
    },
    windows: [{
      date: "2028-02-29",
      startTime: "09:30",
      endTime: "11:30",
      durationMinutes: 120,
      openCapacity: 44,
      privateCourtCount: 11,
      acceptsOpenPartySizes: [1, 2, 3, 4],
      acceptsOpen: true,
      acceptsPrivate: true,
    }],
  };
  const handler = handlerFor({
    async listWindowAvailability(query) {
      queries.push(query);
      return windows;
    },
  });

  const response = await handler(
    jsonEvent("GET", "/v1/availability/windows", undefined, {
      queryStringParameters: { date: "2028-02-29" },
    }),
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(responseBody(response).data, windows);
  assert.deepEqual(queries, [{ date: "2028-02-29" }]);

  const invalid = await handler(
    jsonEvent("GET", "/v1/availability/windows", undefined, {
      queryStringParameters: { date: "2028-02-30" },
    }),
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(responseBody(invalid).error.code, "INVALID_INPUT");

  const undeployedVersionRoot = await handler(
    jsonEvent("GET", "/v2/availability", undefined, {
      queryStringParameters: { date: "2028-02-29" },
    }),
  );
  assert.equal(undeployedVersionRoot.statusCode, 404);
  assert.equal(responseBody(undeployedVersionRoot).error.code, "BOOKING_NOT_FOUND");
  assert.deepEqual(queries, [{ date: "2028-02-29" }]);
});

test("availability advertises open party sizes that fit one court, not aggregate seats", async () => {
  const session = {
    id: MORNING,
    date: DATE,
    templateId: "slot-0900",
    startAt: "2099-01-01T01:00:00.000Z",
    endAt: "2099-01-01T02:00:00.000Z",
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
  const slots = responseBody(response).data;
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.find(({ sessionId }) => sessionId === MORNING), {
    sessionId: MORNING,
    date: DATE,
    startTime: "09:00",
    endTime: "10:00",
    openCapacity: 4,
    acceptsOpenPartySizes: [1, 2],
    privateCourtCount: 0,
    acceptsOpen: true,
    acceptsPrivate: false,
  });
});

test("legacy availability and native fallback cannot book outside 09:00–22:00", async () => {
  let createCalls = 0;
  const service = {
    async listAvailability() {
      return [
        { sessionId: `${DATE}__slot-0700`, startTime: "07:00", endTime: "08:00" },
        { sessionId: `${DATE}__slot-0900`, startTime: "09:00", endTime: "10:00" },
        { sessionId: `${DATE}__slot-2100`, startTime: "21:00", endTime: "22:00" },
        { sessionId: `${DATE}__slot-2200`, startTime: "22:00", endTime: "23:00" },
      ];
    },
    async create() {
      createCalls += 1;
      throw new Error("create must not run for a closed legacy time");
    },
  };
  const handler = handlerFor(service);
  const availability = await handler(jsonEvent("GET", "/v1/availability", undefined, {
    queryStringParameters: { date: DATE },
  }));
  assert.deepEqual(
    responseBody(availability).data.map(({ startTime }) => startTime),
    ["09:00", "21:00"],
  );

  const rejected = await handler(jsonEvent("POST", "/v1/bookings", {
    ...createPayload(),
    start_time: "07:00",
  }));
  assert.equal(rejected.statusCode, 409);
  assert.equal(responseBody(rejected).error.code, "SESSION_CLOSED");

  const directSessionRejected = await handler(jsonEvent("POST", "/v1/bookings", {
    ...createPayload(),
    session_id: `${DATE}__slot-0700`,
    start_time: undefined,
  }));
  assert.equal(directSessionRejected.statusCode, 409);
  assert.equal(responseBody(directSessionRejected).error.code, "SESSION_CLOSED");
  assert.equal(createCalls, 0);
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
      displayCode: "8000",
      status: "confirmed",
      date: DATE,
      startTime: "09:00",
      endTime: "10:00",
      mode: "open",
      partySize: 2,
      name: "A** L*******",
      phone: "138****8000",
      actionVersion: 1,
      canCancelUntil: "2099-01-01T01:00:00.000Z",
      canCancel: true,
    },
  });
  assert.equal("id" in responseBody(created).data, false);
  assert.equal("phoneHash" in responseBody(created).data, false);
  assert.equal("version" in responseBody(created).data, false);

  const missingKey = await handler(
    jsonEvent("POST", "/v1/bookings", createPayload({ idempotency_key: "" })),
  );
  assert.equal(missingKey.statusCode, 400);
  assert.equal(responseBody(missingKey).error.code, "INVALID_INPUT");
});

test("public schedule disclosure consent is independent, optional, and strictly versioned", async () => {
  const captured = [];
  const service = {
    async create(command) {
      captured.push(command);
      return {
        code: `CONSENT${captured.length}`,
        status: "confirmed",
        date: DATE,
        startAt: "2099-01-01T01:00:00.000Z",
        endAt: "2099-01-01T02:00:00.000Z",
        mode: command.mode,
        partySize: command.partySize,
        name: command.name,
        phone: command.phone,
        version: 1,
        canCancelUntil: "2099-01-01T01:00:00.000Z",
      };
    },
  };
  const handler = handlerFor(service);
  const legacyPayload = createPayload();
  delete legacyPayload.public_schedule_consent_version;

  const legacy = await handler(jsonEvent("POST", "/v1/bookings", legacyPayload));
  const current = await handler(jsonEvent("POST", "/v1/bookings", createPayload({
    idempotency_key: "request-with-current-consent",
  })));
  const unknown = await handler(jsonEvent("POST", "/v1/bookings", createPayload({
    idempotency_key: "request-with-unknown-consent",
    public_schedule_consent_version: 2,
  })));

  assert.equal(legacy.statusCode, 201);
  assert.equal(captured[0].publicScheduleConsentVersion, undefined);
  assert.equal(current.statusCode, 201);
  assert.equal(captured[1].publicScheduleConsentVersion, 1);
  assert.equal(unknown.statusCode, 400);
  assert.equal(responseBody(unknown).error.code, "INVALID_INPUT");
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0].idempotencyKey, captured[1].idempotencyKey);

  for (const ambiguousVersion of ["01", "1.0", true]) {
    const response = await handler(jsonEvent("POST", "/v1/bookings", createPayload({
      idempotency_key: `ambiguous-consent-${String(ambiguousVersion)}`,
      public_schedule_consent_version: ambiguousVersion,
    })));
    assert.equal(response.statusCode, 400);
  }
  assert.equal(captured.length, 2);
});

test("v2 creation passes an explicit Beijing-time window and fingerprints the end time", async () => {
  const captured = [];
  const service = {
    async create(command) {
      captured.push(command);
      return {
        code: `WINDOW${captured.length}`,
        status: "pending",
        date: DATE,
        startAt: "2099-01-01T01:30:00.000Z",
        endAt: "2099-01-01T03:30:00.000Z",
        mode: command.mode,
        partySize: command.partySize,
        name: command.name,
        phone: command.phone,
        version: 1,
        canCancelUntil: "2099-01-01T01:30:00.000Z",
      };
    },
  };
  const handler = handlerFor(service);
  const payload = createPayload({
    session_id: undefined,
    date: DATE,
    start_time: "09:30",
    end_time: "11:30",
  });

  const first = await handler(jsonEvent("POST", "/v1/bookings", payload));
  const changedEnd = await handler(jsonEvent("POST", "/v1/bookings", {
    ...payload,
    end_time: "12:30",
  }));

  assert.equal(first.statusCode, 201);
  assert.equal(changedEnd.statusCode, 201);
  assert.deepEqual(
    {
      date: captured[0].date,
      startTime: captured[0].startTime,
      endTime: captured[0].endTime,
      sessionId: captured[0].sessionId,
    },
    { date: DATE, startTime: "09:30", endTime: "11:30", sessionId: undefined },
  );
  assert.notEqual(captured[0].idempotencyKey, captured[1].idempotencyKey);
  const expected = createHmac("sha256", "test-idempotency-salt")
    .update(JSON.stringify([
      "public-api-client-v2",
      "request-001",
      "booking-window-v2",
      DATE,
      "09:30",
      "11:30",
      "open",
      2,
      "Ada Lovelace",
      "13800138000",
      "ada@example.com",
      "Near the net",
      true,
      1,
    ]))
    .digest("hex");
  assert.equal(captured[0].idempotencyKey, expected);
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

test("base64 native forms derive the exact canonical hourly HMAC and redirect safely", async () => {
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
    start_time: "09:00",
    mode: "private",
    party_size: "4",
    name: "  Grace Hopper  ",
    phone: "139 0013 9000",
    privacy_consent: "on",
    public_schedule_consent_version: "1",
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
  const changedParams = new URLSearchParams(params);
  changedParams.set("phone", "139 0013 9001");
  await handler({
    ...event,
    body: Buffer.from(changedParams.toString()).toString("base64"),
  });
  assert.equal(first.statusCode, 303);
  assert.deepEqual(first.headers, {
    Location: "https://example.test/booking/result?code=FORMCODE2345#display_code=9000",
  });
  assert.equal(first.body, "");
  assert.equal(captured[0].sessionId, MORNING);
  assert.equal(captured[0].partySize, 4);
  assert.equal(captured[0].privacyConsent, true);
  assert.equal(captured[0].publicScheduleConsentVersion, 1);
  const expected = createHmac("sha256", "test-idempotency-salt")
    .update(JSON.stringify([
      MORNING,
      "private",
      4,
      "Grace Hopper",
      "13900139000",
      "",
      "",
      true,
      1,
      "2098-12-01T10",
    ]))
    .digest("hex");
  assert.equal(captured[0].idempotencyKey, expected);
  assert.equal(captured[1].idempotencyKey, captured[0].idempotencyKey);
  assert.notEqual(captured[2].idempotencyKey, captured[0].idempotencyKey);
});

test("client idempotency keys are HMAC-fingerprinted by canonical request and remain hour-stable", async () => {
  const captured = [];
  let instant = new Date(NOW);
  const service = {
    async create(command) {
      captured.push(command);
      return {
        code: `CLIENTKEY${captured.length}`,
        status: "pending",
        date: DATE,
        startAt: "2098-12-31T23:00:00.000Z",
        endAt: "2099-01-01T00:00:00.000Z",
        mode: command.mode,
        partySize: command.partySize,
        name: command.name,
        phone: command.phone,
        version: 1,
        canCancelUntil: "2098-12-31T23:00:00.000Z",
      };
    },
  };
  const handler = handlerFor(service, { now: () => new Date(instant) });
  const payload = createPayload({ idempotency_key: "  shared-key  " });

  await handler(jsonEvent("POST", "/v1/bookings", payload));
  instant = new Date("2098-12-01T03:35:00.000Z");
  await handler(jsonEvent("POST", "/v1/bookings", payload));
  await handler(jsonEvent("POST", "/v1/bookings", { ...payload, phone: "13900139000" }));

  const expected = createHmac("sha256", "test-idempotency-salt")
    .update(JSON.stringify([
      "public-api-client-v1",
      "shared-key",
      MORNING,
      "open",
      2,
      "Ada Lovelace",
      "13800138000",
      "ada@example.com",
      "Near the net",
      true,
      1,
    ]))
    .digest("hex");
  assert.equal(captured[0].idempotencyKey, expected);
  assert.equal(captured[1].idempotencyKey, expected);
  assert.notEqual(captured[2].idempotencyKey, expected);
  assert.notEqual(captured[0].idempotencyKey, "shared-key");
});

test("the same low-entropy client key cannot return another canonical booking", async () => {
  const { service } = serviceFixture();
  const handler = handlerFor(service);
  const firstPayload = createPayload({ idempotency_key: "1" });
  const first = await handler(jsonEvent("POST", "/v1/bookings", firstPayload));
  const retry = await handler(jsonEvent("POST", "/v1/bookings", firstPayload));
  const other = await handler(jsonEvent("POST", "/v1/bookings", {
    ...firstPayload,
    phone: "13900139000",
  }));

  assert.equal(responseBody(retry).data.code, responseBody(first).data.code);
  assert.notEqual(responseBody(other).data.code, responseBody(first).data.code);
  assert.equal(responseBody(other).data.phone, "139****9000");
});

test("URL-encoded JSON enhancement requests cannot use the native blank-key fallback", async () => {
  const { service } = serviceFixture();
  const params = new URLSearchParams({
    date: DATE,
    start_time: "09:00",
    mode: "open",
    party_size: "2",
    name: "Ada Lovelace",
    phone: "13800138000",
    privacy_consent: "on",
    idempotency_key: "",
  });
  const response = await handlerFor(service)({
    httpMethod: "POST",
    path: "/v1/bookings",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(responseBody(response).error.code, "INVALID_INPUT");
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

test("public phone validation rejects incomplete numbers and masks an eight-digit number", async () => {
  const { service } = serviceFixture();
  const handler = handlerFor(service);

  const shortCreate = await handler(
    jsonEvent("POST", "/v1/bookings", createPayload({ phone: "123-4567" })),
  );
  assert.equal(shortCreate.statusCode, 400);
  assert.equal(responseBody(shortCreate).error.code, "INVALID_INPUT");

  const created = await handler(
    jsonEvent("POST", "/v1/bookings", createPayload({
      idempotency_key: "eight-digit-phone",
      phone: "1234-5678",
    })),
  );
  assert.equal(created.statusCode, 201);
  assert.equal(responseBody(created).data.phone, "123*5678");
  assert.notEqual(responseBody(created).data.phone, "12345678");

  const shortLookup = await handler(
    jsonEvent("POST", "/v1/bookings/lookup", {
      code: responseBody(created).data.code,
      phone: "4567",
    }),
  );
  assert.equal(shortLookup.statusCode, 400);
  assert.equal(responseBody(shortLookup).error.code, "INVALID_INPUT");
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
  assert.equal(responseBody(found).data.displayCode, "8000");
  assert.equal(responseBody(found).data.phone, "138****8000");
  assert.equal(responseBody(found).data.name, "A** L*******");
  assert.equal(responseBody(found).data.actionVersion, booking.version);
  assert.equal(responseBody(found).data.canCancelUntil, booking.canCancelUntil);
  assert.equal("version" in responseBody(found).data, false);

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
  for (const response of [wrongCode, wrongPhone]) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(responseBody(response), NOT_FOUND);
  }
});

test("matching phone suffixes share a display code but cannot replace the unique ownership token", async () => {
  const { service } = serviceFixture();
  const first = await service.create({
    idempotencyKey: "display-code-first",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "First Player",
    phone: "13800138000",
    privacyConsent: true,
  });
  const second = await service.create({
    idempotencyKey: "display-code-second",
    sessionId: MORNING,
    mode: "private",
    partySize: 2,
    name: "Second Player",
    phone: "13999138000",
    privacyConsent: true,
  });
  assert.notEqual(first.code, second.code);

  const handler = handlerFor(service);
  const firstLookup = await handler(jsonEvent("POST", "/v1/bookings/lookup", {
    code: first.code,
    phone: first.phone,
  }));
  const secondLookup = await handler(jsonEvent("POST", "/v1/bookings/lookup", {
    code: second.code,
    phone: second.phone,
  }));
  assert.equal(firstLookup.statusCode, 200);
  assert.equal(secondLookup.statusCode, 200);
  assert.equal(responseBody(firstLookup).data.displayCode, "8000");
  assert.equal(responseBody(secondLookup).data.displayCode, "8000");

  for (const phone of [first.phone, second.phone]) {
    const suffixLookup = await handler(jsonEvent("POST", "/v1/bookings/lookup", {
      code: "8000",
      phone,
    }));
    assert.equal(suffixLookup.statusCode, 404);
    assert.deepEqual(responseBody(suffixLookup), NOT_FOUND);
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
  assert.equal(responseBody(cancelled).data.actionVersion, 2);
  assert.equal(responseBody(cancelled).data.canCancelUntil, booking.canCancelUntil);
  assert.equal("version" in responseBody(cancelled).data, false);
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
  assert.equal(responseBody(accepted).data.startTime, "10:00");
  assert.equal(responseBody(accepted).data.actionVersion, 3);
  assert.equal(responseBody(accepted).data.canCancelUntil, "2099-01-01T02:00:00.000Z");
  assert.equal("version" in responseBody(accepted).data, false);
});

test("create rate limits use exact trusted and anonymous buckets before service", async () => {
  const cases = [
    {
      requestContext: { http: { sourceIp: "198.51.100.7" } },
      expected: {
        scope: "create-ip",
        key: "198.51.100.7",
        limit: 5,
        windowMs: 10 * 60 * 1000,
      },
    },
    {
      requestContext: undefined,
      expected: {
        scope: "create-ip",
        key: "anonymous",
        limit: 2,
        windowMs: 10 * 60 * 1000,
      },
    },
  ];

  for (const item of cases) {
    const timeline = [];
    const response = await handlerFor(
      {
        async create() {
          timeline.push("service:create");
          throw new Error("CREATE_SHOULD_NOT_RUN");
        },
      },
      {
        rateLimiter: {
          async consume(request) {
            timeline.push({ rate: request });
            return false;
          },
        },
      },
    )(
      jsonEvent("POST", "/v1/bookings", createPayload(), {
        requestContext: item.requestContext,
      }),
    );
    assert.equal(response.statusCode, 429);
    assert.deepEqual(timeline, [{ rate: item.expected }]);
  }
});

test("lookup rate limits IP before code-plus-phone with exact thresholds", async () => {
  const cases = [
    {
      overrides: { requestContext: { http: { sourceIp: "198.51.100.8" } } },
      ipKey: "198.51.100.8",
      ipLimit: 10,
    },
    {
      overrides: { headers: { "x-forwarded-for": "203.0.113.9" } },
      ipKey: "anonymous",
      ipLimit: 3,
    },
  ];

  for (const item of cases) {
    const timeline = [];
    const response = await handlerFor(
      {
        async lookup() {
          timeline.push("service:lookup");
          return {
            code: "PUBLIC123",
            status: "pending",
            date: DATE,
            startAt: "2098-12-31T23:00:00.000Z",
            endAt: "2099-01-01T00:00:00.000Z",
            mode: "open",
            partySize: 1,
            name: "Ada Lovelace",
            phone: "13800138000",
            version: 1,
            canCancelUntil: "2098-12-31T23:00:00.000Z",
          };
        },
      },
      {
        rateLimiter: {
          async consume(request) {
            timeline.push({ rate: request });
            return true;
          },
        },
      },
    )(
      jsonEvent("POST", "/v1/bookings/lookup", {
        code: "public123",
        phone: "138 0013-8000",
      }, item.overrides),
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(timeline, [
      {
        rate: {
          scope: "lookup-ip",
          key: item.ipKey,
          limit: item.ipLimit,
          windowMs: 10 * 60 * 1000,
        },
      },
      {
        rate: {
          scope: "lookup-booking",
          key: "PUBLIC123\0" + "13800138000",
          limit: 5,
          windowMs: 10 * 60 * 1000,
        },
      },
      "service:lookup",
    ]);
  }
});

test("cancel and reschedule rate limits use the normalized code before any service call", async () => {
  for (const suffix of ["cancel", "reschedule-response"]) {
    const timeline = [];
    const response = await handlerFor(
      {
        async lookup() {
          timeline.push("service:lookup");
          throw new Error("LOOKUP_SHOULD_NOT_RUN");
        },
      },
      {
        rateLimiter: {
          async consume(request) {
            timeline.push({ rate: request });
            return false;
          },
        },
      },
    )(
      jsonEvent("POST", `/v1/bookings/public123/${suffix}`, {
        phone: "13800138000",
        expected_version: 1,
        accept: true,
      }),
    );
    assert.equal(response.statusCode, 429);
    assert.deepEqual(timeline, [
      {
        rate: {
          scope: "booking-mutation",
          key: "PUBLIC123",
          limit: 5,
          windowMs: 10 * 60 * 1000,
        },
      },
    ]);
  }
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
