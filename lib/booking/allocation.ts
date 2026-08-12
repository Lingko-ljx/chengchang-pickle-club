import { BookingError } from "./errors.ts";
import type {
  BookingMode,
  CourtAllocation,
  CourtDayCell,
  CourtDayInventory,
} from "./types.ts";

export function chooseCourt(
  mode: BookingMode,
  partySize: number,
  allocations: readonly CourtAllocation[],
): CourtAllocation | null {
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) {
    throw new BookingError("INVALID_PARTY_SIZE");
  }

  if (mode === "private") {
    return allocations.find((item) => item.mode === "empty") ?? null;
  }

  const partial = allocations
    .filter((item) => item.mode === "open" && item.occupiedPlayers + partySize <= 4)
    .sort((a, b) => b.occupiedPlayers - a.occupiedPlayers || a.courtId.localeCompare(b.courtId));

  return partial[0] ?? allocations.find((item) => item.mode === "empty") ?? null;
}

function acceptsWindow(
  mode: BookingMode,
  partySize: number,
  cellKeys: readonly string[],
  inventory: CourtDayInventory,
): boolean {
  return cellKeys.every((key) => {
    if (inventory.blockedCells?.[key]) return false;
    const cell = inventory.cells[key];
    if (!cell) return true;
    if (mode === "private") return false;
    return cell.mode === "open" && cell.occupiedPlayers + partySize <= 4;
  });
}

export function chooseCourtDayInventory(
  mode: BookingMode,
  partySize: number,
  cellKeys: readonly string[],
  inventories: readonly CourtDayInventory[],
): CourtDayInventory | null {
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 4) {
    throw new BookingError("INVALID_PARTY_SIZE");
  }
  if (cellKeys.length === 0) throw new BookingError("INVALID_INPUT");

  const eligible = inventories.filter((inventory) =>
    acceptsWindow(mode, partySize, cellKeys, inventory),
  );
  if (mode === "private") {
    return eligible.sort((left, right) => left.courtId.localeCompare(right.courtId))[0] ?? null;
  }

  return eligible
    .map((inventory) => ({
      inventory,
      occupied: Math.max(0, ...cellKeys.map((key) => inventory.cells[key]?.occupiedPlayers ?? 0)),
    }))
    .sort(
      (left, right) =>
        right.occupied - left.occupied || left.inventory.courtId.localeCompare(right.inventory.courtId),
    )[0]?.inventory ?? null;
}

export function reserveCourtDayInventory(
  inventory: CourtDayInventory,
  mode: BookingMode,
  partySize: number,
  bookingId: string,
  cellKeys: readonly string[],
): CourtDayInventory {
  if (!chooseCourtDayInventory(mode, partySize, cellKeys, [inventory])) {
    throw new BookingError("SESSION_FULL");
  }
  const cells: Record<string, CourtDayCell> = structuredClone(inventory.cells);
  for (const key of cellKeys) {
    const current = cells[key];
    if (current?.bookingIds.includes(bookingId)) continue;
    cells[key] = {
      mode,
      occupiedPlayers: (current?.occupiedPlayers ?? 0) + partySize,
      bookingIds: [...(current?.bookingIds ?? []), bookingId],
    };
  }
  return { ...inventory, cells, version: inventory.version + 1 };
}

export function releaseCourtDayInventory(
  inventory: CourtDayInventory,
  partySize: number,
  bookingId: string,
  cellKeys: readonly string[],
): CourtDayInventory {
  const cells: Record<string, CourtDayCell> = structuredClone(inventory.cells);
  let changed = false;
  for (const key of cellKeys) {
    const current = cells[key];
    if (!current?.bookingIds.includes(bookingId)) continue;
    changed = true;
    const bookingIds = current.bookingIds.filter((id) => id !== bookingId);
    if (bookingIds.length === 0) {
      delete cells[key];
    } else {
      cells[key] = {
        ...current,
        occupiedPlayers: Math.max(0, current.occupiedPlayers - partySize),
        bookingIds,
      };
    }
  }
  return changed ? { ...inventory, cells, version: inventory.version + 1 } : inventory;
}
