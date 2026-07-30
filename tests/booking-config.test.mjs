import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBookingEndpoint,
  resolveBookingScriptSrc,
} from "../app/booking-config.ts";

test("accepts only a Formspree HTTPS form endpoint", () => {
  assert.equal(
    resolveBookingEndpoint("https://formspree.io/f/testcontract"),
    "https://formspree.io/f/testcontract",
  );
  assert.equal(resolveBookingEndpoint("http://formspree.io/f/testcontract"), "");
  assert.equal(resolveBookingEndpoint("https://example.com/f/testcontract"), "");
  assert.equal(resolveBookingEndpoint(""), "");
});

test("builds the booking enhancement path for project pages", () => {
  assert.equal(resolveBookingScriptSrc(), "/booking-form.js");
  assert.equal(
    resolveBookingScriptSrc("/chengchang-pickle-club"),
    "/chengchang-pickle-club/booking-form.js",
  );
});
