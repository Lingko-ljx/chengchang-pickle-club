import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseCourt,
  chooseCourtDayInventory,
  releaseCourtDayInventory,
  reserveCourtDayInventory,
} from "../lib/booking/allocation.ts";

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

function dayInventory(courtId, cells = {}) {
  return {
    id: `2099-01-01__court-${courtId}`,
    date: "2099-01-01",
    courtId,
    cells,
    version: 0,
  };
}

test("window allocation requires one court to fit every requested cell", () => {
  const cells = ["0930", "1000", "1030", "1100"];
  const blocked = dayInventory("01", {
    "1030": { mode: "private", occupiedPlayers: 1, bookingIds: ["existing"] },
  });
  assert.equal(
    chooseCourtDayInventory("private", 2, cells, [blocked, dayInventory("02")]).courtId,
    "02",
  );
});

test("window reserve and release update every cell with one inventory version", () => {
  const cells = ["0930", "1000"];
  const reserved = reserveCourtDayInventory(
    dayInventory("01"),
    "open",
    2,
    "booking-1",
    cells,
  );
  assert.equal(reserved.version, 1);
  assert.deepEqual(Object.keys(reserved.cells).sort(), [...cells].sort());
  const released = releaseCourtDayInventory(reserved, 2, "booking-1", cells);
  assert.equal(released.version, 2);
  assert.deepEqual(released.cells, {});
});
