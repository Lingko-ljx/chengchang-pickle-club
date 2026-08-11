import { requireCalendarDate } from "./calendar-date.ts";
import { BookingError } from "./errors.ts";
import type { BookingPolicy } from "./types.ts";

export const defaultBookingPolicy: BookingPolicy = Object.freeze({
  timezone: "Asia/Shanghai",
  openingTime: "09:00",
  closingTime: "22:00",
  startIntervalMinutes: 30,
  minimumDurationMinutes: 60,
  durationStepMinutes: 60,
  maximumDurationMinutes: 240,
  version: 1,
});

export interface ValidatedBookingWindow {
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  cellKeys: string[];
}

export function clockMinutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new BookingError("INVALID_INPUT");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesClock(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) {
    throw new BookingError("INVALID_INPUT");
  }
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function timeCellKey(time: string): string {
  clockMinutes(time);
  return time.replace(":", "");
}

export function inventoryCellKeys(startTime: string, endTime: string): string[] {
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  if (end <= start || (end - start) % 30 !== 0) throw new BookingError("INVALID_INPUT");
  const keys: string[] = [];
  for (let minute = start; minute < end; minute += 30) {
    keys.push(timeCellKey(minutesClock(minute)));
  }
  return keys;
}

export function validateBookingWindow(
  date: string,
  startTime: string,
  endTime: string,
  policy: BookingPolicy = defaultBookingPolicy,
): ValidatedBookingWindow {
  const calendarDate = requireCalendarDate(date);
  const opening = clockMinutes(policy.openingTime);
  const closing = clockMinutes(policy.closingTime);
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  const durationMinutes = end - start;

  if (
    start < opening ||
    end > closing ||
    end <= start ||
    (start - opening) % policy.startIntervalMinutes !== 0 ||
    durationMinutes < policy.minimumDurationMinutes ||
    durationMinutes > policy.maximumDurationMinutes ||
    (durationMinutes - policy.minimumDurationMinutes) % policy.durationStepMinutes !== 0
  ) {
    throw new BookingError("INVALID_INPUT");
  }

  return {
    date: calendarDate,
    startTime: minutesClock(start),
    endTime: minutesClock(end),
    durationMinutes,
    cellKeys: inventoryCellKeys(minutesClock(start), minutesClock(end)),
  };
}

export function listBookingWindows(
  date: string,
  policy: BookingPolicy = defaultBookingPolicy,
): ValidatedBookingWindow[] {
  const calendarDate = requireCalendarDate(date);
  const opening = clockMinutes(policy.openingTime);
  const closing = clockMinutes(policy.closingTime);
  const windows: ValidatedBookingWindow[] = [];
  for (let start = opening; start < closing; start += policy.startIntervalMinutes) {
    for (
      let duration = policy.minimumDurationMinutes;
      duration <= policy.maximumDurationMinutes && start + duration <= closing;
      duration += policy.durationStepMinutes
    ) {
      windows.push(
        validateBookingWindow(
          calendarDate,
          minutesClock(start),
          minutesClock(start + duration),
          policy,
        ),
      );
    }
  }
  return windows;
}

export function bookingWindowSessionId(date: string, startTime: string, endTime: string): string {
  const window = validateBookingWindow(date, startTime, endTime);
  return `${window.date}__window-v2-${timeCellKey(window.startTime)}-${timeCellKey(window.endTime)}`;
}

export function parseBookingWindowSessionId(sessionId: string): ValidatedBookingWindow | null {
  const match = /^(\d{4}-\d{2}-\d{2})__window-v2-(\d{4})-(\d{4})$/.exec(sessionId);
  if (!match) return null;
  const toTime = (key: string) => `${key.slice(0, 2)}:${key.slice(2)}`;
  try {
    return validateBookingWindow(match[1], toTime(match[2]), toTime(match[3]));
  } catch {
    throw new BookingError("INVALID_INPUT");
  }
}

export function courtDayInventoryId(date: string, courtId: string): string {
  return `${requireCalendarDate(date)}__court-${courtId}`;
}
