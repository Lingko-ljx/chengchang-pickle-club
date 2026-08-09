export type BookingMode = "private" | "open";
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "reschedule_proposed"
  | "cancelled"
  | "completed";

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

export interface CreateBookingCommand {
  idempotencyKey: string;
  sessionId: string;
  mode: BookingMode;
  partySize: number;
  name: string;
  phone: string;
  email?: string;
  note?: string;
  privacyConsent: true;
}

export interface BookingRecord {
  id: string;
  code: string;
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
  privacyConsentAt: string;
  canCancelUntil: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  personalDataRedactedAt?: string;
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

export interface NotificationEvent {
  id: string;
  bookingId: string;
  kind: string;
  recipientType: "customer" | "staff";
  status: "pending" | "sending" | "retry" | "sent" | "failed";
  attemptCount: number;
  nextAttemptAt: string;
  leaseUntil?: string;
  createdAt: string;
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

export interface AdminBookingFilter {
  date?: string;
  fromDate?: string;
  toDate?: string;
  status?: BookingStatus;
  mode?: BookingMode;
  query?: string;
  cursor?: string;
  limit?: number;
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
