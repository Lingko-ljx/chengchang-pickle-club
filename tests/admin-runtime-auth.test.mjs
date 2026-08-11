import assert from "node:assert/strict";
import test from "node:test";

import { createAdminApiHandler, main } from "../cloudbase/src/admin-api.ts";
import { cloudbaseApp } from "../cloudbase/src/cloudbase-app.ts";
import { resolveTrustedRuntimeUid } from "../cloudbase/src/auth/current-user.ts";

const ALLOWED_UID = "2086466604197666817";
const OTHER_UID = "2086466604197666818";
const DATE = "2099-01-01";

function gatewayContext(uid) {
  return {
    memory_limit_in_mb: 128,
    time_limit_in_ms: 3_000,
    request_id: "admin-runtime-auth-contract",
    function_version: "$LATEST",
    function_name: "booking-admin-api",
    namespace: "booking-test",
    environment: JSON.stringify({
      TCB_CONTEXT_KEYS: "TCB_UUID,LOGINTYPE",
      TCB_UUID: uid,
      LOGINTYPE: "CUSTOM",
    }),
  };
}

function event(method, path, body, overrides = {}) {
  return {
    httpMethod: method,
    path,
    headers: {
      Authorization: "Bearer forged-browser-canary",
      "X-CloudBase-Uid": ALLOWED_UID,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...overrides.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      authorizer: { uid: ALLOWED_UID, user_id: ALLOWED_UID },
    },
    ...(overrides.query ? { queryStringParameters: overrides.query } : {}),
  };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

function service(trace) {
  return {
    async listBookings(filter) {
      trace.push(["listBookings", filter]);
      return [];
    },
    async listPendingBookings(date) {
      trace.push(["listPendingBookings", date]);
      return [];
    },
    async listAvailability(date) {
      trace.push(["listAvailability", date]);
      return [];
    },
  };
}

function handlerFor(uid, trace, options = {}) {
  return createAdminApiHandler({
    service: service(trace),
    allowedUserIds: options.allowedUserIds ?? [ALLOWED_UID],
    resolveTrustedUid: async (context) => {
      trace.push(["runtime-auth", context]);
      if (uid instanceof Error) throw uid;
      return uid;
    },
  });
}

test("the pinned CloudBase SDK resolves concurrent gateway contexts without mixing UIDs", async () => {
  const auth = cloudbaseApp.auth();
  const trustedAuth = {
    getAuthContext: (context) => auth.getAuthContext(context),
  };
  const [allowedUid, otherUid] = await Promise.all([
    resolveTrustedRuntimeUid(trustedAuth, gatewayContext(ALLOWED_UID)),
    resolveTrustedRuntimeUid(trustedAuth, gatewayContext(OTHER_UID)),
  ]);

  assert.equal(allowedUid, ALLOWED_UID);
  assert.equal(otherUid, OTHER_UID);
});

test("an exact allowlisted runtime UID can use legacy admin endpoints without header passthrough", async () => {
  const trace = [];
  const context = gatewayContext(ALLOWED_UID);
  const handler = handlerFor(ALLOWED_UID, trace);

  const bookings = await handler(
    event("GET", "/v1/admin/bookings", undefined, { headers: { Authorization: undefined } }),
    context,
  );
  const dashboard = await handler(
    event("GET", "/v1/admin/dashboard", undefined, {
      headers: { Authorization: undefined },
      query: { date: DATE },
    }),
    context,
  );

  assert.equal(bookings.statusCode, 200);
  assert.equal(dashboard.statusCode, 200);
  assert.equal(trace.filter(([name]) => name === "runtime-auth").length, 2);
  assert.equal(trace[0][1], context);
});

test("a valid but non-allowlisted runtime UID is forbidden before service work", async () => {
  const trace = [];
  const response = await handlerFor(OTHER_UID, trace)(
    event("GET", "/v1/admin/bookings"),
    gatewayContext(OTHER_UID),
  );

  assert.equal(response.statusCode, 403);
  assert.deepEqual(responseBody(response), {
    error: { code: "FORBIDDEN", message: "Forbidden", retryable: false },
  });
  assert.equal(trace.some(([name]) => name === "listBookings"), false);
});

test("missing and malformed runtime UIDs fail closed with sanitized 401 responses", async () => {
  for (const uid of [undefined, "", " 2086466604197666817", "not-a-cloudbase-uid", 2086466604197666817]) {
    const trace = [];
    const response = await handlerFor(uid, trace)(
      event("GET", "/v1/admin/bookings"),
      gatewayContext(ALLOWED_UID),
    );

    assert.equal(response.statusCode, 401, String(uid));
    assert.deepEqual(responseBody(response), {
      error: { code: "AUTH_REQUIRED", message: "Authentication required", retryable: false },
    });
    assert.equal(response.body.includes("cloudbase-uid"), false);
    assert.equal(trace.some(([name]) => name === "listBookings"), false);
  }
});

test("forged event headers, body identity and authorizer fields cannot grant access", async () => {
  const trace = [];
  const response = await handlerFor(OTHER_UID, trace)(
    event("POST", "/v1/admin/bookings/booking-1/confirm", {
      expectedVersion: 1,
      uid: ALLOWED_UID,
      user_id: ALLOWED_UID,
    }),
    gatewayContext(OTHER_UID),
  );

  assert.equal(response.statusCode, 403);
  assert.equal(trace.length, 1);
  assert.equal(trace[0][0], "runtime-auth");
});

test("runtime identity lookup errors and malformed context results fail closed", async () => {
  const cases = [
    {
      async getAuthContext() {
        throw new Error("raw runtime auth canary");
      },
    },
    { async getAuthContext() { return {}; } },
    { async getAuthContext() { return { uid: "not-a-cloudbase-uid" }; } },
  ];
  for (const auth of cases) {
    await assert.rejects(
      () => resolveTrustedRuntimeUid(auth, gatewayContext(ALLOWED_UID)),
      (error) =>
        error?.code === "AUTH_REQUIRED" &&
        !String(error?.message).includes("raw runtime auth canary"),
    );
  }
});

test("production main forwards its second argument to CloudBase runtime authentication", async () => {
  const names = [
    "CLOUDBASE_ENV_ID",
    "DATA_TIMEZONE",
    "BOOKING_ADMIN_USER_IDS",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    CLOUDBASE_ENV_ID: "booking-test-000001",
    DATA_TIMEZONE: "Asia/Shanghai",
    BOOKING_ADMIN_USER_IDS: JSON.stringify([ALLOWED_UID]),
  });
  try {
    const response = await main(
      event("GET", "/v1/admin/not-a-route"),
      gatewayContext(ALLOWED_UID),
    );
    assert.equal(response.statusCode, 404);
    assert.deepEqual(responseBody(response), {
      error: { code: "BOOKING_NOT_FOUND", message: "Booking not found", retryable: false },
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
