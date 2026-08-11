import { BookingError } from "./errors.ts";
import { validateBookingWindow } from "./booking-window.ts";
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

  const legacyRoute = isNonEmptyString(command.sessionId);
  const hasSessionField = command.sessionId !== undefined;
  const windowParts = [command.date, command.startTime, command.endTime];
  const windowRoute = windowParts.every(isNonEmptyString);
  const hasAnyWindowPart = windowParts.some((value) => value !== undefined);

  if (
    !isNonEmptyString(command.idempotencyKey) ||
    (hasSessionField && !legacyRoute) ||
    legacyRoute === windowRoute ||
    (hasAnyWindowPart && !windowRoute) ||
    !isBookingMode(command.mode) ||
    !isNonEmptyString(command.name) ||
    !isNonEmptyString(command.phone) ||
    command.privacyConsent !== true ||
    (command.email !== undefined && typeof command.email !== "string") ||
    (command.note !== undefined && typeof command.note !== "string")
  ) {
    throw new BookingError("INVALID_INPUT");
  }

  if (windowRoute) {
    validateBookingWindow(
      command.date as string,
      command.startTime as string,
      command.endTime as string,
    );
  }

  return {
    idempotencyKey: command.idempotencyKey,
    ...(legacyRoute ? { sessionId: command.sessionId as string } : {}),
    ...(windowRoute
      ? {
          date: command.date as string,
          startTime: command.startTime as string,
          endTime: command.endTime as string,
        }
      : {}),
    mode: command.mode,
    partySize,
    name: command.name,
    phone: command.phone,
    ...(command.email === undefined ? {} : { email: command.email as string }),
    ...(command.note === undefined ? {} : { note: command.note as string }),
    privacyConsent: command.privacyConsent,
  };
}
