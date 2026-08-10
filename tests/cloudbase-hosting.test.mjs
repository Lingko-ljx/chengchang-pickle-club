import assert from "node:assert/strict";
import test from "node:test";

import {
  readCloudBaseHostingConfiguration,
  verifyCloudBaseApi,
  verifyCloudBaseHosting,
} from "../scripts/verify-cloudbase-hosting.mjs";

const environment = {
  CLOUDBASE_SITE_URL: "https://booking-staging.example/",
  BOOKING_API_BASE_URL: "https://booking-api.example",
  CLOUDBASE_ENV_ID: "booking-test-000001",
};

const configuration = {
  siteUrl: "https://booking-staging.example/",
  apiBaseUrl: "https://booking-api.example",
  envId: "booking-test-000001",
};

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

test("hosting configuration requires exact HTTPS root origins and a safe env ID", () => {
  assert.deepEqual(readCloudBaseHostingConfiguration(environment), configuration);
  assert.deepEqual(
    readCloudBaseHostingConfiguration({
      ...environment,
      CLOUDBASE_SITE_URL: "https://booking-staging.example",
      BOOKING_API_BASE_URL: "https://booking-api.example/",
    }),
    configuration,
  );

  for (const [name, value] of [
    ["CLOUDBASE_SITE_URL", undefined],
    ["CLOUDBASE_SITE_URL", "http://booking-staging.example/"],
    ["CLOUDBASE_SITE_URL", "https://booking-staging.example/admin/"],
    ["CLOUDBASE_SITE_URL", "https://user:pass@booking-staging.example/"],
    ["CLOUDBASE_SITE_URL", "https://booking-staging.example/?secret=value"],
    ["CLOUDBASE_SITE_URL", "https://booking-staging.example/#fragment"],
    ["BOOKING_API_BASE_URL", "https://booking-api.example/v1"],
    ["BOOKING_API_BASE_URL", "https://booking-api.example\r\nattacker"],
    ["CLOUDBASE_ENV_ID", "attacker.example/"],
  ]) {
    assert.throws(
      () =>
        readCloudBaseHostingConfiguration({
          ...environment,
          [name]: value,
        }),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid CloudBase hosting configuration" &&
        !error.message.includes("secret=value") &&
        !error.message.includes("attacker"),
      `${name}: ${String(value)}`,
    );
  }
});

test("deployed page smoke requires real public/admin configuration and only approved clients", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url === configuration.siteUrl) {
      return htmlResponse(`<!doctype html>
        <form action="${configuration.apiBaseUrl}/v1/bookings"
          data-availability-url="${configuration.apiBaseUrl}/v1/availability"></form>
        <script data-booking-form-client src="/booking-form.js"></script>`);
    }
    return htmlResponse(`<!doctype html>
      <section data-api-base-url="${configuration.apiBaseUrl}"
        data-cloudbase-env-id="${configuration.envId}"></section>
      <script data-admin-client src="/admin-app.js"></script>`);
  };

  await verifyCloudBaseHosting(configuration, {
    fetchImpl,
    attempts: 1,
    delay: async () => undefined,
  });

  assert.deepEqual(urls, [
    "https://booking-staging.example/",
    "https://booking-staging.example/admin/",
  ]);
});

test("page smoke retries within a fixed bound and rejects runtime or secret leakage", async () => {
  let calls = 0;
  let delays = 0;
  await assert.rejects(
    () =>
      verifyCloudBaseHosting(configuration, {
        fetchImpl: async () => {
          calls += 1;
          return htmlResponse(
            '<script src="/_next/static/chunks/app.js"></script>BOOKING_ADMIN_USER_IDS',
          );
        },
        attempts: 2,
        delay: async () => {
          delays += 1;
        },
      }),
    (error) =>
      error instanceof Error &&
      error.message === "CloudBase hosting smoke verification failed" &&
      !error.message.includes("BOOKING_ADMIN_USER_IDS"),
  );
  assert.equal(calls, 2);
  assert.equal(delays, 1);
});

test("public API smoke requires a non-empty availability response and bounded retries", async () => {
  const requests = [];
  await verifyCloudBaseApi(configuration, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/v1/bookings")) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "https://booking-staging.example",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
          },
        });
      }
      if (url.endsWith("/v1/admin/dashboard")) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "https://booking-staging.example",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        });
      }
      return new Response(
        JSON.stringify({ data: [{ sessionId: "2099-01-01__slot-0700" }] }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://booking-staging.example",
          },
        },
      );
    },
    attempts: 1,
    delay: async () => undefined,
  });
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://booking-api.example/v1/bookings",
    "https://booking-api.example/v1/admin/dashboard",
    "https://booking-api.example/v1/availability?date=2099-01-01",
  ]);
  assert.deepEqual(requests[0].init.headers, {
    Origin: "https://booking-staging.example",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type,idempotency-key",
  });
  assert.deepEqual(requests[1].init.headers, {
    Origin: "https://booking-staging.example",
    "Access-Control-Request-Method": "GET",
    "Access-Control-Request-Headers": "authorization,content-type",
  });
  assert.equal("Authorization" in requests[1].init.headers, false);

  let availabilityAttempts = 0;
  await assert.rejects(
    () =>
      verifyCloudBaseApi(configuration, {
        fetchImpl: async (url) => {
          if (url.endsWith("/v1/bookings")) {
            return new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Origin": "https://booking-staging.example",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key",
              },
            });
          }
          if (url.endsWith("/v1/admin/dashboard")) {
            return new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Origin": "https://booking-staging.example",
                "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
              },
            });
          }
          availabilityAttempts += 1;
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://booking-staging.example",
            },
          });
        },
        attempts: 3,
        delay: async () => undefined,
      }),
    /CloudBase public API smoke verification failed/,
  );
  assert.equal(availabilityAttempts, 3);
});

test("API smoke rejects incomplete public or admin preflight before static deploy", async () => {
  let availabilityCalls = 0;
  await assert.rejects(
    () =>
      verifyCloudBaseApi(configuration, {
        fetchImpl: async (url) => {
          if (url.includes("availability")) availabilityCalls += 1;
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "https://booking-staging.example",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          });
        },
        attempts: 1,
        delay: async () => undefined,
      }),
    /CloudBase public API smoke verification failed/,
  );
  assert.equal(availabilityCalls, 0);
});
