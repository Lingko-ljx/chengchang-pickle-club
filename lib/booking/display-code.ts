import type { BookingRecord } from "./types.ts";

/**
 * Short, human-facing booking reference.
 *
 * This value is deliberately derived at response time instead of persisted or
 * indexed: phone suffixes are not unique and must never authorize a lookup or
 * mutation. `BookingRecord.code` remains the private, unique ownership token.
 */
export function bookingDisplayCode(
  booking: Pick<BookingRecord, "phone" | "bookingKind">,
): string | undefined {
  if (booking.bookingKind === "staff_reservation") return undefined;
  const digits = booking.phone?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}
