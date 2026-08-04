import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition } from "../lib/booking/state-machine.ts";

test("allows every pending-state transition", () => {
  for (const target of ["confirmed", "reschedule_proposed", "cancelled"]) {
    assert.doesNotThrow(() => assertTransition("pending", target));
  }
});

test("allows a reschedule proposal to return to pending", () => {
  assert.doesNotThrow(() => assertTransition("reschedule_proposed", "pending"));
});

test("rejects transitions out of terminal states", () => {
  assert.throws(() => assertTransition("cancelled", "confirmed"), /INVALID_TRANSITION/);
  assert.throws(() => assertTransition("completed", "cancelled"), /INVALID_TRANSITION/);
});
