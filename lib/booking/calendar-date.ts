import { BookingError } from "./errors.ts";

export function requireCalendarDate(value: unknown): string {
  if (typeof value !== "string") throw new BookingError("INVALID_INPUT");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BookingError("INVALID_INPUT");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new BookingError("INVALID_INPUT");
  }
  return value;
}
