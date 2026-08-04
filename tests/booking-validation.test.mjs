import assert from "node:assert/strict";
import test from "node:test";
import { validateCreateBooking } from "../lib/booking/validation.ts";

function validInput(overrides = {}) {
  return {
    idempotencyKey: "request-001",
    sessionId: "session-001",
    mode: "open",
    partySize: 2,
    name: "Ada Lovelace",
    phone: "13800138000",
    email: "ada@example.com",
    note: "Window side if available",
    privacyConsent: true,
    ...overrides,
  };
}

test("accepts a complete booking command", () => {
  assert.deepEqual(validateCreateBooking(validInput()), validInput());
});

test("rejects every booking outside one to four players", () => {
  assert.throws(() => validateCreateBooking(validInput({ partySize: 0 })), /INVALID_PARTY_SIZE/);
  assert.throws(() => validateCreateBooking(validInput({ partySize: 5 })), /INVALID_PARTY_SIZE/);
});
