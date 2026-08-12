import { bookingCodeId, decodeBookingCursor, encodeBookingCursor } from "../booking-service.ts";
import { BookingError } from "../errors.ts";
import type { BookingRepository, BookingTransaction } from "../ports.ts";
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
} from "../types.ts";

interface MemoryState {
  bookingInventoryV2Ready: boolean;
  bookings: Map<string, BookingRecord>;
  bookingCodes: Map<string, string>;
  sessions: Map<string, SessionRecord>;
  sessionTemplates: Map<string, SessionTemplateRecord>;
  courts: Map<string, CourtRecord>;
  idempotency: Map<string, string>;
  allocations: Map<string, CourtAllocation>;
  courtDayInventories: Map<string, CourtDayInventory>;
  auditLogs: Map<string, AuditLog>;
  notifications: Map<string, NotificationEvent>;
}

export interface MemoryBookingSeed {
  bookingInventoryV2Ready?: boolean;
  bookings?: BookingRecord[];
  bookingCodes?: Array<{ codeHash: string; bookingId: string }>;
  sessions?: SessionRecord[];
  sessionTemplates?: SessionTemplateRecord[];
  courts?: CourtRecord[];
  idempotency?: Array<{ keyHash: string; bookingId: string }>;
  allocations?: CourtAllocation[];
  courtDayInventories?: CourtDayInventory[];
  auditLogs?: AuditLog[];
  notifications?: NotificationEvent[];
  fault?: {
    operation: "appendAudit" | "enqueueNotification";
    times?: number;
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneMap<T>(values: Map<string, T>): Map<string, T> {
  return new Map(Array.from(values, ([key, value]) => [key, cloneValue(value)]));
}

function cloneState(state: MemoryState): MemoryState {
  return {
    bookingInventoryV2Ready: state.bookingInventoryV2Ready,
    bookings: cloneMap(state.bookings),
    bookingCodes: new Map(state.bookingCodes),
    sessions: cloneMap(state.sessions),
    sessionTemplates: cloneMap(state.sessionTemplates),
    courts: cloneMap(state.courts),
    idempotency: new Map(state.idempotency),
    allocations: cloneMap(state.allocations),
    courtDayInventories: cloneMap(state.courtDayInventories),
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
  private readonly injectFault: (operation: "appendAudit" | "enqueueNotification") => void;

  constructor(
    state: MemoryState,
    injectFault: (operation: "appendAudit" | "enqueueNotification") => void,
  ) {
    this.state = state;
    this.injectFault = injectFault;
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

  async isBookingInventoryV2Ready(): Promise<boolean> {
    return this.state.bookingInventoryV2Ready;
  }

  async getCourtDayInventories(
    date: string,
    courtIds: readonly string[],
  ): Promise<CourtDayInventory[]> {
    const wanted = new Set(courtIds);
    return Array.from(this.state.courtDayInventories.values())
      .filter((item) => item.date === date && wanted.has(item.courtId))
      .sort((a, b) => courtIds.indexOf(a.courtId) - courtIds.indexOf(b.courtId))
      .map(cloneValue);
  }

  async putSession(value: SessionRecord): Promise<void> {
    this.state.sessions.set(value.id, cloneValue(value));
  }

  async putAllocation(value: CourtAllocation): Promise<void> {
    this.state.allocations.set(value.id, cloneValue(value));
  }

  async putCourtDayInventory(value: CourtDayInventory): Promise<void> {
    this.state.courtDayInventories.set(value.id, cloneValue(value));
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
    this.injectFault("appendAudit");
    this.state.auditLogs.set(value.id, cloneValue(value));
  }

  async enqueueNotification(value: NotificationEvent): Promise<void> {
    this.injectFault("enqueueNotification");
    this.state.notifications.set(value.id, cloneValue(value));
  }
}

export class MemoryBookingRepository implements BookingRepository {
  private state: MemoryState;
  private queue: Promise<void> = Promise.resolve();
  private readonly faultOperation?: "appendAudit" | "enqueueNotification";
  private remainingFaults: number;

  constructor(seed: MemoryBookingSeed = {}) {
    const bookingCodes =
      seed.bookingCodes ??
      (seed.bookings ?? []).map((booking) => ({
        codeHash: bookingCodeId(booking.code),
        bookingId: booking.id,
      }));
    this.faultOperation = seed.fault?.operation;
    this.remainingFaults = seed.fault?.times ?? (seed.fault ? 1 : 0);
    this.state = {
      bookingInventoryV2Ready: seed.bookingInventoryV2Ready ?? false,
      bookings: new Map((seed.bookings ?? []).map((value) => [value.id, cloneValue(value)])),
      bookingCodes: new Map(bookingCodes.map((value) => [value.codeHash, value.bookingId])),
      sessions: new Map((seed.sessions ?? []).map((value) => [value.id, cloneValue(value)])),
      sessionTemplates: new Map(
        (seed.sessionTemplates ?? []).map((value) => [value.id, cloneValue(value)]),
      ),
      courts: new Map((seed.courts ?? []).map((value) => [value.id, cloneValue(value)])),
      idempotency: new Map((seed.idempotency ?? []).map((value) => [value.keyHash, value.bookingId])),
      allocations: new Map((seed.allocations ?? []).map((value) => [value.id, cloneValue(value)])),
      courtDayInventories: new Map(
        (seed.courtDayInventories ?? []).map((value) => [value.id, cloneValue(value)]),
      ),
      auditLogs: new Map((seed.auditLogs ?? []).map((value) => [value.id, cloneValue(value)])),
      notifications: new Map(
        (seed.notifications ?? []).map((value) => [value.id, cloneValue(value)]),
      ),
    };
  }

  runTransaction<T>(work: (transaction: BookingTransaction) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const result = await work(
        new MemoryBookingTransaction(next, (operation) => this.injectFault(operation)),
      );
      this.state = next;
      return cloneValue(result);
    });
  }

  async isBookingInventoryV2Ready(): Promise<boolean> {
    await this.queue;
    return this.state.bookingInventoryV2Ready;
  }

  async getBookingById(bookingId: string): Promise<BookingRecord | null> {
    await this.queue;
    const booking = this.state.bookings.get(bookingId);
    return booking ? cloneValue(booking) : null;
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

  async listSessions(date: string): Promise<SessionRecord[]> {
    await this.queue;
    return Array.from(this.state.sessions.values())
      .filter((session) => session.date === date)
      .sort(
        (left, right) =>
          left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id),
      )
      .map(cloneValue);
  }

  async listCourtDayInventories(date: string): Promise<CourtDayInventory[]> {
    await this.queue;
    return Array.from(this.state.courtDayInventories.values())
      .filter((inventory) => inventory.date === date)
      .sort((left, right) => left.courtId.localeCompare(right.courtId))
      .map(cloneValue);
  }

  async listBookings(filter: AdminBookingFilter): Promise<BookingRecord[]> {
    await this.queue;
    const normalizedQuery = filter.query?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    return Array.from(this.state.bookings.values())
      .filter((booking) => !filter.date || booking.date === filter.date)
      .filter((booking) => !filter.fromDate || booking.date >= filter.fromDate)
      .filter((booking) => !filter.toDate || booking.date <= filter.toDate)
      .filter((booking) => !filter.status || booking.status === filter.status)
      .filter((booking) => !filter.mode || booking.mode === filter.mode)
      .filter((booking) => {
        const archive = filter.archive ?? "active";
        return archive === "all" || (archive === "archived" ? Boolean(booking.archivedAt) : !booking.archivedAt);
      })
      .filter(
        (booking) =>
          !normalizedQuery ||
          [booking.id, booking.code, booking.name, booking.phone, booking.email]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.toLowerCase().includes(normalizedQuery)),
      )
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) ||
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )
      .filter((booking) => {
        if (!filter.cursor) return true;
        const cursor = decodeBookingCursor(filter.cursor);
        return booking.date < cursor.date ||
          (booking.date === cursor.date && booking.createdAt < cursor.createdAt) ||
          (booking.date === cursor.date && booking.createdAt === cursor.createdAt && booking.id < cursor.id);
      })
      .slice(0, limit)
      .map(cloneValue);
  }

  async listPendingBookings(date: string): Promise<BookingRecord[]> {
    await this.queue;
    return Array.from(this.state.bookings.values())
      .filter((booking) => booking.date === date && booking.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(cloneValue);
  }

  async listMatrixBookings(date: string): Promise<BookingRecord[]> {
    await this.queue;
    return Array.from(this.state.bookings.values())
      .filter((booking) =>
        booking.status !== "cancelled" &&
        booking.status !== "completed" &&
        (booking.date === date ||
          (booking.proposedDate === date && booking.status === "reschedule_proposed")),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
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
      .sort(
        (a, b) =>
          (a.terminalAt ?? "").localeCompare(b.terminalAt ?? "") || a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(0, limit))
      .map(cloneValue);
  }

  async listCourts(): Promise<CourtRecord[]> {
    await this.queue;
    return Array.from(this.state.courts.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneValue);
  }

  async listSessionTemplates(): Promise<SessionTemplateRecord[]> {
    await this.queue;
    return Array.from(this.state.sessionTemplates.values())
      .sort((left, right) => left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id))
      .map(cloneValue);
  }

  async listAuditLogs(bookingId?: string): Promise<AuditLog[]> {
    await this.queue;
    return Array.from(this.state.auditLogs.values())
      .filter((audit) => !bookingId || audit.bookingId === bookingId)
      .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
      .map(cloneValue);
  }

  async listNotifications(): Promise<NotificationEvent[]> {
    await this.queue;
    return Array.from(this.state.notifications.values())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(cloneValue);
  }

  redactBooking(
    bookingId: string,
    actorId: string,
    expectedVersion: number,
    actorType: "staff" | "system" = "system",
  ): Promise<void> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const booking = next.bookings.get(bookingId);
      if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
      if (booking.version !== expectedVersion) throw new BookingError("CONFLICT");
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
        actorType,
        actorId,
        at: now,
        metadata: {},
      });
      this.state = next;
    });
  }

  async listBookingPage(filter: AdminBookingFilter): Promise<BookingPage> {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100));
    const items = await this.listBookings({ ...filter, limit: limit + 1 });
    const page = items.slice(0, limit);
    return {
      items: page,
      ...(items.length > limit && page.length > 0
        ? { nextCursor: encodeBookingCursor(page[page.length - 1]) }
        : {}),
    };
  }

  async listCustomerHistory(bookingId: string, limit: number): Promise<BookingRecord[]> {
    await this.queue;
    const selected = this.state.bookings.get(bookingId);
    if (!selected) throw new BookingError("BOOKING_NOT_FOUND");
    if (!selected.phoneHash) return [];
    return Array.from(this.state.bookings.values())
      .filter((booking) => booking.phoneHash === selected.phoneHash)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(cloneValue);
  }

  setBookingArchived(
    bookingId: string,
    archived: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<BookingRecord> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const booking = next.bookings.get(bookingId);
      if (!booking) throw new BookingError("BOOKING_NOT_FOUND");
      if (booking.version !== expectedVersion) throw new BookingError("CONFLICT");
      if (booking.status !== "cancelled" && booking.status !== "completed") {
        throw new BookingError("INVALID_TRANSITION");
      }
      if (archived === Boolean(booking.archivedAt)) throw new BookingError("CONFLICT");
      const at = new Date().toISOString();
      const updated: BookingRecord = {
        ...booking,
        ...(archived ? { archivedAt: at, archivedBy: actorId } : {}),
        updatedAt: at,
        version: booking.version + 1,
      };
      if (!archived) {
        delete updated.archivedAt;
        delete updated.archivedBy;
      }
      next.bookings.set(bookingId, updated);
      const action = archived ? "booking_archived" : "booking_restored";
      next.auditLogs.set(`${action}-${bookingId}-${updated.version}`, {
        id: `${action}-${bookingId}-${updated.version}`,
        bookingId,
        action,
        actorType: "staff",
        actorId,
        fromStatus: booking.status,
        toStatus: booking.status,
        at,
        metadata: {},
      });
      this.state = next;
      return cloneValue(updated);
    });
  }

  setCourtEnabled(
    courtId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const court = next.courts.get(courtId);
      if (!court) throw new BookingError("SESSION_NOT_FOUND");
      if (court.version !== expectedVersion) throw new BookingError("CONFLICT");
      const version = court.version + 1;
      const at = new Date().toISOString();
      next.courts.set(courtId, { ...court, enabled, version });
      this.injectFault("appendAudit");
      next.auditLogs.set(`config-court-${encodeURIComponent(courtId)}-v${version}`, {
        id: `config-court-${encodeURIComponent(courtId)}-v${version}`,
        bookingId: `court:${courtId}`,
        action: "court_enabled_changed",
        actorType: "staff",
        actorId,
        at,
        metadata: { entity: "court", id: courtId, enabled, version },
      });
      this.state = next;
    });
  }

  setSessionTemplateEnabled(
    templateId: string,
    enabled: boolean,
    actorId: string,
    expectedVersion: number,
  ): Promise<void> {
    return this.serialized(async () => {
      const next = cloneState(this.state);
      const template = next.sessionTemplates.get(templateId);
      if (!template) throw new BookingError("SESSION_NOT_FOUND");
      if (template.version !== expectedVersion) throw new BookingError("CONFLICT");
      const version = template.version + 1;
      const at = new Date().toISOString();
      next.sessionTemplates.set(templateId, {
        ...template,
        enabled,
        version,
      });
      this.injectFault("appendAudit");
      next.auditLogs.set(
        `config-session-template-${encodeURIComponent(templateId)}-v${version}`,
        {
          id: `config-session-template-${encodeURIComponent(templateId)}-v${version}`,
          bookingId: `session-template:${templateId}`,
          action: "session_template_enabled_changed",
          actorType: "staff",
          actorId,
          at,
          metadata: {
            entity: "session-template",
            id: templateId,
            enabled,
            version,
          },
        },
      );
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

  private injectFault(operation: "appendAudit" | "enqueueNotification"): void {
    if (this.faultOperation === operation && this.remainingFaults > 0) {
      this.remainingFaults -= 1;
      throw new Error(`INJECTED_FAILURE:${operation}`);
    }
  }
}
