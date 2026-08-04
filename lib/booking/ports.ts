import type {
  AdminBookingFilter,
  AuditLog,
  AvailabilitySlot,
  BookingRecord,
  CourtAllocation,
  CourtRecord,
  NotificationEvent,
  SessionRecord,
  SessionTemplateRecord,
} from "./types.ts";

export interface BookingTransaction {
  getBooking(id: string): Promise<BookingRecord | null>;
  getBookingIdByCodeHash(codeHash: string): Promise<string | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  getSessionTemplate(id: string): Promise<SessionTemplateRecord | null>;
  getCourts(courtIds: readonly string[]): Promise<CourtRecord[]>;
  getIdempotency(keyHash: string): Promise<string | null>;
  getAllocations(sessionId: string, courtIds: readonly string[]): Promise<CourtAllocation[]>;
  putSession(value: SessionRecord): Promise<void>;
  putAllocation(value: CourtAllocation): Promise<void>;
  putBooking(value: BookingRecord): Promise<void>;
  putBookingCode(codeHash: string, bookingId: string): Promise<void>;
  putIdempotency(keyHash: string, bookingId: string): Promise<void>;
  appendAudit(value: AuditLog): Promise<void>;
  enqueueNotification(value: NotificationEvent): Promise<void>;
}

export interface BookingRepository {
  runTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T>;
  listAvailability(date: string): Promise<AvailabilitySlot[]>;
  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]>;
  listExpiredPersonalData(cutoff: string, limit: number): Promise<BookingRecord[]>;
  redactBooking(bookingId: string, actorId: string): Promise<void>;
  setCourtEnabled(courtId: string, enabled: boolean, actorId: string): Promise<void>;
  setSessionTemplateEnabled(templateId: string, enabled: boolean, actorId: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdProvider {
  bookingId(): string;
  bookingCode(): string;
  eventId(): string;
}
