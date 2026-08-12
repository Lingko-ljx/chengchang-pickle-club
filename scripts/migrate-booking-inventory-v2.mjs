import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ACTIVE_STATUSES = new Set(["pending", "confirmed", "reschedule_proposed"]);
const HALF_HOUR = 30;

class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new MigrationError(`Missing configuration: ${name}`);
  return value;
}

export function readMigrationConfiguration(environment = process.env) {
  const stage = requiredEnvironment(environment, "CLOUDBASE_DEPLOYMENT_STAGE");
  if (stage !== "staging") {
    throw new MigrationError("Invalid configuration: CLOUDBASE_DEPLOYMENT_STAGE");
  }
  const envId = requiredEnvironment(environment, "CLOUDBASE_ENV_ID");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(envId)) {
    throw new MigrationError("Invalid configuration: CLOUDBASE_ENV_ID");
  }
  return {
    stage,
    envId,
    secretId: requiredEnvironment(environment, "TENCENTCLOUD_SECRETID"),
    secretKey: requiredEnvironment(environment, "TENCENTCLOUD_SECRETKEY"),
  };
}

function shanghaiParts(instant) {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) throw new MigrationError("INVALID_BOOKING_WINDOW");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new MigrationError("INVALID_BOOKING_WINDOW");
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 0 || minutes >= 24 * 60 || Number(match[2]) >= 60) {
    throw new MigrationError("INVALID_BOOKING_WINDOW");
  }
  return minutes;
}

function cellKeys(startAt, endAt, expectedDate) {
  const start = shanghaiParts(startAt);
  const end = shanghaiParts(endAt);
  if (start.date !== expectedDate || end.date !== expectedDate) {
    throw new MigrationError("INVALID_BOOKING_WINDOW");
  }
  const startMinutes = clockMinutes(start.time);
  const endMinutes = clockMinutes(end.time);
  if (
    startMinutes % HALF_HOUR !== 0 ||
    endMinutes % HALF_HOUR !== 0 ||
    endMinutes <= startMinutes
  ) {
    throw new MigrationError("INVALID_BOOKING_WINDOW");
  }
  const keys = [];
  for (let minute = startMinutes; minute < endMinutes; minute += HALF_HOUR) {
    keys.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}`);
  }
  return keys;
}

function reservation(booking, kind, values) {
  if (
    typeof booking.id !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(values.date ?? "") ||
    typeof values.courtId !== "string" ||
    !["private", "open"].includes(booking.mode) ||
    !Number.isInteger(booking.partySize) ||
    booking.partySize < 1 ||
    booking.partySize > 4
  ) {
    throw new MigrationError("INVALID_BOOKING_RECORD");
  }
  return {
    bookingId: booking.id,
    kind,
    date: values.date,
    courtId: values.courtId,
    inventoryId: `${values.date}__court-${values.courtId}`,
    mode: booking.mode,
    partySize: booking.partySize,
    cellKeys: cellKeys(values.startAt, values.endAt, values.date),
  };
}

function activeReservations(bookings) {
  const active = bookings.filter((booking) => ACTIVE_STATUSES.has(booking?.status));
  const reservations = [];
  for (const booking of active) {
    reservations.push(reservation(booking, "current", {
      date: booking.date,
      startAt: booking.startAt,
      endAt: booking.endAt,
      courtId: booking.courtId,
    }));
    if (booking.status === "reschedule_proposed") {
      const proposedDate = /^\d{4}-\d{2}-\d{2}$/.test(booking.proposedDate ?? "")
        ? booking.proposedDate
        : typeof booking.proposedStartAt === "string"
          ? shanghaiParts(booking.proposedStartAt).date
          : typeof booking.proposedSessionId === "string" &&
              /^\d{4}-\d{2}-\d{2}/.test(booking.proposedSessionId)
            ? booking.proposedSessionId.slice(0, 10)
            : undefined;
      reservations.push(reservation(booking, "proposed", {
        date: proposedDate,
        startAt: booking.proposedStartAt,
        endAt: booking.proposedEndAt,
        courtId: booking.proposedCourtId,
      }));
    }
  }
  return { active, reservations };
}

function validCell(cell) {
  return (
    cell &&
    ["private", "open"].includes(cell.mode) &&
    Number.isInteger(cell.occupiedPlayers) &&
    cell.occupiedPlayers >= 1 &&
    cell.occupiedPlayers <= 4 &&
    Array.isArray(cell.bookingIds) &&
    cell.bookingIds.length > 0 &&
    new Set(cell.bookingIds).size === cell.bookingIds.length &&
    cell.bookingIds.every((id) => typeof id === "string" && id.length > 0) &&
    (cell.mode === "open" || cell.bookingIds.length === 1)
  );
}

function cloneInventory(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.date !== "string" ||
    typeof value.courtId !== "string" ||
    value.id !== `${value.date}__court-${value.courtId}` ||
    !value.cells ||
    typeof value.cells !== "object" ||
    Array.isArray(value.cells) ||
    !Number.isInteger(value.version) ||
    value.version < 1
  ) {
    throw new MigrationError("INVALID_INVENTORY_RECORD");
  }
  for (const [key, cell] of Object.entries(value.cells)) {
    if (!/^\d{4}$/.test(key) || !validCell(cell)) {
      throw new MigrationError("INVALID_INVENTORY_RECORD");
    }
  }
  return structuredClone(value);
}

function reservationConflict(cell, item) {
  if (!cell || cell.bookingIds.includes(item.bookingId)) return false;
  if (item.mode === "private") return true;
  return cell.mode !== "open" || cell.occupiedPlayers + item.partySize > 4;
}

export function planBookingInventoryMigration(bookings, existingInventories) {
  const { active, reservations } = activeReservations(structuredClone(bookings));
  const inventoryMap = new Map();
  for (const value of existingInventories) {
    const inventory = cloneInventory(value);
    if (inventoryMap.has(inventory.id)) throw new MigrationError("DUPLICATE_INVENTORY_RECORD");
    inventoryMap.set(inventory.id, inventory);
  }
  const changedIds = new Set();
  const conflicts = [];
  const incompleteInventoryIds = new Set();
  const reservationOwnership = new Set();
  for (const item of reservations) {
    for (const key of item.cellKeys) {
      const identity = `${item.bookingId}\0${item.inventoryId}\0${key}`;
      if (reservationOwnership.has(identity)) {
        conflicts.push(
          `DUPLICATE_BOOKING_RESERVATION:${item.inventoryId}/${key}:${item.bookingId}`,
        );
        incompleteInventoryIds.add(item.inventoryId);
      } else {
        reservationOwnership.add(identity);
      }
    }
  }

  for (const item of reservations.sort(
    (left, right) =>
      left.inventoryId.localeCompare(right.inventoryId) ||
      left.bookingId.localeCompare(right.bookingId) ||
      left.kind.localeCompare(right.kind),
  )) {
    const existing = inventoryMap.get(item.inventoryId);
    const inventory = existing ?? {
      id: item.inventoryId,
      date: item.date,
      courtId: item.courtId,
      cells: {},
      version: 0,
    };
    const blockedKeys = item.cellKeys.filter((key) =>
      reservationConflict(inventory.cells[key], item),
    );
    const closedKeys = item.cellKeys.filter((key) => inventory.blockedCells?.[key]);
    if (closedKeys.length > 0) {
      incompleteInventoryIds.add(item.inventoryId);
      for (const key of closedKeys) {
        conflicts.push(
          `INVENTORY_BLOCKED:${item.inventoryId}/${key}:${item.bookingId}:${item.kind}`,
        );
      }
      continue;
    }
    if (blockedKeys.length > 0) {
      incompleteInventoryIds.add(item.inventoryId);
      for (const key of blockedKeys) {
        conflicts.push(
          `INVENTORY_CONFLICT:${item.inventoryId}/${key}:${item.bookingId}:${item.kind}`,
        );
      }
      continue;
    }

    let changed = false;
    const next = structuredClone(inventory);
    for (const key of item.cellKeys) {
      const cell = next.cells[key];
      if (cell?.bookingIds.includes(item.bookingId)) continue;
      next.cells[key] = {
        mode: item.mode,
        occupiedPlayers: (cell?.occupiedPlayers ?? 0) + item.partySize,
        bookingIds: [...(cell?.bookingIds ?? []), item.bookingId],
      };
      changed = true;
    }
    if (changed) {
      inventoryMap.set(item.inventoryId, next);
      changedIds.add(item.inventoryId);
      incompleteInventoryIds.add(item.inventoryId);
    }
  }

  const allInventories = Array.from(inventoryMap.values())
    .map((inventory) => ({
      ...inventory,
      version: changedIds.has(inventory.id) ? inventory.version + 1 : inventory.version,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const changedInventories = allInventories.filter(({ id }) => changedIds.has(id));
  return {
    allInventories,
    changedInventories,
    conflicts: conflicts.sort(),
    incompleteInventoryIds: Array.from(incompleteInventoryIds).sort(),
    summary: {
      activeBookings: active.length,
      reservations: reservations.length,
      existingInventories: existingInventories.length,
      changedInventories: changedInventories.length,
    },
  };
}

function auditInventoryOwnership(bookings, inventories) {
  const { reservations } = activeReservations(structuredClone(bookings));
  const expected = new Map();
  for (const item of reservations) {
    let cells = expected.get(item.inventoryId);
    if (!cells) {
      cells = new Map();
      expected.set(item.inventoryId, cells);
    }
    for (const key of item.cellKeys) {
      let contributors = cells.get(key);
      if (!contributors) {
        contributors = new Map();
        cells.set(key, contributors);
      }
      if (!contributors.has(item.bookingId)) {
        contributors.set(item.bookingId, {
          mode: item.mode,
          partySize: item.partySize,
        });
      }
    }
  }

  const conflicts = [];
  const inventoryIds = new Set();
  for (const source of inventories) {
    const inventory = cloneInventory(source);
    const expectedCells = expected.get(inventory.id) ?? new Map();
    for (const [key, cell] of Object.entries(inventory.cells)) {
      const contributors = expectedCells.get(key);
      const expectedIds = contributors
        ? Array.from(contributors.keys()).sort()
        : [];
      const expectedModes = contributors
        ? new Set(Array.from(contributors.values(), ({ mode }) => mode))
        : new Set();
      const expectedPlayers = contributors
        ? Array.from(contributors.values()).reduce((total, value) => total + value.partySize, 0)
        : 0;
      const exact =
        expectedModes.size === 1 &&
        expectedModes.has(cell.mode) &&
        expectedPlayers === cell.occupiedPlayers &&
        JSON.stringify(expectedIds) === JSON.stringify(cell.bookingIds.slice().sort());
      if (!exact) {
        conflicts.push(`INVENTORY_OWNERSHIP_MISMATCH:${inventory.id}/${key}`);
        inventoryIds.add(inventory.id);
      }
    }
  }
  return { conflicts: conflicts.sort(), inventoryIds };
}

export function verifyBookingInventoryMigration(bookings, inventories) {
  const plan = planBookingInventoryMigration(bookings, inventories);
  const ownership = plan.conflicts.length === 0
    ? auditInventoryOwnership(bookings, inventories)
    : { conflicts: [], inventoryIds: new Set() };
  const conflicts = [...plan.conflicts, ...ownership.conflicts].sort();
  if (conflicts.length > 0 || plan.changedInventories.length > 0) {
    const incomplete = new Set([
      ...plan.incompleteInventoryIds,
      ...ownership.inventoryIds,
    ]);
    return {
      valid: false,
      conflicts,
      missingInventories: incomplete.size,
    };
  }
  return {
    valid: true,
    activeBookings: plan.summary.activeBookings,
    reservations: plan.summary.reservations,
    inventories: plan.allInventories.length,
  };
}

function documents(response) {
  const values = Array.isArray(response?.data)
    ? response.data
    : response?.data
      ? [response.data]
      : [];
  return values.map((value) => {
    const result = { ...value };
    delete result._id;
    return result;
  });
}

async function readAll(database, collectionName) {
  const values = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const page = documents(
      await database.collection(collectionName).skip(offset).limit(pageSize).get(),
    );
    values.push(...page);
    if (page.length < pageSize) return values;
  }
}

export async function readMigrationInputs(database) {
  const bookings = await readAll(database, "bookings");
  const inventories = await readAll(database, "court_day_allocations");
  return { bookings, inventories };
}

function checksum(inventories) {
  return createHash("sha256")
    .update(JSON.stringify(inventories.slice().sort((a, b) => a.id.localeCompare(b.id))))
    .digest("hex");
}

function bookingIdsByInventory(bookings) {
  const result = new Map();
  for (const item of activeReservations(structuredClone(bookings)).reservations) {
    let ids = result.get(item.inventoryId);
    if (!ids) {
      ids = new Set();
      result.set(item.inventoryId, ids);
    }
    ids.add(item.bookingId);
  }
  return result;
}

function inventoryBookingIds(inventory) {
  return new Set(
    Object.values(inventory?.cells ?? {}).flatMap((cell) =>
      Array.isArray(cell?.bookingIds) ? cell.bookingIds : [],
    ),
  );
}

function normalizedCells(cells) {
  return Object.fromEntries(
    Object.entries(cells)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, cell]) => [key, {
        ...cell,
        bookingIds: cell.bookingIds.slice().sort(),
      }]),
  );
}

function sameInventoryCells(left, right) {
  return JSON.stringify(normalizedCells(left)) === JSON.stringify(normalizedCells(right));
}

export async function applyBookingInventoryMigration(database, bookings, initialInventories, now = new Date()) {
  await database.collection("system_state").doc("booking-inventory-v2-migration").set({
    id: "booking-inventory-v2-migration",
    status: "running",
    schemaVersion: 2,
    startedAt: now.toISOString(),
  });
  const snapshotDesired = planBookingInventoryMigration(bookings, []);
  if (snapshotDesired.conflicts.length > 0) throw new MigrationError("INVENTORY_CONFLICT");
  const snapshotBookingIds = bookingIdsByInventory(bookings);
  const candidates = new Map();
  for (const source of initialInventories) {
    const inventory = cloneInventory(source);
    candidates.set(inventory.id, inventory);
  }
  for (const inventory of snapshotDesired.allInventories) {
    candidates.set(inventory.id, inventory);
  }

  for (const candidate of Array.from(candidates.values()).sort((left, right) => left.id.localeCompare(right.id))) {
    await database.runTransaction(async (transaction) => {
      const document = transaction.collection("court_day_allocations").doc(candidate.id);
      const currentValue = documents(await document.get())[0];
      const current = currentValue ? cloneInventory(currentValue) : null;
      const contributorIds = new Set(snapshotBookingIds.get(candidate.id) ?? []);
      for (const bookingId of inventoryBookingIds(current)) contributorIds.add(bookingId);

      const freshBookings = [];
      for (const bookingId of Array.from(contributorIds).sort()) {
        const booking = documents(
          await transaction.collection("bookings").doc(bookingId).get(),
        )[0];
        if (booking) freshBookings.push(booking);
      }
      const closureSeed = current
        ? [{ ...current, cells: {} }]
        : [];
      const freshDesired = planBookingInventoryMigration(freshBookings, closureSeed);
      if (freshDesired.conflicts.length > 0) throw new MigrationError("INVENTORY_CONFLICT");
      const desired = freshDesired.allInventories.find(({ id }) => id === candidate.id);
      const desiredCells = desired?.cells ?? {};
      if (!current || !sameInventoryCells(current.cells, desiredCells)) {
        await document.set({
          id: candidate.id,
          date: current?.date ?? candidate.date,
          courtId: current?.courtId ?? candidate.courtId,
          cells: desiredCells,
          ...(current?.blockedCells ? { blockedCells: current.blockedCells } : {}),
          ...(current?.timeBlocks ? { timeBlocks: current.timeBlocks } : {}),
          version: (current?.version ?? 0) + 1,
        });
      }
    }, 3);
  }

  const inputs = await readMigrationInputs(database);
  const verification = verifyBookingInventoryMigration(inputs.bookings, inputs.inventories);
  if (!verification.valid) throw new MigrationError("MIGRATION_POSTCONDITION_FAILED");
  await database.collection("system_state").doc("booking-inventory-v2-migration").set({
    id: "booking-inventory-v2-migration",
    status: "ready",
    schemaVersion: 2,
    verifiedAt: now.toISOString(),
    activeBookings: verification.activeBookings,
    reservations: verification.reservations,
    inventories: verification.inventories,
    inventoryChecksum: checksum(inputs.inventories),
  });
  return verification;
}

export async function createMigrationDatabase(configuration) {
  const cloudbaseModule = await import("@cloudbase/node-sdk");
  const app = cloudbaseModule.default.init({
    env: configuration.envId,
    secretId: configuration.secretId,
    secretKey: configuration.secretKey,
  });
  return app.database();
}

export async function migrateBookingInventoryV2({
  environment = process.env,
  apply = false,
  database,
} = {}) {
  const configuration = readMigrationConfiguration(environment);
  const resolvedDatabase = database ?? await createMigrationDatabase(configuration);
  const inputs = await readMigrationInputs(resolvedDatabase);
  const plan = planBookingInventoryMigration(inputs.bookings, inputs.inventories);
  if (!apply) {
    if (plan.conflicts.length > 0) throw new MigrationError("INVENTORY_CONFLICT");
    return { mode: "dry-run", ...plan.summary };
  }
  const verification = await applyBookingInventoryMigration(
    resolvedDatabase,
    inputs.bookings,
    inputs.inventories,
  );
  return { mode: "apply", ...verification };
}

export function formatMigrationError(error) {
  return error instanceof MigrationError ? error.message : "CloudBase migration failed";
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some((value) => !["--apply", "--dry-run"].includes(value))) {
      throw new MigrationError("INVALID_ARGUMENTS");
    }
    if (arguments_.includes("--apply") && arguments_.includes("--dry-run")) {
      throw new MigrationError("INVALID_ARGUMENTS");
    }
    const result = await migrateBookingInventoryV2({ apply: arguments_.includes("--apply") });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(formatMigrationError(error));
    process.exitCode = 1;
  }
}
