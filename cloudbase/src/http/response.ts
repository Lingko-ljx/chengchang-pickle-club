import { BookingError, type BookingErrorCode } from "../../../lib/booking/errors.ts";
import { MediaError, type MediaErrorCode } from "../../../lib/media/errors.ts";

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
}

const errors: Record<BookingErrorCode, { status: number; error: PublicError }> = {
  INVALID_INPUT: {
    status: 400,
    error: { code: "INVALID_INPUT", message: "Invalid request", retryable: false },
  },
  INVALID_PARTY_SIZE: {
    status: 400,
    error: {
      code: "INVALID_PARTY_SIZE",
      message: "Party size must be between 1 and 4",
      retryable: false,
    },
  },
  INVALID_TRANSITION: {
    status: 409,
    error: { code: "INVALID_TRANSITION", message: "Booking state changed", retryable: true },
  },
  SESSION_NOT_FOUND: {
    status: 404,
    error: { code: "SESSION_NOT_FOUND", message: "Session not found", retryable: false },
  },
  SESSION_FULL: {
    status: 409,
    error: { code: "SESSION_FULL", message: "This session is full", retryable: true },
  },
  SESSION_CLOSED: {
    status: 409,
    error: { code: "SESSION_CLOSED", message: "This session is closed", retryable: false },
  },
  BOOKING_NOT_FOUND: {
    status: 404,
    error: { code: "BOOKING_NOT_FOUND", message: "Booking not found", retryable: false },
  },
  AUTH_REQUIRED: {
    status: 401,
    error: { code: "AUTH_REQUIRED", message: "Authentication required", retryable: false },
  },
  FORBIDDEN: {
    status: 403,
    error: { code: "FORBIDDEN", message: "Forbidden", retryable: false },
  },
  RATE_LIMITED: {
    status: 429,
    error: { code: "RATE_LIMITED", message: "Too many requests", retryable: true },
  },
  EXPORT_TOO_LARGE: {
    status: 409,
    error: {
      code: "EXPORT_TOO_LARGE",
      message: "Export too large; narrow the date range",
      retryable: false,
    },
  },
  CONFLICT: {
    status: 409,
    error: { code: "CONFLICT", message: "Booking state changed", retryable: true },
  },
};

const mediaErrors: Record<MediaErrorCode, { status: number; error: PublicError }> = {
  INVALID_MEDIA_INPUT: {
    status: 400,
    error: { code: "INVALID_MEDIA_INPUT", message: "Invalid media request", retryable: false },
  },
  MEDIA_NOT_FOUND: {
    status: 404,
    error: { code: "MEDIA_NOT_FOUND", message: "Media item not found", retryable: false },
  },
  MEDIA_CONFLICT: {
    status: 409,
    error: { code: "MEDIA_CONFLICT", message: "Media state changed", retryable: true },
  },
  MEDIA_UPLOAD_INCOMPLETE: {
    status: 409,
    error: { code: "MEDIA_UPLOAD_INCOMPLETE", message: "Upload is not complete", retryable: true },
  },
  MEDIA_UPLOAD_MISMATCH: {
    status: 409,
    error: { code: "MEDIA_UPLOAD_MISMATCH", message: "Uploaded file does not match", retryable: false },
  },
  MEDIA_LIMIT_REACHED: {
    status: 409,
    error: { code: "MEDIA_LIMIT_REACHED", message: "Media limit reached", retryable: false },
  },
};

export function jsonResponse(
  statusCode: number,
  data: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify({ data }),
  };
}

export function errorResponse(
  error: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  const mapped = error instanceof BookingError
    ? errors[error.code]
    : error instanceof MediaError
      ? mediaErrors[error.code]
      : undefined;
  const status = mapped?.status ?? 500;
  const body = mapped?.error ?? {
    code: "INTERNAL_ERROR",
    message: "Service temporarily unavailable",
    retryable: true,
  };
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify({ error: body }),
  };
}
