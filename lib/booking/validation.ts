import { BookingError } from "./errors.ts";
import type { BookingMode, CreateBookingCommand } from "./types.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBookingMode(value: unknown): value is BookingMode {
  return value === "private" || value === "open";
}

export function validateCreateBooking(input: unknown): CreateBookingCommand {
  if (typeof input !== "object" || input === null) {
    throw new BookingError("INVALID_INPUT");
  }

  const command = input as Record<string, unknown>;
  const partySize = command.partySize;
  if (
    typeof partySize !== "number" ||
    !Number.isInteger(partySize) ||
    partySize < 1 ||
    partySize > 4
  ) {
    throw new BookingError("INVALID_PARTY_SIZE");
  }

  if (
    !isNonEmptyString(command.idempotencyKey) ||
    !isNonEmptyString(command.sessionId) ||
    !isBookingMode(command.mode) ||
    !isNonEmptyString(command.name) ||
    !isNonEmptyString(command.phone) ||
    command.privacyConsent !== true ||
    (command.email !== undefined && typeof command.email !== "string") ||
    (command.note !== undefined && typeof command.note !== "string")
  ) {
    throw new BookingError("INVALID_INPUT");
  }

  return {
    idempotencyKey: command.idempotencyKey,
    sessionId: command.sessionId,
    mode: command.mode,
    partySize,
    name: command.name,
    phone: command.phone,
    ...(command.email === undefined ? {} : { email: command.email }),
    ...(command.note === undefined ? {} : { note: command.note }),
    privacyConsent: command.privacyConsent,
  };
}
