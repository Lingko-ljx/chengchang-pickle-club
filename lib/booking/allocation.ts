import { BookingError } from "./errors.ts";
import type { BookingMode, CourtAllocation } from "./types.ts";

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
