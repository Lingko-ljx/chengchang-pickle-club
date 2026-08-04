import { bookingCodeId } from "../booking-service.ts";
import { BookingError } from "../errors.ts";
import type { BookingRepository, BookingTransaction } from "../ports.ts";
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
} from "../types.ts";

interface MemoryState {
  bookings: Map<string, BookingRecord>;
  bookingCodes: Map<string, string>;
  sessions: Map<string, SessionRecord>;
  sessionTemplates: Map<string, SessionTemplateRecord>;
  courts: Map<string, CourtRecord>;
  idempotency: Map<string, string>;
  allocations: Map<string, CourtAllocation>;
  auditLogs: Map<string, AuditLog>;
  notifications: Map<string, NotificationEvent>;
}

export interface MemoryBookingSeed {
  bookings?: BookingRecord[];
  bookingCodes?: Array<{ codeHash: string; bookingId: string }>;
  sessions?: SessionRecord[];
  sessionTemplates?: SessionTemplateRecord[];
  courts?: CourtRecord[];
  idempotency?: Array<{ keyHash: string; bookingId: string }>;
  allocations?: CourtAllocation[];
  auditLogs?: AuditLog[];
  notifications?: NotificationEvent[];
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneMap<T>(values: Map<string, T>): Map<string, T> {
  return new Map(Array.from(values, ([key, value]) => [key, cloneValue(value)]));
}

function cloneState(state: MemoryState): MemoryState {
  return {
    bookings: cloneMap(state.bookings),
    bookingCodes: new Map(state.bookingCodes),
    sessions: cloneMap(state.sessions),
    sessionTemplates: cloneMap(state.sessionTemplates),
    courts: cloneMap(state.courts),
    idempotency: new Map(state.idempotency),
    allocations: cloneMap(state.allocations),
    auditLogs: cloneMap(state.auditLogs),
    notifications: cloneMap(state.notifications),
  };
}

function valuesByIds<T>(map: Map<string, T>, ids: readonly string[]): T[] {
  return ids.flatMap((id) => {
    const value = map.get(id);
    return value === undefined ? [] : [cloneValue(value)];
  });
}

function shanghaiTime(instant: string): string {
  return new Date(new Date(instant).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

class MemoryBookingTransaction implements BookingTransaction {
  private readonly state: MemoryState;

  constructor(state: MemoryState) {
    this.state = state;
  }

  async getBooking(id: string): Promise<BookingRecord | null> {
    const value = this.state.bookings.get(id);
    return value ? cloneValue(value) : null;
  }

  async getBookingIdByCodeHash(codeHash: string): Promise<string | null> {
    return this.state.bookingCodes.get(codeHash) ?? null;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const value = this.state.sessions.get(id);
    return value ? cloneValue(value) : null;
  }

  async getSessionTemplate(id: string): Promise<SessionTemplateRecord | null> {
    const value = this.state.sessionTemplates.get(id);
    return value ? cloneValue(value) : null;
  }

  async getCourts(courtIds: readonly string[]): Promise<CourtRecord[]> {
    return valuesByIds(this.state.courts, courtIds);
  }

  async getIdempotency(keyHash: string): Promise<string | null> {
    return this.state.idempotency.get(keyHash) ?? null;
  }

  async getAllocations(sessionId: string, courtIds: readonly string[]): Promise<CourtAllocation[]> {
    const wanted = new Set(courtIds);
    return Array.from(this.state.allocations.values())
      .filter((item) => item.sessionId === sessionId && wanted.has(item.courtId))
      .sort((a, b) => courtIds.indexOf(a.courtId) - courtIds.indexOf(b.courtId))
      .map(cloneValue);
  }

  async putSession(value: SessionRecord): Promise<void> {
    this.state.sessions.set(value.id, cloneValue(value));
  }

  async putAllocation(value: CourtAllocation): Promise<void> {
    this.state.allocations.set(value.id, cloneValue(value));
  }

  async putBooking(value: BookingRecord): Promise<void> {
    this.state.bookings.set(value.id, cloneValue(value));
  }

  async putBookingCode(codeHash: string, bookingId: string): Promise<void> {
    this.state.bookingCodes.set(codeHash, bookingId);
  }

  async putIdempotency(keyHash: string, bookingId: string): Promise<void> {
    this.state.idempotency.set(keyHash, bookingId);
  }

  async appendAudit(value: AuditLog): Promise<void> {
    this.state.auditLogs.set(value.id, cloneValue(value));
  }

  async enqueueNotification(value: NotificationEvent): Promise<void> {
    this.state.notifications.set(value.id, cloneValue(value));
  }
}

export class MemoryBookingRepository implements BookingRepository {
  private state: MemoryState;
  private queue: Promise<void> = Promise.resolve();

  constructor(seed: MemoryBookingSeed = {}) {
    const bookingCodes =
      seed.bookingCodes ??
      (seed.bookings ?? []).map((booking) => ({
        codeHash: bookingCodeId(booking.code),
        bookingId: booking.id,
      }));
    this.state = {
      bookings: new Map((seed.bookings ?? []).map((value) => [value.id, cloneValue(value)])),
      bookingCodes: new Map(bookingCodes.map((value) => [value.codeHash, value.bookingId])),
      sessions: new Map((seed.sessions ?? []).map((value) => [value.id, cloneValue(value)])),
      sessionTemplates: new Map(
        (seed.sessionTemplates ?? []).map((value) => [value.id, cloneValue(value)]),
      ),
      courts: new Map((seed.courts ?? []).map((value) => [value.id, cloneValue(value)])),
      idempotency: new Map((seed.idempotency ?? []).map((value) => [value.keyHash, value.bookingId])),
      allocations: new Map((seed.allocations ?? []).map((value) => [value.id, cloneValue(value)])),
      auditLogs: new Map((seed.auditLogs ?? []).map((value) => [value.id, cloneValue(value)])),
      notifications: new Map(
        (seed.notifications ?? []).map((value) => [value.id, cloneValue(value)]),
      ),
    };
  }

  runTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const result = await work(new MemoryBookingTransaction(next));
      this.state = next;
      return cloneValue(result);
    });
  }

  async listAvailability(date: string): Promise<AvailabilitySlot[]> {
    await this.queue;
    return Array.from(this.state.sessions.values())
      .filter((session) => session.date === date && session.status === "open")
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map((session) => {
        const currentEnabled = new Set(
          Array.from(this.state.courts.values())
            .filter((court) => court.enabled && session.enabledCourtIds.includes(court.id))
            .map((court) => court.id),
        );
        const allocations = Array.from(currentEnabled, (courtId) =>
          Array.from(this.state.allocations.values()).find(
            (item) => item.sessionId === session.id && item.courtId === courtId,
          ),
        );
        const privateCourtCount = allocations.filter((item) => !item || item.mode === "empty").length;
        const openCapacity = allocations.reduce((total, item) => {
          if (!item || item.mode === "empty") return total + 4;
          return item.mode === "open" ? total + (4 - item.occupiedPlayers) : total;
        }, 0);
        const acceptsOpenPartySizes = ([1, 2, 3, 4] as const).filter((partySize) =>
          allocations.some(
            (item) =>
              !item ||
              item.mode === "empty" ||
              (item.mode === "open" && item.occupiedPlayers + partySize <= 4),
          ),
        );
        return {
          sessionId: session.id,
          date: session.date,
          startTime: shanghaiTime(session.startAt),
          endTime: shanghaiTime(session.endAt),
          openCapacity,
          acceptsOpenPartySizes,
          privateCourtCount,
          acceptsOpen: acceptsOpenPartySizes.length > 0,
          acceptsPrivate: privateCourtCount > 0,
        };
      });
  }

  async listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]> {
    await this.queue;
    const normalizedQuery = filter.query?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    return Array.from(this.state.bookings.values())
      .filter((booking) => !filter.date || booking.date === filter.date)
      .filter((booking) => !filter.status || booking.status === filter.status)
      .filter((booking) => !filter.mode || booking.mode === filter.mode)
      .filter(
        (booking) =>
          !normalizedQuery ||
          [booking.id, booking.code, booking.name, booking.phone, booking.email]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(normalizedQuery)),
      )
      .filter((booking) => !filter.cursor || booking.id > filter.cursor)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(cloneValue);
  }

  async listExpiredPersonalData(cutoff: string, limit: number): Promise<BookingRecord[]> {
    await this.queue;
    return Array.from(this.state.bookings.values())
      .filter(
        (booking) =>
          (booking.status === "cancelled" || booking.status === "completed") &&
          Boolean(booking.terminalAt && booking.terminalAt < cutoff) &&
          !booking.personalDataRedactedAt,
      )
      .sort((a, b) => (a.terminalAt ?? "").localeCompare(b.terminalAt ?? ""))
      .slice(0, Math.max(0, limit))
      .map(cloneValue);
  }

  redactBooking(bookingId: string, actorId: string): Promise<void> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const booking = next.bookings.get(bookingId);
      if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
      const now = new Date().toISOString();
      next.bookingCodes.delete(bookingCodeId(booking.code));
      if (booking.idempotencyKeyHash) next.idempotency.delete(booking.idempotencyKeyHash);
      const retained = { ...booking };
      delete retained.name;
      delete retained.phone;
      delete retained.phoneHash;
      delete retained.email;
      delete retained.note;
      delete retained.idempotencyKeyHash;
      next.bookings.set(bookingId, {
        ...retained,
        personalDataRedactedAt: now,
        updatedAt: now,
        version: booking.version + 1,
      });
      next.auditLogs.set(`redact-${bookingId}-${booking.version + 1}`, {
        id: `redact-${bookingId}-${booking.version + 1}`,
        bookingId,
        action: "personal_data_redacted",
        actorType: "system",
        actorId,
        at: now,
        metadata: {},
      });
      this.state = next;
    });
  }

  setCourtEnabled(courtId: string, enabled: boolean, actorId: string): Promise<void> {
    return this.serialized(async () => {
      void actorId;
      const next = cloneState(this.state);
      const court = next.courts.get(courtId);
      if (!court) throw new BookingError("SESSION_NOT_FOUND");
      next.courts.set(courtId, { ...court, enabled, version: court.version + 1 });
      this.state = next;
    });
  }

  setSessionTemplateEnabled(templateId: string, enabled: boolean, actorId: string): Promise<void> {
    return this.serialized(async () => {
      void actorId;
      const next = cloneState(this.state);
      const template = next.sessionTemplates.get(templateId);
      if (!template) throw new BookingError("SESSION_NOT_FOUND");
      next.sessionTemplates.set(templateId, {
        ...template,
        enabled,
        version: template.version + 1,
      });
      this.state = next;
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
