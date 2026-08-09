import assert from "node:assert/strict";
import test from "node:test";
import { chooseCourt } from "../lib/booking/allocation.ts";

function emptyCourt(courtId) {
  return {
    id: `allocation-${courtId}`,
    sessionId: "session-001",
    courtId,
    mode: "empty",
    occupiedPlayers: 0,
    bookingIds: [],
    version: 1,
  };
}

function openCourt(courtId, occupiedPlayers) {
  return {
    ...emptyCourt(courtId),
    mode: "open",
    occupiedPlayers,
    bookingIds: [`booking-${courtId}`],
  };
}

test("private booking chooses only an empty court", () => {
  assert.equal(chooseCourt("private", 4, [openCourt("01", 1), emptyCourt("02")]).courtId, "02");
});

test("open booking fills the fullest court that fits the whole group", () => {
  const chosen = chooseCourt("open", 2, [openCourt("01", 1), openCourt("02", 2), emptyCourt("03")]);
  assert.equal(chosen.courtId, "02");
});

test("open booking does not split a group across a nearly full court", () => {
  assert.equal(chooseCourt("open", 2, [openCourt("01", 3), emptyCourt("02")]).courtId, "02");
});

test("invalid party sizes are rejected before allocation", () => {
  assert.throws(() => chooseCourt("open", 0, [emptyCourt("01")]), /INVALID_PARTY_SIZE/);
});
