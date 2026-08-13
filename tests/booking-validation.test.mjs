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
    publicScheduleConsentVersion: 1,
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

test("public schedule consent is independently versioned and remains optional", () => {
  const legacyClientInput = validInput();
  delete legacyClientInput.publicScheduleConsentVersion;
  assert.deepEqual(validateCreateBooking(legacyClientInput), legacyClientInput);
  assert.deepEqual(
    validateCreateBooking(validInput({
      publicScheduleConsentVersion: 2,
      hidePublicName: true,
    })),
    validInput({
      publicScheduleConsentVersion: 2,
      hidePublicName: true,
    }),
  );
  assert.throws(
    () => validateCreateBooking(validInput({ publicScheduleConsentVersion: 3 })),
    /INVALID_INPUT/,
  );
  assert.throws(
    () => validateCreateBooking(validInput({
      publicScheduleConsentVersion: 1,
      hidePublicName: true,
    })),
    /INVALID_INPUT/,
  );
  assert.throws(
    () => validateCreateBooking(validInput({
      publicScheduleConsentVersion: 2,
      hidePublicName: false,
    })),
    /INVALID_INPUT/,
  );
});

test("public full names are canonicalized and unsafe public identifiers are rejected", () => {
  assert.equal(
    validateCreateBooking(validInput({ name: "  Jean-Luc O'Neill　·　刘栖睿  " })).name,
    "Jean-Luc O'Neill · 刘栖睿",
  );

  for (const name of [
    "刘\n栖睿",
    "刘\u200b栖睿",
    "<img src=x onerror=alert(1)>",
    "刘&#x6816;睿",
    "ada@example.com",
    "张三 ada@example.com",
    "138 0013 8000",
    "张三（138 0013 8000）",
    "— — —",
    "刘".repeat(41),
  ]) {
    assert.throws(() => validateCreateBooking(validInput({ name })), /INVALID_INPUT/, name);
  }
});

test("accepts a complete v2 booking window without requiring a legacy session id", () => {
  const base = validInput();
  delete base.sessionId;
  const input = {
    ...base,
    date: "2099-01-01",
    startTime: "09:30",
    endTime: "11:30",
  };
  assert.deepEqual(validateCreateBooking(input), input);
});

test("rejects mixed, partial, and invalid v2 booking windows", () => {
  assert.throws(
    () =>
      validateCreateBooking(
        validInput({ date: "2099-01-01", startTime: "09:30", endTime: "10:30" }),
      ),
    /INVALID_INPUT/,
  );
  const base = validInput();
  delete base.sessionId;
  assert.throws(
    () => validateCreateBooking({ ...base, date: "2099-01-01", startTime: "09:30" }),
    /INVALID_INPUT/,
  );
  assert.throws(
    () =>
      validateCreateBooking({
        ...base,
        date: "2099-01-01",
        startTime: "09:30",
        endTime: "11:00",
      }),
    /INVALID_INPUT/,
  );
});
