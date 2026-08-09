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
  getBookingById(bookingId: string): Promise<BookingRecord | null>;
  listAvailability(date: string): Promise<AvailabilitySlot[]>;
  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]>;
  listPendingBookings(date: string): Promise<BookingRecord[]>;
  listMatrixBookings(date: string): Promise<BookingRecord[]>;
  listCourts(): Promise<CourtRecord[]>;
  listSessionTemplates(): Promise<SessionTemplateRecord[]>;
  listAuditLogs(bookingId: string): Promise<AuditLog[]>;
  listExpiredPersonalData(cutoff: string, limit: number): Promise<BookingRecord[]>;
  redactBooking(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
    actorType?: "staff" | "system",
  ): Promise<void>;
  setCourtEnabled(
    courtId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void>;
  setSessionTemplateEnabled(
    templateId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdProvider {
  bookingId(): string;
  bookingCode(): string;
  eventId(): string;
}

export interface PhoneHasher {
  hash(normalizedPhone: string): string;
}
