import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBookingSummary,
  validateBooking,
} from "../app/booking-model.ts";

const validDraft = {
  date: "7月30日 周四",
  time: "19:00",
  partySize: 2,
  name: "林先生",
  phone: "13800138000",
};

test("accepts a complete booking draft", () => {
  assert.deepEqual(validateBooking(validDraft), {});
});

test("returns field-level errors for incomplete details", () => {
  assert.deepEqual(
    validateBooking({ ...validDraft, time: "", phone: "123" }),
    { time: "请选择体验时段", phone: "请填写有效的联系电话" },
  );
});

test("rejects a party size outside the supported range", () => {
  assert.deepEqual(validateBooking({ ...validDraft, partySize: 9 }), {
    partySize: "请选择 1–8 位参与者",
  });
});

test("formats the confirmation summary", () => {
  assert.equal(
    formatBookingSummary(validDraft),
    "7月30日 周四 · 19:00 · 2位",
  );
});
