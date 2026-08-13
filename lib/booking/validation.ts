import { BookingError } from "./errors.ts";
import { validateBookingWindow } from "./booking-window.ts";
import {
  currentPublicScheduleConsentVersion,
  legacyPublicScheduleConsentVersion,
} from "./types.ts";
import type { BookingMode, CreateBookingCommand } from "./types.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const maximumBookingNameLength = 40;

/**
 * Return the one canonical spelling that may be stored and, for a v2 booking,
 * displayed on the public schedule. Historical malformed values fail closed.
 */
export function canonicalBookingName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return undefined;

  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\p{Zs}+/gu, " ");
  const length = Array.from(normalized).length;
  if (length < 1 || length > maximumBookingNameLength) return undefined;
  if (!/[\p{L}\p{M}]/u.test(normalized)) return undefined;

  // Public names are rendered as text, but rejecting markup-shaped input also
  // prevents unsafe reuse by exports, notifications, or future clients.
  if (/[<>]/u.test(normalized)) return undefined;
  if (/&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/iu.test(normalized)) {
    return undefined;
  }

  // A name is public by default in policy v2. Do not let a phone number or an
  // email address be placed in that field accidentally (or as a workaround).
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/u.test(normalized)) return undefined;
  for (const candidate of normalized.match(/[+\d][\d\s()+.\-]{6,}\d/gu) ?? []) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return undefined;
  }

  return normalized;
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
  const publicScheduleConsentVersion = command.publicScheduleConsentVersion;
  const supportedPublicScheduleConsent =
    publicScheduleConsentVersion === undefined ||
    publicScheduleConsentVersion === legacyPublicScheduleConsentVersion ||
    publicScheduleConsentVersion === currentPublicScheduleConsentVersion;
  const validHidePublicName =
    command.hidePublicName === undefined ||
    (command.hidePublicName === true &&
      publicScheduleConsentVersion === currentPublicScheduleConsentVersion);
  const name = canonicalBookingName(command.name);

  if (
    !isNonEmptyString(command.idempotencyKey) ||
    (hasSessionField && !legacyRoute) ||
    legacyRoute === windowRoute ||
    (hasAnyWindowPart && !windowRoute) ||
    !isBookingMode(command.mode) ||
    !name ||
    !isNonEmptyString(command.phone) ||
    command.privacyConsent !== true ||
    !supportedPublicScheduleConsent ||
    !validHidePublicName ||
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
    name,
    phone: command.phone,
    ...(command.email === undefined ? {} : { email: command.email as string }),
    ...(command.note === undefined ? {} : { note: command.note as string }),
    privacyConsent: command.privacyConsent,
    ...(publicScheduleConsentVersion !== undefined
      ? { publicScheduleConsentVersion }
      : {}),
    ...(command.hidePublicName === true ? { hidePublicName: true as const } : {}),
  };
}
