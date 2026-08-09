import assert from "node:assert/strict";
import test from "node:test";
import * as bookingConfig from "../app/booking-config.ts";

const {
  bookingCreateUrl,
  bookingResultPath,
  bookingStatusPath,
  resolveBookingApiBaseUrl,
  resolveBookingScriptSrc,
} = bookingConfig;

test("production booking API configuration accepts HTTPS and rejects insecure or malformed URLs", () => {
  assert.equal(
    resolveBookingApiBaseUrl("https://booking.example.com/api/"),
    "https://booking.example.com/api/",
  );
  assert.equal(resolveBookingApiBaseUrl("http://booking.example.com"), "");
  assert.equal(resolveBookingApiBaseUrl("https:booking.example.com"), "");
  assert.equal(resolveBookingApiBaseUrl("javascript:alert(1)"), "");
  assert.equal(resolveBookingApiBaseUrl("https://user:pass@example.com"), "");
  assert.equal(resolveBookingApiBaseUrl("https://example.com/api?token=secret"), "");
});

test("development booking API configuration permits only HTTP loopback hosts", () => {
  const development = { development: true };

  assert.equal(
    resolveBookingApiBaseUrl("http://localhost:8788", development),
    "http://localhost:8788",
  );
  assert.equal(
    resolveBookingApiBaseUrl("http://127.0.0.1:8788/api", development),
    "http://127.0.0.1:8788/api",
  );
  assert.equal(
    resolveBookingApiBaseUrl("https://booking.example.com", development),
    "https://booking.example.com",
  );
  assert.equal(
    resolveBookingApiBaseUrl("http://localhost.evil.example", development),
    "",
  );
  assert.equal(resolveBookingApiBaseUrl("http://0.0.0.0:8788", development), "");
});

test("only a required Pages configuration fails closed", () => {
  assert.equal(resolveBookingApiBaseUrl(""), "");
  assert.equal(resolveBookingApiBaseUrl("not a URL"), "");
  assert.throws(
    () => resolveBookingApiBaseUrl("", { required: true }),
    /NEXT_PUBLIC_BOOKING_API_BASE_URL/,
  );
  assert.throws(
    () => resolveBookingApiBaseUrl("http://booking.example.com", { required: true }),
    /NEXT_PUBLIC_BOOKING_API_BASE_URL/,
  );
});

test("builds booking API and base-path-aware public page URLs", () => {
  assert.equal(
    bookingCreateUrl("https://booking.example.com/api///"),
    "https://booking.example.com/api/v1/bookings",
  );
  assert.equal(bookingResultPath(), "/booking/result/");
  assert.equal(
    bookingResultPath("/chengchang-pickle-club"),
    "/chengchang-pickle-club/booking/result/",
  );
  assert.equal(bookingStatusPath(), "/booking/status/");
  assert.equal(
    bookingStatusPath("/chengchang-pickle-club"),
    "/chengchang-pickle-club/booking/status/",
  );
});

test("builds the booking enhancement path for project pages", () => {
  assert.equal(resolveBookingScriptSrc(), "/booking-form.js");
  assert.equal(
    resolveBookingScriptSrc("/chengchang-pickle-club"),
    "/chengchang-pickle-club/booking-form.js",
  );
});
