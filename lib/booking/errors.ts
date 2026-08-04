export type BookingErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PARTY_SIZE"
  | "INVALID_TRANSITION"
  | "SESSION_NOT_FOUND"
  | "SESSION_FULL"
  | "SESSION_CLOSED"
  | "BOOKING_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "CONFLICT";

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode) {
    super(code);
    this.name = "BookingError";
    this.code = code;
  }
}
