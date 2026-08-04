import { BookingError } from "./errors.ts";
import type { BookingStatus } from "./types.ts";

const transitions: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ["confirmed", "reschedule_proposed", "cancelled"],
  confirmed: ["reschedule_proposed", "cancelled", "completed"],
  reschedule_proposed: ["confirmed", "pending", "cancelled"],
  cancelled: [],
  completed: [],
};

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!transitions[from].includes(to)) {
    throw new BookingError("INVALID_TRANSITION");
  }
}
