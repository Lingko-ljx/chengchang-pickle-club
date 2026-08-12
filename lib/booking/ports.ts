import type {
  AdminBookingFilter,
  AuditLog,
  AvailabilitySlot,
  BookingRecord,
  BookingPage,
  CourtAllocation,
  CourtDayInventory,
  CourtRecord,
  NotificationEvent,
  SessionRecord,
  SessionTemplateRecord,
} from "./types.ts";

export interface BookingTransaction {
  isBookingInventoryV2Ready(): Promise<boolean>;
  getBooking(id: string): Promise<BookingRecord | null>;
  getBookingIdByCodeHash(codeHash: string): Promise<string | null>;
  getSession(id: string): Promise<SessionRecord | null>;
  getSessionTemplate(id: string): Promise<SessionTemplateRecord | null>;
  getCourts(courtIds: readonly string[]): Promise<CourtRecord[]>;
  getIdempotency(keyHash: string): Promise<string | null>;
  getAllocations(sessionId: string, courtIds: readonly string[]): Promise<CourtAllocation[]>;
  getCourtDayInventories(
    date: string,
    courtIds: readonly string[],
  ): Promise<CourtDayInventory[]>;
  putSession(value: SessionRecord): Promise<void>;
  putAllocation(value: CourtAllocation): Promise<void>;
  putCourtDayInventory(value: CourtDayInventory): Promise<void>;
  putBooking(value: BookingRecord): Promise<void>;
  putBookingCode(codeHash: string, bookingId: string): Promise<void>;
  putIdempotency(keyHash: string, bookingId: string): Promise<void>;
  appendAudit(value: AuditLog): Promise<void>;
  enqueueNotification(value: NotificationEvent): Promise<void>;
}

export interface BookingRepository {
  runTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T>;
  isBookingInventoryV2Ready(): Promise<boolean>;
  getBookingById(bookingId: string): Promise<BookingRecord | null>;
  listCustomerHistory(bookingId: string, limit: number): Promise<BookingRecord[]>;
  listAvailability(date: string): Promise<AvailabilitySlot[]>;
  listSessions(date: string): Promise<SessionRecord[]>;
  listCourtDayInventories(date: string): Promise<CourtDayInventory[]>;
  listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]>;
  listBookingPage(filter: AdminBookingFilter): Promise<BookingPage>;
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
  setBookingArchived(
    bookingId: string,
    archived: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<BookingRecord>;
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
