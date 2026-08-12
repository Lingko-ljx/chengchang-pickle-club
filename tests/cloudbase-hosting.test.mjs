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
        <link rel="stylesheet" href="/_next/static/chunks/site.css">
        <form action="${configuration.apiBaseUrl}/v1/bookings"
          data-availability-url="${configuration.apiBaseUrl}/v1/availability/windows"></form>
        <script data-booking-form-client src="/booking-form.js"></script>
        <script data-homepage-media-client src="/homepage-media.js"></script>
        <script data-honor-media-client src="/honor-media.js"></script>
        <script data-public-schedule-client src="/public-schedule.js"></script>`);
    }
    return htmlResponse(`<!doctype html>
      <link rel="stylesheet" href="/_next/static/chunks/site.css">
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
            '<script src="/_next/static/chunks/app.js"></script>',
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
      !error.message.includes("/_next/static/chunks/app.js"),
  );
  assert.equal(calls, 2);
  assert.equal(delays, 1);
});

test("public API smoke requires ready v2 windows, media and bounded retries", async () => {
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
      if (url.includes("/v1/admin/")) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "https://booking-staging.example",
            "Access-Control-Allow-Methods":
              init.headers["Access-Control-Request-Method"],
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        });
      }
      if (url.endsWith("/v1/homepage-media")) {
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://booking-staging.example",
            "Cache-Control": "no-store",
          },
        });
      }
      if (url.endsWith("/v1/honor-media")) {
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://booking-staging.example",
            "Cache-Control": "no-store",
          },
        });
      }
      if (url.endsWith("/v1/public-schedule?date=2099-01-01")) {
        return new Response(JSON.stringify({
          data: {
            date: "2099-01-01",
            bookingCount: 0,
            participantCount: 0,
            staffReservationCount: 0,
            items: [],
          },
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://booking-staging.example",
            "Cache-Control": "no-store",
          },
        });
      }
      return new Response(
        JSON.stringify({
          data: {
            policy: {
              openingTime: "09:00",
              closingTime: "22:00",
              startIntervalMinutes: 30,
              durationStepMinutes: 60,
            },
            windows: [{ sessionId: "2099-01-01__window-v2-0900-1000" }],
          },
        }),
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
    "https://booking-api.example/v1/admin/bookings/smoke-booking/confirm",
    "https://booking-api.example/v1/admin/courts/01",
    "https://booking-api.example/v1/admin/court-time-blocks/smoke-block",
    "https://booking-api.example/v1/availability/windows?date=2099-01-01",
    "https://booking-api.example/v1/homepage-media",
    "https://booking-api.example/v1/honor-media",
    "https://booking-api.example/v1/public-schedule?date=2099-01-01",
  ]);
  assert.deepEqual(requests[0].init.headers, {
    Origin: "https://booking-staging.example",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type,idempotency-key",
  });
  for (const [index, requestedMethod] of ["GET", "POST", "PUT", "DELETE"].entries()) {
    assert.deepEqual(requests[index + 1].init.headers, {
      Origin: "https://booking-staging.example",
      "Access-Control-Request-Method": requestedMethod,
      "Access-Control-Request-Headers": "authorization,content-type",
    });
    assert.equal("Authorization" in requests[index + 1].init.headers, false);
  }

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
          if (url.includes("/v1/admin/")) {
            return new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Origin": "https://booking-staging.example",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
              },
            });
          }
          availabilityAttempts += 1;
          return new Response(JSON.stringify({ data: { policy: {}, windows: [] } }), {
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

test("API smoke rejects every admin method, header, or origin mismatch", async () => {
  const mismatches = [
    {
      name: "GET method",
      suffix: "/v1/admin/dashboard",
      methods: "POST",
    },
    {
      name: "POST method",
      suffix: "/v1/admin/bookings/smoke-booking/confirm",
      methods: "GET",
    },
    {
      name: "PUT method",
      suffix: "/v1/admin/courts/01",
      methods: "GET",
    },
    {
      name: "Authorization header",
      suffix: "/v1/admin/dashboard",
      headers: "Content-Type",
    },
    {
      name: "Content-Type header",
      suffix: "/v1/admin/bookings/smoke-booking/confirm",
      headers: "Authorization",
    },
    {
      name: "origin",
      suffix: "/v1/admin/courts/01",
      origin: "https://wrong-origin.example",
    },
  ];

  for (const mismatch of mismatches) {
    const observedUrls = [];
    let availabilityCalls = 0;
    await assert.rejects(
      () =>
        verifyCloudBaseApi(configuration, {
          fetchImpl: async (url, init) => {
            observedUrls.push(url);
            if (url.endsWith("/v1/bookings")) {
              return new Response(null, {
                status: 204,
                headers: {
                  "Access-Control-Allow-Origin":
                    "https://booking-staging.example",
                  "Access-Control-Allow-Methods": "POST, OPTIONS",
                  "Access-Control-Allow-Headers":
                    "Content-Type, Idempotency-Key",
                },
              });
            }
            if (url.includes("/v1/admin/")) {
              const isMismatch = url.endsWith(mismatch.suffix);
              return new Response(null, {
                status: 204,
                headers: {
                  "Access-Control-Allow-Origin":
                    isMismatch && mismatch.origin
                      ? mismatch.origin
                      : "https://booking-staging.example",
                  "Access-Control-Allow-Methods":
                    isMismatch && mismatch.methods
                      ? mismatch.methods
                      : init.headers["Access-Control-Request-Method"],
                  "Access-Control-Allow-Headers":
                    isMismatch && mismatch.headers
                      ? mismatch.headers
                      : "Authorization, Content-Type",
                },
              });
            }
            availabilityCalls += 1;
            return new Response(
              JSON.stringify({
                data: {
                  policy: {
                    openingTime: "09:00",
                    closingTime: "22:00",
                    startIntervalMinutes: 30,
                    durationStepMinutes: 60,
                  },
                  windows: [{ sessionId: "2099-01-01__window-v2-0900-1000" }],
                },
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin":
                    "https://booking-staging.example",
                },
              },
            );
          },
          attempts: 1,
          delay: async () => undefined,
        }),
      /CloudBase public API smoke verification failed/,
      mismatch.name,
    );
    assert.ok(
      observedUrls.some((url) => url.endsWith(mismatch.suffix)),
      `${mismatch.name} preflight was not verified`,
    );
    assert.equal(availabilityCalls, 0, mismatch.name);
  }
});
