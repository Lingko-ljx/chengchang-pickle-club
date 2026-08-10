import assert from "node:assert/strict";
import test from "node:test";

const validPublicEnvironment = {
  RATE_LIMIT_SALT: "rate-limit-salt",
  PHONE_HASH_SALT: "phone-hmac-salt",
  IDEMPOTENCY_SALT: "idempotency-salt",
  PUBLIC_ALLOWED_ORIGINS: "https://lingko-ljx.github.io",
  PUBLIC_RESULT_URL:
    "https://lingko-ljx.github.io/chengchang-pickle-club/booking/result/",
  DATA_TIMEZONE: "Asia/Shanghai",
};

async function withEnvironment(values, work) {
  const previous = new Map();
  for (const name of Object.keys(values)) {
    previous.set(name, process.env[name]);
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const sanitizedInternalError = {
  error: {
    code: "INTERNAL_ERROR",
    message: "Service temporarily unavailable",
    retryable: true,
  },
};

test("public production configuration requires a phone salt and the Shanghai timezone", async () => {
  const runtime = await import("../cloudbase/src/runtime-config.ts");
  assert.equal(typeof runtime.readPublicRuntimeConfiguration, "function");

  assert.throws(
    () => runtime.readPublicRuntimeConfiguration({
      ...validPublicEnvironment,
      PHONE_HASH_SALT: " ",
    }),
    /PHONE_HASH_SALT/,
  );
  assert.throws(
    () => runtime.readPublicRuntimeConfiguration({
      ...validPublicEnvironment,
      DATA_TIMEZONE: "UTC",
    }),
    /DATA_TIMEZONE/,
  );
  assert.deepEqual(runtime.readPublicRuntimeConfiguration(validPublicEnvironment), {
    rateLimitSalt: "rate-limit-salt",
    phoneHashSalt: "phone-hmac-salt",
    idempotencySalt: "idempotency-salt",
    allowedOrigins: "https://lingko-ljx.github.io",
    resultUrl:
      "https://lingko-ljx.github.io/chengchang-pickle-club/booking/result/",
    timeZone: "Asia/Shanghai",
  });
});

test("public origins are origin-only and permit HTTP only for exact loopback hosts", async () => {
  const runtime = await import("../cloudbase/src/runtime-config.ts");
  assert.equal(
    runtime.readPublicRuntimeConfiguration({
      ...validPublicEnvironment,
      PUBLIC_ALLOWED_ORIGINS:
        "https://lingko-ljx.github.io, http://127.0.0.1:3001, http://localhost:3001",
    }).allowedOrigins,
    "https://lingko-ljx.github.io,http://127.0.0.1:3001,http://localhost:3001",
  );

  for (const value of [
    "*",
    "http://booking.example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?secret=value",
    "https://example.com#fragment",
    "http://localhost.evil.example:3001",
    "https://example.com\r\nX-Injected: yes",
  ]) {
    assert.throws(
      () => runtime.readPublicRuntimeConfiguration({
        ...validPublicEnvironment,
        PUBLIC_ALLOWED_ORIGINS: value,
      }),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid configuration: PUBLIC_ALLOWED_ORIGINS" &&
        !error.message.includes(value),
    );
  }
});

test("public result URL is credential-free HTTPS on an allowed origin", async () => {
  const runtime = await import("../cloudbase/src/runtime-config.ts");
  const allowedOrigins = "https://lingko-ljx.github.io,https://booking.example.com";
  assert.equal(
    runtime.readPublicRuntimeConfiguration({
      ...validPublicEnvironment,
      PUBLIC_ALLOWED_ORIGINS: allowedOrigins,
      PUBLIC_RESULT_URL:
        "https://lingko-ljx.github.io/chengchang-pickle-club/booking/result/",
    }).resultUrl,
    "https://lingko-ljx.github.io/chengchang-pickle-club/booking/result/",
  );

  for (const value of [
    "http://lingko-ljx.github.io/booking/result/",
    "https://attacker.example/booking/result/",
    "https://user:password@lingko-ljx.github.io/booking/result/",
    "https://lingko-ljx.github.io/booking/result/?secret=value",
    "https://lingko-ljx.github.io/booking/result/#fragment",
    "https://lingko-ljx.github.io/booking/result/?",
    "https://lingko-ljx.github.io/booking/result/#",
    "https://lingko-ljx.github.io/booking/result/\r\nLocation: https://attacker.example",
  ]) {
    assert.throws(
      () => runtime.readPublicRuntimeConfiguration({
        ...validPublicEnvironment,
        PUBLIC_ALLOWED_ORIGINS: allowedOrigins,
        PUBLIC_RESULT_URL: value,
      }),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid configuration: PUBLIC_RESULT_URL" &&
        !error.message.includes(value),
    );
  }
});

test("admin production configuration requires Shanghai but never consumes the phone salt", async () => {
  const runtime = await import("../cloudbase/src/runtime-config.ts");
  assert.equal(typeof runtime.readAdminRuntimeConfiguration, "function");
  const accessed = [];
  const environment = new Proxy(
    {
      CLOUDBASE_ENV_ID: "booking-test-000001",
      DATA_TIMEZONE: "Asia/Shanghai",
      BOOKING_ADMIN_USER_IDS:
        '["2086466604197666817","123456789"]',
      PHONE_HASH_SALT: "must-not-be-read",
    },
    {
      get(target, property, receiver) {
        if (typeof property === "string") accessed.push(property);
        return Reflect.get(target, property, receiver);
      },
    },
  );

  assert.deepEqual(runtime.readAdminRuntimeConfiguration(environment), {
    envId: "booking-test-000001",
    timeZone: "Asia/Shanghai",
    allowedUserIds: ["2086466604197666817", "123456789"],
  });
  assert.deepEqual(accessed, [
    "CLOUDBASE_ENV_ID",
    "DATA_TIMEZONE",
    "BOOKING_ADMIN_USER_IDS",
  ]);
  assert.throws(
    () => runtime.readAdminRuntimeConfiguration({
      CLOUDBASE_ENV_ID: "booking-test-000001",
      DATA_TIMEZONE: "UTC",
      BOOKING_ADMIN_USER_IDS: '["2086466604197666817"]',
    }),
    /DATA_TIMEZONE/,
  );
});

test("admin production configuration rejects every env ID that could change the auth host", async () => {
  const runtime = await import("../cloudbase/src/runtime-config.ts");
  for (const envId of [
    "attacker.example/",
    "booking-test?redirect=attacker",
    "booking.test",
    "booking@test",
  ]) {
    assert.throws(
      () => runtime.readAdminRuntimeConfiguration({
        CLOUDBASE_ENV_ID: envId,
        DATA_TIMEZONE: "Asia/Shanghai",
        BOOKING_ADMIN_USER_IDS: '["2086466604197666817"]',
      }),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid configuration: CLOUDBASE_ENV_ID" &&
        !error.message.includes(envId),
    );
  }
});

test("admin user allowlist is a strict JSON array of canonical exact IDs", async () => {
  const runtime = await import("../cloudbase/src/runtime-config.ts");
  const invalidValues = [
    undefined,
    "",
    "{}",
    '"2086466604197666817"',
    "not-json",
    "[2086466604197666817]",
    '[""]',
    '[" admin"]',
    '["admin "]',
    '["admin@example.com"]',
    '["admin/child"]',
    '["admin\\nchild"]',
    '["administrator"]',
    '["0"]',
    '["01"]',
    '["2086466604197666817","2086466604197666817"]',
    `["${"9".repeat(33)}"]`,
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => runtime.readAdminRuntimeConfiguration({
        CLOUDBASE_ENV_ID: "booking-test-000001",
        DATA_TIMEZONE: "Asia/Shanghai",
        BOOKING_ADMIN_USER_IDS: value,
      }),
      (error) =>
        error instanceof Error &&
        /BOOKING_ADMIN_USER_IDS/.test(error.message) &&
        !error.message.includes("admin@example.com") &&
        !error.message.includes("admin/child"),
      String(value),
    );
  }
  assert.deepEqual(
    runtime.readAdminRuntimeConfiguration({
      CLOUDBASE_ENV_ID: "booking-test-000001",
      DATA_TIMEZONE: "Asia/Shanghai",
      BOOKING_ADMIN_USER_IDS: "[]",
    }).allowedUserIds,
    [],
  );
});

test("public production entry sanitizes a missing phone salt before handling OPTIONS", async () => {
  const { main } = await import("../cloudbase/src/public-api.ts");
  const response = await withEnvironment(
    { ...validPublicEnvironment, PHONE_HASH_SALT: undefined },
    () => main({
      httpMethod: "OPTIONS",
      path: "/v1/bookings",
      headers: { origin: "https://lingko-ljx.github.io" },
    }),
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), sanitizedInternalError);
  assert.doesNotMatch(response.body, /PHONE_HASH_SALT|phone-hmac-salt/);
});

test("public production entry sanitizes a cross-origin result URL before handling OPTIONS", async () => {
  const { main } = await import("../cloudbase/src/public-api.ts");
  const response = await withEnvironment(
    {
      ...validPublicEnvironment,
      PUBLIC_RESULT_URL: "https://attacker.example/result/",
    },
    () => main({
      httpMethod: "OPTIONS",
      path: "/v1/bookings",
      headers: { origin: "https://lingko-ljx.github.io" },
    }),
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), sanitizedInternalError);
  assert.doesNotMatch(response.body, /attacker|PUBLIC_RESULT_URL/);
});

test("admin production entry sanitizes a non-Shanghai timezone before authentication", async () => {
  const { main } = await import("../cloudbase/src/admin-api.ts");
  const response = await withEnvironment(
    {
      CLOUDBASE_ENV_ID: "booking-test-000001",
      DATA_TIMEZONE: "UTC",
      BOOKING_ADMIN_USER_IDS: '["2086466604197666817"]',
    },
    () => main({
      httpMethod: "GET",
      path: "/v1/admin/dashboard",
      headers: {},
    }),
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), sanitizedInternalError);
  assert.doesNotMatch(response.body, /DATA_TIMEZONE|UTC/);
});

test("admin production entry rejects an unsafe env ID before forwarding its bearer token", async () => {
  const { main } = await import("../cloudbase/src/admin-api.ts");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("AUTH_FETCH_MUST_NOT_RUN");
  };
  try {
    const response = await withEnvironment(
      {
        CLOUDBASE_ENV_ID: "attacker.example/",
        DATA_TIMEZONE: "Asia/Shanghai",
        BOOKING_ADMIN_USER_IDS: '["2086466604197666817"]',
      },
      () => main({
        httpMethod: "GET",
        path: "/v1/admin/dashboard",
        headers: { authorization: "Bearer staff-token-canary" },
      }),
    );

    assert.equal(fetchCalls, 0);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), sanitizedInternalError);
    assert.doesNotMatch(response.body, /attacker|staff-token-canary|CLOUDBASE_ENV_ID/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin production entry fails closed on a missing allowlist before authentication", async () => {
  const { main } = await import("../cloudbase/src/admin-api.ts");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("AUTH_FETCH_MUST_NOT_RUN");
  };
  try {
    const response = await withEnvironment(
      {
        CLOUDBASE_ENV_ID: "booking-test-000001",
        DATA_TIMEZONE: "Asia/Shanghai",
        BOOKING_ADMIN_USER_IDS: undefined,
      },
      () => main({
        httpMethod: "GET",
        path: "/v1/admin/dashboard",
        headers: { authorization: "Bearer staff-token-canary" },
      }),
    );

    assert.equal(fetchCalls, 0);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(JSON.parse(response.body), sanitizedInternalError);
    assert.doesNotMatch(response.body, /BOOKING_ADMIN_USER_IDS|staff-token-canary/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
