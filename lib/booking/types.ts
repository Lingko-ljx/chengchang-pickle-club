export type BookingMode = "private" | "open";
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "reschedule_proposed"
  | "cancelled"
  | "completed";

export const currentPublicScheduleConsentVersion = 1;

export type AllocationMode = "empty" | BookingMode;

export interface CourtAllocation {
  id: string;
  sessionId: string;
  courtId: string;
  mode: AllocationMode;
  occupiedPlayers: number;
  bookingIds: string[];
  version: number;
}

export interface BookingPolicy {
  timezone: "Asia/Shanghai";
  openingTime: string;
  closingTime: string;
  startIntervalMinutes: number;
  minimumDurationMinutes: number;
  durationStepMinutes: number;
  maximumDurationMinutes: number;
  version: number;
}

export interface CourtDayCell {
  mode: BookingMode;
  occupiedPlayers: number;
  bookingIds: string[];
}

export interface CourtTimeBlock {
  id: string;
  date: string;
  courtId: string;
  startTime: string;
  endTime: string;
  cellKeys: string[];
  reason?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
}

export interface CourtTimeBlockDay {
  items: CourtTimeBlock[];
  /** Current per-court inventory versions used for optimistic closure writes. */
  inventoryVersions: Record<string, number>;
}

export interface CreateCourtTimeBlocksCommand {
  date: string;
  courtIds: string[];
  startTime: string;
  endTime: string;
  reason?: string;
  expectedVersions: Record<string, number>;
  actorId: string;
}

export interface UpdateCourtTimeBlockCommand {
  blockId: string;
  date: string;
  courtId: string;
  startTime: string;
  endTime: string;
  reason?: string;
  expectedVersion: number;
  actorId: string;
}

export interface RestoreCourtTimeBlockCommand {
  blockId: string;
  date: string;
  courtId: string;
  expectedVersion: number;
  actorId: string;
}

export interface CourtBlockedCell {
  blockId: string;
  reason?: string;
}

export interface CourtDayInventory {
  id: string;
  date: string;
  courtId: string;
  cells: Record<string, CourtDayCell>;
  /** Staff closures live beside booking cells so conflict checks and writes share one transaction. */
  blockedCells?: Record<string, CourtBlockedCell>;
  timeBlocks?: Record<string, CourtTimeBlock>;
  version: number;
}

export interface CreateBookingCommand {
  idempotencyKey: string;
  /** Legacy one-hour template path. Mutually exclusive with the v2 window fields. */
  sessionId?: string;
  /** Beijing calendar date for a v2 booking window. */
  date?: string;
  startTime?: string;
  endTime?: string;
  mode: BookingMode;
  partySize: number;
  name: string;
  phone: string;
  email?: string;
  note?: string;
  privacyConsent: true;
  /** Versioned opt-in to showing a masked name in the public daily schedule. */
  publicScheduleConsentVersion?: typeof currentPublicScheduleConsentVersion;
}

export interface BookingRecord {
  id: string;
  code: string;
  /** Missing on legacy records and therefore treated as a customer booking. */
  bookingKind?: "customer" | "staff_reservation";
  /** Public-safe operational title. Staff reservations never store contact details. */
  staffReservationTitle?: string;
  idempotencyKeyHash?: string;
  sessionId: string;
  date: string;
  startAt: string;
  endAt: string;
  courtId: string;
  proposedDate?: string;
  proposedSessionId?: string;
  proposedCourtId?: string;
  proposedStartAt?: string;
  proposedEndAt?: string;
  mode: BookingMode;
  partySize: number;
  status: BookingStatus;
  proposalPreviousStatus?: "pending" | "confirmed";
  name?: string;
  phone?: string;
  phoneHash?: string;
  email?: string;
  note?: string;
  /** Customer consent timestamp. Staff-created inventory reservations do not collect consent. */
  privacyConsentAt?: string;
  /** Explicit, versioned consent to the public masked schedule disclosure. */
  publicScheduleConsentVersion?: number;
  publicScheduleConsentAt?: string;
  canCancelUntil: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  personalDataRedactedAt?: string;
  /** Staff-only soft deletion. Archived bookings retain inventory, lookup and audit history. */
  archivedAt?: string;
  archivedBy?: string;
  version: number;
}

export interface CourtRecord {
  id: string;
  enabled: boolean;
  version: number;
}

export interface SessionTemplateRecord {
  id: string;
  startTime: string;
  endTime: string;
  enabled: boolean;
  version: number;
}

export interface SessionRecord {
  id: string;
  date: string;
  templateId: string;
  startAt: string;
  endAt: string;
  status: "open" | "closed";
  enabledCourtIds: string[];
  version: number;
}

export interface AuditLog {
  id: string;
  bookingId: string;
  action: string;
  actorType: "customer" | "staff" | "system";
  actorId?: string;
  fromStatus?: BookingStatus;
  toStatus?: BookingStatus;
  at: string;
  metadata: Record<string, string | number | boolean | null>;
}

export type NotificationKind =
  | "created"
  | "confirmed"
  | "reschedule_proposed"
  | "reschedule_accepted"
  | "reschedule_rejected"
  | "cancelled";

export interface NotificationEvent {
  id: string;
  bookingId: string;
  bookingVersion: number;
  kind: NotificationKind;
  recipientType: "staff" | "customer";
  status: "pending" | "sending" | "retry" | "sent" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseUntil?: string;
  providerRequestId?: string;
  providerMessageId?: string;
  lastErrorCode?: string;
  sentAt?: string;
  failedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailabilitySlot {
  sessionId: string;
  date: string;
  startTime: string;
  endTime: string;
  openCapacity: number;
  acceptsOpenPartySizes: Array<1 | 2 | 3 | 4>;
  privateCourtCount: number;
  acceptsOpen: boolean;
  acceptsPrivate: boolean;
}

export interface BookingWindowAvailability extends AvailabilitySlot {
  durationMinutes: number;
}

export interface BookingWindowAvailabilityResult {
  policy: BookingPolicy;
  windows: BookingWindowAvailability[];
}

export interface AdminBookingFilter {
  date?: string;
  fromDate?: string;
  toDate?: string;
  status?: BookingStatus;
  mode?: BookingMode;
  query?: string;
  cursor?: string;
  limit?: number;
  archive?: "active" | "archived" | "all";
}

export interface AdminDashboard {
  date: string;
  pending: BookingRecord[];
  slots: AvailabilitySlot[];
  courts: CourtRecord[];
}

export interface BookingPage {
  items: BookingRecord[];
  nextCursor?: string;
}

export interface BookingCursor {
  date: string;
  createdAt: string;
  id: string;
}
